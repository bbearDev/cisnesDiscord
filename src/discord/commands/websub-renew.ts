import { PermissionFlagsBits } from 'discord.js';

import type { Clock } from '../../runtime/clock.js';
import type { CommandContext, CommandDefinition, CommandReply, SlashCommand } from './types.js';

/**
 * `/구독갱신` — 운영자가 WebSub 구독 갱신을 지금 시도한다.
 *
 * ★★ **자동 갱신은 이미 돌고 있다.** 스윕이 5분마다 판정하고, 실패하면 백오프가
 *   2배씩 벌어진다(확정 실패 상한 1시간 / `5xx` 상한 30분).
 *   만료 뒤에도 멈추지 않는다 — 허브가 살아나면
 *   사람이 아무것도 안 해도 붙는다.
 *
 *   그래서 이 명령이 버는 것은 **백오프 상한만큼의 시간**뿐이다. 허브가 막 회복됐을 때
 *   다음 시도를 그만큼 기다리는 대신 지금 친다. *"자동이 안 되니 수동이 필요하다"*
 *   가 아니라 *"자동이 그만큼 늦다"* 이고, 이 문장이 이 파일의 존재 이유 전부다.
 *
 * ★ 실제 상황(2026-09-18): 허브(`pubsubhubbub.appspot.com`)가 20초 뒤 503 을 돌려주는
 *   상태가 며칠 이어졌다. 그동안 리스 잔여 경보가 30분마다 울렸는데 운영자가 할 수 있는
 *   일이 없었다 — 눌러도 503 이다.
 *
 * ★★ **그런데 그 503 이 실패가 아니었다** (2026-09-19). 같은 요청을 두 채널에 보내니
 *   응답은 둘 다 `503` 에 20.29초로 초 단위까지 같았는데 **한쪽은 2분 뒤 검증이 와서
 *   5일짜리 리스가 붙었다.** 허브는 오류를 돌려주고도 뒤에서 구독을 처리한다.
 *   그래서 이 명령은 허브가 "죽어 보이는" 동안에도 값을 낸다 — 누를 때마다 성사
 *   확률이 있다. 대신 **"미정" 을 "실패" 라고 적으면 안 된다.** 붙는 중인 구독을
 *   실패로 읽은 운영자는 연타하고, 그 연타가 2026-09-09 에 우리 IP 를 조이게 한
 *   경로다. 응답 문구가 셋(성공·미정·실패)으로 갈린 이유가 이것이다.
 *
 * ★ `defer: true` — 갱신 1건의 예산이 45초이고 채널마다 순차라, 3초 상호작용 창을
 *   반드시 넘긴다.
 */

export const WEBSUB_RENEW_COMMAND_NAME = '구독갱신';

/**
 * 연타 방지 간격.
 *
 * ★★ `renewNow` 는 **우리 백오프를 지운다.** 그것이 목적이지만, 지우고 나면 실패 중인
 *   채널을 막아 주는 것이 이 쿨다운뿐이다 — 연타하면 허브를 그만큼 두드린다.
 *   2026-09-09 에 우리 IP 가 구글에 조여졌던 것이 정확히 그 과다 호출 때문이었다.
 *
 * ★ 60초인 이유: 사람이 "안 되네" 하고 다시 누르는 간격보다 길고, 허브가 회복된 것을
 *   확인하고 다시 시도하기에는 짧다. 갱신 창이 2.5일이라 이 값의 정밀도는 중요하지 않다.
 */
export const WEBSUB_RENEW_COOLDOWN_MS = 60_000;

export const WEBSUB_RENEW_COMMAND: CommandDefinition = {
  name: WEBSUB_RENEW_COMMAND_NAME,
  description: '유튜브 WebSub 구독 갱신을 지금 시도합니다 (운영자 전용)',
  dm_permission: false,
  default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
};

/**
 * 갱신 포트 — `youtube/websub-client.ts` 에서 이 명령이 쓰는 만큼만.
 *
 * ★ 클라이언트 전체를 받지 않는 이유: 이 명령이 할 수 있는 일을 타입이 못 박는다.
 *   `subscribe`·`verify` 까지 들어오면 운영자 명령에서 단건 구독을 부르는 길이 열린다.
 */
