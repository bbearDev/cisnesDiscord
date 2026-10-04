import { PermissionFlagsBits } from 'discord.js';

import { parseZonedIso, type FollowerSyncClient, type FollowerSyncResult } from '../../chzzk/follower-check.js';
import { formatKst } from '../messages.js';
import type { CommandContext, CommandDefinition, CommandReply, SlashCommand } from './types.js';

/**
 * `/팔로우갱신` — 운영자가 상류(chzzkbot)에 우리 채널의 팔로워 목록을 **지금** 다시 받게 한다.
 *
 * ★★ 상류의 주기 동기화는 이미 돈다(전수 60분 + 채널별 지터 + `followerCacheMin`).
 *   그래서 방금 팔로우한 멤버는 최대 두 시간 가까이 `no` 를 받는다(런북 §8-c).
 *   이 명령이 버는 것은 **그 대기 시간**뿐이다 — 운영자가 "방금 팔로우했다" 는 말을 듣고
 *   눌러 주면 그 멤버가 바로 다시 인증할 수 있다.
 *
 * ★ 우리 쪽 쿨다운은 **두지 않는다.** 상류가 채널별 60초 쿨다운을 걸고, 겹친 요청은
 *   상류가 하나로 합친다. 같은 규칙을 두 곳에 두면 두 값이 어긋나는 날 운영자가 받는
 *   문장이 둘이 된다. 상류의 429 를 그대로 사람 말로 옮긴다.
 *
 * ★ 우리 쪽에 무효화할 판정 캐시가 없다 — 이유는 `createFollowerSyncClient` 머리말.
 *
 * ★★ **"확인 못 함" 을 "실패" 라고 적지 않는다.** 타임아웃은 우리 대기가 끊긴 것이지
 *   상류 동기화가 멈춘 것이 아니다. 실패로 적으면 운영자는 연타하고, 연타는 상류
 *   쿨다운에 걸릴 뿐이다 — `/구독갱신` 이 같은 이유로 성공·미정·실패를 가른다.
 *
 * ★ `defer: true` — 상류는 전수가 끝난 뒤에 답한다(회당 타임아웃 60초).
 *
 * ★ 상류에 동기화 경로(`createFollowerSyncClient` 머리말)가 있는 판이 먼저 배포돼 있어야
 *   한다. 옛 판은 404·405 로 답하고, 명령은 그것을 "업데이트 필요" 로 적는다.
 *   ★ 경로 문자열을 이 파일에 적지 않는다 — `no-direct-follower-api.test.ts` 가 그 경로를
 *   만드는 파일을 `follower-check.ts` 하나로 못 박는다.
 */

export const FOLLOW_REFRESH_COMMAND_NAME = '팔로우갱신';

export const FOLLOW_REFRESH_COMMAND: CommandDefinition = {
  name: FOLLOW_REFRESH_COMMAND_NAME,
  description: '치지직 팔로워 목록을 지금 다시 받아옵니다 — 방금 팔로우한 멤버용 (운영자 전용)',
  dm_permission: false,
  default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
};

/** 동기화 포트 — 이 명령이 쓰는 만큼만 */
export type FollowerSyncPort = Pick<FollowerSyncClient, 'requestSync'>;

export interface FollowRefreshCommandDeps {
  followers: FollowerSyncPort;
  onLog?: (message: string, extra?: Record<string, unknown>) => void;
}

/** 상류 시각 원문을 KST 로. 시간대가 없거나 못 읽으면 원문 그대로 — 지어내지 않는다 */
function kstOrRaw(raw: string): string {
  const ms = parseZonedIso(raw);
  return ms === undefined ? raw : formatKst(ms);
}