export interface WebSubRenewPort {
  /** 백오프를 지우고 즉시 스윕. 결과 집계를 돌려준다 */
  renewNow(): Promise<{
    checked: number;
    renewed: number;
    /** 허브가 받았을 수도 있어 결과를 모르는 시도 — "실패" 와 다른 말이다 */
    renewPending: number;
    renewFailed: number;
    /** 갱신할 때는 됐지만 **앞선 요청 뒤 재요청 창**에 걸려 시도하지 않은 채널 수 */
    skippedCooldown: number;
    /** 그 창 중 가장 먼저 열리는 시각(epoch ms) — 남은 시간을 정확히 적기 위해 */
    skippedUntilMs?: number | undefined;
  }>;
  /** 채널별 리스 잔여 0..1 */
  leaseRatios(): { channelId: string; ratio: number }[];
}

export interface WebSubRenewCommandDeps {
  websub: WebSubRenewPort;
  clock: Clock;
  /** 채널 라벨 — 응답에 id 대신 사람이 읽는 이름을 쓴다 */
  labelFor?: (channelId: string) => string | undefined;
  onLog?: (message: string, extra?: Record<string, unknown>) => void;
}

/** 잔여 비율을 사람이 읽는 한 줄로 */
function leaseLine(channelId: string, ratio: number, label: string | undefined): string {
  const pct = Math.round(ratio * 100);
  const name = label ?? channelId;
  // ★ 0% 는 "만료됐거나 리스를 모른다" 둘 다다. 둘을 구분할 정보가 여기 없으므로
  //   숫자를 그대로 적고 해석은 덧붙이지 않는다 — 잘못 단정하면 진단이 엇나간다.
  return `· ${name} — 잔여 ${String(pct)}%`;
}

export function createWebSubRenewCommand(deps: WebSubRenewCommandDeps): SlashCommand {
  const log = (message: string, extra?: Record<string, unknown>): void => {
    try {
      deps.onLog?.(message, extra);
    } catch {
      /* 진단 로그가 명령을 죽이면 안 된다 (Principle 2) */
    }
  };

  /** 마지막 실행 시각(epoch ms). 프로세스 메모리 — 재기동하면 풀린다 */
  let lastRunAtMs: number | undefined;
  /** 이미 도는 중인가. 갱신은 채널 수 × 최대 45초라 겹칠 수 있다 */
  let running = false;

  return {
    definition: WEBSUB_RENEW_COMMAND,
    defer: true,

    async execute(ctx: CommandContext): Promise<CommandReply> {
      if (ctx.isOperator !== true) {
        return {
          ephemeral: true,
          content: '이 명령은 서버 관리 권한(`Manage Guild`)이 있는 운영자만 사용할 수 있습니다.',
        };
      }

      // ★ 겹침을 쿨다운보다 **먼저** 본다. 앞 실행이 45초 걸리는 동안 쿨다운(60초)은
      //   아직 안 지났지만, 사람에게 할 말이 "기다려 주십시오" 가 아니라 "돌고 있습니다" 다.
      if (running) {
        return { ephemeral: true, content: '이미 갱신을 시도하는 중입니다. 끝나면 결과가 나옵니다.' };
      }

      const now = deps.clock.now();
      if (lastRunAtMs !== undefined && now - lastRunAtMs < WEBSUB_RENEW_COOLDOWN_MS) {
        const waitSec = Math.ceil((WEBSUB_RENEW_COOLDOWN_MS - (now - lastRunAtMs)) / 1_000);
        return {
          ephemeral: true,
          content: `방금 시도했습니다. ${String(waitSec)}초 뒤에 다시 시도할 수 있습니다.`,
        };
      }

      running = true;
      lastRunAtMs = now;
      try {
        /**
         * ★ `Command.execute` 는 **절대 던지지 않기로** 돼 있다 (`types.ts`).
         *   `main.ts` 의 `runCommand` 가 안전망을 두지만 그건 계약 위반을 덮는 자리이지
         *   계약을 대신하는 자리가 아니다 — 여기서 잡아 사유를 사람 말로 돌려준다.
         */
        const out = await deps.websub.renewNow();
        const lines = deps.websub
          .leaseRatios()
          .map((r) => leaseLine(r.channelId, r.ratio, deps.labelFor?.(r.channelId)));

        log('구독 갱신 수동 시도', {
          by: ctx.userId,
          checked: out.checked,
          renewed: out.renewed,
          renewPending: out.renewPending,
          renewFailed: out.renewFailed,
        });

        /**
         * ★★ **"시도한 것이 없다" 와 "시도했는데 0건 성공" 은 다른 말이다.**
         *   스윕은 갱신 시점이 아직 아니거나(잔여 50% 초과) 재구독 쿨다운(202 뒤 10분)에
         *   걸리면 **시도 자체를 안 하고** `checked` 만 올린다. 그때 "성공 0건" 이라고
         *   적으면 아무 문제 없는 상태를 운영자가 실패로 읽고 다시 누른다 —
         *   이 명령의 존재 이유가 *"누르면 무엇이 됐는지 정확히 알리기"* 인데 그 반대가 된다.
         */
        const attempted = out.renewed + out.renewPending + out.renewFailed;

        /**
         * ★★ **"미정" 을 "실패" 라고 적지 않는다.** 허브는 `503` 을 돌려주면서도 뒤에서
         *   구독을 처리하고 몇 분 뒤 검증을 보낸다 (실측 2026-09-19 — 503 을 받은 요청이
         *   2분 뒤 붙었다). 그것을 "실패" 로 적으면 운영자는 **이미 붙는 중인 구독을**
         *   실패로 읽고 연타한다. 그 연타가 정확히 2026-09-09 에 우리 IP 가 구글에
         *   조여진 경로다. 미정에는 *"기다리면 된다"* 가 답이다.
         */
        /**
         * ★★ **"할 게 없었다" 와 "기다리는 중이라 안 했다" 를 가른다.**
         *   앞선 요청 뒤에는 재요청 창(10분)이 열리고, 그 안에서 누르면 시도가
         *   **0건**이 된다. 그것을 *"갱신할 구독이 없습니다"* 라고만 적으면
         *   바로 아래 `잔여 0%` 와 나란히 붙어, 운영자는 **아무도 아무것도 안 하고
         *   있다**고 읽는다.
         *
         * ★★ 다만 **"검증을 기다리는 중" 이라고 쓰면 안 된다.** 그 창은 `5xx` 뿐
         *   아니라 **무응답(timeout)에서도** 열리는데(`hubDelivery` 의 표 가운뎃줄),
         *   무응답은 요청이 닿았는지조차 모르는 상태다. 거기에 대고 검증이 올 것처럼
         *   적으면, 같은 상태를 두고 1분 전에는 *"실패했습니다"* 라 하고 지금은
         *   *"기다리는 중"* 이라 하게 된다 — 61초 사이에 서로 어긋나는 두 문장이다.
         *   창이 열렸다는 **사실만** 적고 무엇이 올지는 약속하지 않는다.
         */
        /**
         * 창이 열리기까지 남은 분. 올림이되 최소 1 — "0분 뒤" 는 지금 되는 것처럼 읽힌다.
         *
         * ★ 10분 고정으로 적으면 안 된다. 창을 연 것이 운영자의 직전 클릭이 아니라
         *   **주기 스윕**이면 `subscribed_at` 이 이미 몇 분 전이라, 3분 뒤 열릴 창을
         *   10분 기다리게 한다.
         */
        const waitMin =
          out.skippedUntilMs === undefined
            ? undefined
            : Math.max(1, Math.ceil((out.skippedUntilMs - now) / 60_000));
        const waitPhrase = waitMin === undefined ? '최대 10분' : `약 ${String(waitMin)}분`;

        const head =
          attempted === 0 && out.skippedCooldown > 0
            ? `앞선 요청 뒤 **재요청 창** 안입니다 — ${String(out.skippedCooldown)}건 / 확인 ${String(out.checked)}건 (${waitPhrase} 남음)`
            : attempted === 0
              ? `지금은 갱신할 구독이 없습니다 — 확인 ${String(out.checked)}건 (잔여가 50% 를 넘습니다)`
              : out.renewFailed === 0 && out.renewPending === 0
                ? `구독 갱신을 시도했습니다 — 성공 ${String(out.renewed)}건 / 확인 ${String(out.checked)}건`
                : out.renewFailed === 0
                  ? `구독 갱신을 요청했고 **${String(out.renewPending)}건은 결과를 기다리는 중**입니다 (성공 ${String(out.renewed)}건 / 확인 ${String(out.checked)}건)`
                  : `구독 갱신을 시도했지만 **${String(out.renewFailed)}건이 실패**했습니다 (미정 ${String(out.renewPending)}건 / 성공 ${String(out.renewed)}건 / 확인 ${String(out.checked)}건)`;

        /**
         * ★ `attempted > 0` 이어도 붙인다. 채널이 여럿이면 한쪽은 시도되고 한쪽은
         *   창에 걸릴 수 있는데, head 만 보면 걸린 쪽이 **문장에서 통째로 사라진다.**
         *
         * ★ **나갈 때(10분)를 반드시 적는다.** "아직 누를 때가 아니다" 만 적고 언제까지인지
         *   안 적으면 운영자는 60초 쿨다운마다 열 번을 누른다.
         */
        const skippedTail =
          out.skippedCooldown === 0
            ? []
            : [
                '',
                // ★ "닿았을 수 있어" 라고만 쓰면 202(확실히 닿음)에서 약한 표현이 된다.
                //   셋(202·5xx·무응답) 모두에 맞는 말은 "처리 중일 수 있어" 다.
                `앞선 요청을 허브가 처리 중일 수 있어 **재요청을 막습니다** (${String(out.skippedCooldown)}건).`,
                `그 사이 검증이 도착하면 저절로 완료됩니다 — ${waitPhrase} 뒤에 다시 눌러 확인해 주십시오.`,
              ];

        const pendingTail =
          out.renewPending === 0
            ? []
            : [
                '',
                '허브가 접수 여부를 알려주지 않았습니다. **실패가 아닙니다** —',
                '허브는 오류를 돌려주고도 뒤에서 구독을 처리하는 일이 있고, 그때는',
                '몇 분 안에 검증이 도착해 **저절로 완료**됩니다. 다시 누르지 마시고',
                '`/구독갱신` 으로 잔여가 올라갔는지 10분쯤 뒤에 확인해 주십시오.',
              ];

        const failTail =
          out.renewFailed === 0
            ? []
            : [
                '',
                '실패가 이어지면 **허브(`pubsubhubbub.appspot.com`) 쪽 장애**일 수 있습니다.',
                '그때는 눌러도 같은 결과이고, 자동 재시도가 계속 돕니다 —',
                '허브가 회복되면 사람이 누르지 않아도 붙습니다.',
              ];

        const tail = [...skippedTail, ...pendingTail, ...failTail];

        return {
          ephemeral: true,
          content: [head, ...(lines.length === 0 ? [] : ['', ...lines]), ...tail].join('\n'),
        };
      } catch (e: unknown) {
        const detail = e instanceof Error ? e.message : String(e);
        log('구독 갱신 수동 시도 실패', { by: ctx.userId, detail });
        return {
          ephemeral: true,
          content: [
            '구독 갱신을 시도하다 오류가 났습니다.',
            '자동 재시도는 계속 돌고 있습니다 — 잠시 후 다시 시도해 주십시오.',
            `사유: ${detail.slice(0, 200)}`,
          ].join('\n'),
        };
      } finally {
        // ★ `finally` 로 푼다. 예외가 나면 플래그가 켜진 채 남아 **명령이 영구히 잠긴다** —
        //   아웃박스 재진입 가드(`runtime/outbox.ts`)가 같은 이유로 같은 형태를 쓴다.
        running = false;
      }
    },
  };
}