function replyFor(r: FollowerSyncResult): string {
  switch (r.outcome) {
    case 'synced':
      return [
        `팔로워 목록을 다시 받았습니다 — **${String(r.count)}명**`,
        `· 목록 기준 시각: ${kstOrRaw(r.cachedAt)}`,
        `· 걸린 시간: ${(r.durationMs / 1_000).toFixed(1)}초`,
        '',
        '방금 팔로우한 멤버는 이제 **인증을 다시 시도**하면 됩니다.',
        // ★ 합류한 전수는 그 멤버의 팔로우보다 먼저 시작됐을 수 있다. 합류는 상류 쿨다운을
        //   쓰지 않으므로 다시 누르는 것이 답이다 — 그 사실을 같이 적는다.
        ...(r.joined === true
          ? [
              '진행 중이던 동기화에 합류했습니다 — 방금 팔로우한 멤버가 아직 안 보이면 한 번 더 눌러 주십시오 (쿨다운이 걸리지 않습니다).',
            ]
          : []),
      ].join('\n');
    case 'cooldown':
      return [
        r.retryAfterSec === undefined
          ? '방금 갱신됐습니다. 잠시 뒤에 다시 시도해 주십시오.'
          : `방금 갱신됐습니다. ${String(r.retryAfterSec)}초 뒤에 다시 시도할 수 있습니다.`,
        ...(r.cachedAt === undefined ? [] : [`· 지금 목록 기준 시각: ${kstOrRaw(r.cachedAt)}`]),
      ].join('\n');
    case 'sync-failed':
      return [
        '상류(chzzkbot)가 치지직에서 팔로워 목록을 받지 못했습니다.',
        '기존 목록은 그대로 유지됩니다 — 인증은 그 목록으로 계속 됩니다.',
        ...(r.lastError === undefined ? [] : [`· 상류 사유: ${r.lastError.slice(0, 200)}`]),
      ].join('\n');
    case 'unauthorized':
      return [
        '상류(chzzkbot)가 요청을 거부했습니다 — **토큰 불일치**입니다.',
        '양쪽의 `LIVE_API_TOKEN` 이 같은지 운영 설정을 확인해 주십시오.',
      ].join('\n');
    case 'unsupported':
      return [
        `상류(chzzkbot)가 이 요청을 받지 않았습니다 (HTTP ${String(r.status)}).`,
        '상류에서 팔로워 API 가 꺼져 있거나, chzzkbot 이 **아직 이 기능을 모르는 버전**입니다 — 둘은 응답으로 구분되지 않습니다.',
        'chzzkbot 을 팔로워 동기화(`POST …/sync`)를 지원하는 판으로 업데이트해 주십시오.',
      ].join('\n');
    case 'channel-not-found':
      return [
        '상류(chzzkbot)에 우리 치지직 채널이 등록돼 있지 않습니다.',
        'chzzkbot 설정의 채널 목록과 `live.channelId` 가 같은지 확인해 주십시오.',
      ].join('\n');
    case 'unreachable':
      // ★ 닿지 않았으면 동기화도 시작되지 않았다 — "진행 중일 수 있다" 고 쓰지 않는다.
      return [
        `상류(chzzkbot)에 **닿지 못했습니다** — ${r.detail.slice(0, 100)}`,
        'chzzkbot 이 떠 있는지 확인해 주십시오 (런북 §4-6). 그동안 인증은 `unknown` 으로 보류됩니다.',
      ].join('\n');
    case 'unconfirmed':
      return [
        `결과를 **확인하지 못했습니다** — ${r.detail}.`,
        '실패했다는 뜻이 아닙니다. 상류 동기화는 계속 진행 중일 수 있습니다 —',
        '1분쯤 뒤 `/팔로우` 로 스냅샷 시각이 바뀌었는지 확인해 주십시오.',
      ].join('\n');
  }
}

export function createFollowRefreshCommand(deps: FollowRefreshCommandDeps): SlashCommand {
  const log = (message: string, extra?: Record<string, unknown>): void => {
    try {
      deps.onLog?.(message, extra);
    } catch {
      /* 진단 로그가 명령을 죽이면 안 된다 (Principle 2) */
    }
  };

  return {
    definition: FOLLOW_REFRESH_COMMAND,
    defer: true,

    async execute(ctx: CommandContext): Promise<CommandReply> {
      if (ctx.isOperator !== true) {
        return {
          ephemeral: true,
          content: '이 명령은 서버 관리 권한(`Manage Guild`)이 있는 운영자만 사용할 수 있습니다.',
        };
      }

      try {
        /**
         * ★ `Command.execute` 는 **절대 던지지 않기로** 돼 있다 (`types.ts`). 클라이언트도
         *   던지지 않기로 돼 있지만 계약을 겹으로 지킨다 — `follow-days.ts` 와 같은 자리.
         */
        const r = await deps.followers.requestSync();
        // ★ 한 줄. 토큰은 결과에 없으므로 실릴 길이 없다.
        log('팔로워 목록 수동 갱신', {
          by: ctx.userId,
          outcome: r.outcome,
          ...(r.outcome === 'synced'
            ? { count: r.count, durationMs: r.durationMs, ...(r.joined === true ? { joined: true } : {}) }
            : {}),
          ...(r.outcome === 'unsupported' ? { status: r.status } : {}),
          ...(r.outcome === 'unconfirmed' || r.outcome === 'unreachable' ? { detail: r.detail } : {}),
          ...(r.outcome === 'cooldown' && r.retryAfterSec !== undefined ? { retryAfterSec: r.retryAfterSec } : {}),
        });
        return { ephemeral: true, content: replyFor(r) };
      } catch (e: unknown) {
        const detail = e instanceof Error ? e.message : String(e);
        log('팔로워 목록 수동 갱신 실패', { by: ctx.userId, detail });
        return {
          ephemeral: true,
          content: [
            '팔로워 목록 갱신을 요청하다 오류가 났습니다. 잠시 후 다시 시도해 주십시오.',
            `사유: ${detail.slice(0, 200)}`,
          ].join('\n'),
        };
      }
    },
  };
}
