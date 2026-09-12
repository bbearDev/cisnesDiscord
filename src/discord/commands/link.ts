import { ButtonStyle, ComponentType } from 'discord.js';

import type { Clock } from '../../runtime/clock.js';
import type { LinkRepo } from '../../store/repos/link-repo.js';
import { applyGate, type GateGateway } from '../gate.js';
import {
  alreadyLinkedMessage,
  busyMessage,
  cooldownMessage,
  gateFailedMessage,
  roleRegrantedMessage,
} from '../messages.js';
import type { AuthGuard } from './guard.js';
import type { Command, CommandContext, CommandReply } from './types.js';

/**
 * `인증` — 치지직 계정 연동 시작 (AC-2 · AC-12). 게이트 채널 패널의 **[치지직 계정 인증]**
 * 버튼이 이 명령을 부른다 (`discord/panel.ts`). 슬래시 명령이 아니다.
 *
 * ★★ **이 명령은 상류를 부르지 않는다.** 여기서 하는 것은 `state` 발급과 링크 안내뿐이고,
 *   토큰 교환·`users/me`·팔로워 조회는 전부 콜백에서 **한 번씩** 일어난다.
 *   그래서 같은 사람이 버튼을 네 번 눌러도 상류 호출은 **0회**다.
 *
 * ★ **판정 순서가 곧 AC-12 다. 이 순서를 바꾸지 않는다.**
 *
 *   1. 이미 연동됨      → 안내만. state 를 새로 만들지 않는다        (AC-12 a)
 *                         ★ 단, **역할이 없으면 역할만 다시 붙인다** (아래)
 *   2. 진행 중인 state  → **같은 링크를 재제시**한다                  (AC-12 b)
 *   3. 진입 리밋        → 쿨다운·동시 상한                            (§5.6.2)
 *   4. 발급
 *
 *   2번이 3번보다 **위**인 것이 요점이다. 아래로 내리면 링크를 받고 브라우저를
 *   여는 사이에 다시 누른 사람이 **쿨다운 오류를 보고 방금 받은 링크도 잃는다** —
 *   그때 그 사람이 할 수 있는 일이 30초 기다리기밖에 없어진다.
 *
 * ★★ **1번의 "역할만 다시 붙인다"** — 콜백의 `grant()` 는 연동 행을 역할 부여 **전에** 쓴다.
 *   그래서 봇 역할이 대상 역할보다 아래여서 403 이 나면 *연동됨 + 역할 없음* 상태가 남는데,
 *   여기서 "이미 연동됨" 으로만 끝내면 그 사람은 운영자가 `/연동해제` 하고 OAuth 를
 *   처음부터 다시 타는 것 말고는 빠져나올 길이 없다. 그래서 역할이 없을 때만 게이트를
 *   다시 적용한다 — `cache.has` 가 `true` 면 REST 0회(AC-12 c), 아니면 쿨다운 안에서 1회.
 *   닉네임은 건드리지 않는다(가정 6 — 재동기화 잡을 만들지 않는다).
 *
 * ★ 링크는 본문이 아니라 **Link 버튼**에 싣는다. 본문 URL 은 디스코드 크롤러가 미리보기를
 *   만들려고 직접 가져가는데(`Discordbot/2.0`), 그것이 `/oauth/start` 를 열면 nonce 가
 *   회전돼 사용자의 쿠키가 무효가 된다 (2026-09-08 실배포 관측). 버튼 URL 은 크롤링 대상이 아니다.
 *
 * ★ URL 은 우리 `/oauth/start` 를 가리킨다. 치지직 인가 페이지로 바로 보내지 않는 이유:
 *   **브라우저에 nonce 쿠키를 심을 자리가 거기밖에 없다** (AC-3 그물 B, `web/session.ts`).
 */

/** 답장에 실리는 Link 버튼 라벨 */
export const LINK_BUTTON_LABEL = '치지직에서 인증 진행';

/**
 * 역할 재부여 REST 한 번의 상한.
 *
 * ★ `@discordjs/rest` 의 기본은 15초 타임아웃에 429 를 잠들며 기다리는 것이라, 그대로 두면
 *   상류가 느린 날 사람이 그만큼 기다리고 쿨다운은 소모된다. 여기서 끊으면 `timeout` 실패로
 *   접혀 `gateFailedMessage` 가 나간다.
 *
 * ★ 이 값이 3초 응답 창 안이라고 **안심하면 안 된다** — 그 뒤에 답장 왕복이 한 번 더 있다.
 *   그래서 이 명령은 `defer: true` 다 (아래). 창은 15분이 되고, 이 상한은 "사람을 얼마나
 *   기다리게 할 것인가" 만 정한다.
 */
export const REGRANT_TIMEOUT_MS = 2_500;

/**
 * 세션 저장소 중 이 명령이 쓰는 만큼.
 *
 * ★ `web/session.ts` 의 `VerificationSessionStore` 를 **import 하지 않는다.**
 *   `discord`(L7)는 `web`(L8)보다 아래라 레이어 규칙이 그 import 를 막는다.
 *   구조적 타이핑이라 조립부가 실제 저장소를 그대로 꽂으면 맞는다 —
 *   경계를 지키면서 배선이 늘지 않는 유일한 모양이다.
 */
export interface LinkSessionPort {
  issue(discordUserId: string): { state: string; expiresAt: number };
  findPending(
    discordUserId: string,
  ): { state: string; expiresAt: number } | undefined;
  pendingCount(): number;
}

export interface LinkCommandDeps {
  sessions: LinkSessionPort;
  links: LinkRepo;
  guard: AuthGuard;
  clock: Clock;
  /** `web.publicBaseUrl`. 프록시가 종단하는 공개 https 주소 */
  publicBaseUrl: string;
  /** 역할 재부여(1번 ★★)에 쓴다. 콜백과 **같은** 게이트웨이다 */
  gateway: GateGateway;
  /** `guild_config.verified_role_id`. 없으면 재부여를 시도하지 않는다 */
  resolveVerifiedRoleId: (guildId: string) => string | undefined;
  /** 재부여 REST 상한. 기본 `REGRANT_TIMEOUT_MS` */
  regrantTimeoutMs?: number;
  /** 진단 로그. 던지면 안 된다 */
  onLog?: (message: string, extra?: Record<string, unknown>) => void;
}

/** `/oauth/start?s=<state>` — nonce 는 여기 실리지 않는다 (해시만 저장하므로) */
export function buildStartUrl(publicBaseUrl: string, state: string): string {
  const url = new URL('/oauth/start', publicBaseUrl);
  url.searchParams.set('s', state);
  return url.toString();
}

function startReply(
  url: string,
  expiresAt: number,
  now: number,
  resumed: boolean,
): CommandReply {
  const minutes = Math.max(1, Math.round((expiresAt - now) / 60_000));
  return {
    ephemeral: true,
    content: [
      resumed
        ? '이미 시작하신 인증이 있습니다. **같은 링크**로 이어서 진행해 주십시오.'
        : '치지직 계정 연동을 시작합니다.',
      `아래 버튼을 눌러 치지직 로그인·동의를 진행해 주십시오 (약 ${String(minutes)}분간 유효).`,
      '동의가 끝나면 자동으로 돌아와 팔로워 확인 후 역할이 부여됩니다.',
      '',
      '※ 이 버튼의 링크는 **본인 전용**입니다. 다른 사람에게 전달하지 마십시오.',
    ].join('\n'),
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          { type: ComponentType.Button, style: ButtonStyle.Link, label: LINK_BUTTON_LABEL, url },
        ],
      },
    ],
  };
}

export function createLinkCommand(deps: LinkCommandDeps): Command {
  const log = (message: string, extra?: Record<string, unknown>): void => {
    try {
      deps.onLog?.(message, extra);
    } catch {
      /* 진단 로그가 명령을 죽이면 안 된다 (Principle 2) */
    }
  };

  /**
   * 이미 연동된 사람 — 역할이 있으면 안내만, 없으면 역할만 다시 붙인다 (머리말 ★★).
   */
  async function alreadyLinked(ctx: CommandContext, channelName: string): Promise<CommandReply> {
    const roleId = deps.resolveVerifiedRoleId(ctx.guildId);
    const held = roleId === undefined ? undefined : deps.gateway.hasRole?.(ctx.guildId, ctx.userId, roleId);
    if (roleId === undefined || held === true) {
      return { ephemeral: true, content: alreadyLinkedMessage(channelName) };
    }

    // ★ 재부여도 쿨다운 안에 둔다. 403 이 나는 상태에서 버튼 연타가 곧 REST 연타가 되면 안 된다.
    //   동시 상한(`pendingInGuild`)은 걸지 않는다 — 재부여는 세션을 만들지도 상류를 부르지도 않으므로
    //   그 상한이 막으려는 팬아웃과 무관하다. 0 을 넘겨 쿨다운만 판정하게 한다.
    const entry = deps.guard.tryEnter({ guildId: ctx.guildId, userId: ctx.userId, pendingInGuild: 0 });
    if (!entry.ok) {
      log('역할 재부여 진입 거절', { reason: entry.reason });
      return {
        ephemeral: true,
        content: entry.reason === 'cooldown' ? cooldownMessage(entry.retryAfterSec) : busyMessage(),
      };
    }

    // ★ 3초 응답 창 안에서 끝나게 REST 를 끊는다 (`REGRANT_TIMEOUT_MS`). `finally` 로 타이머를 반드시 걷는다.
    const ac = new AbortController();
    const timer = setTimeout(() => {
      ac.abort();
    }, deps.regrantTimeoutMs ?? REGRANT_TIMEOUT_MS);
    let gate;
    try {
      gate = await applyGate(
        deps.gateway,
        { guildId: ctx.guildId, userId: ctx.userId, roleId },
        { signal: ac.signal },
      );
    } finally {
      clearTimeout(timer);
    }
    for (const f of gate.failures) {
      log('역할 재부여 실패', { part: f.part, kind: f.kind, detail: f.detail });
    }
    if (!gate.verified) return { ephemeral: true, content: gateFailedMessage(gate) };

    log('역할 재부여', { guildId: ctx.guildId, userId: ctx.userId, cacheKnewMissing: held === false });
    // ★ 캐시가 "없다" 고 했을 때만 "빠져 있던 역할" 이다. 모르는 상태(`undefined`)에서 부여한 것은
    //   이미 갖고 있었을 수도 있는 멱등 호출이라 그렇게 말하지 않는다.
    return { ephemeral: true, content: roleRegrantedMessage(channelName, held === false) };
  }

  return {
    /**
     * ★ 응답 전에 디스코드 REST 를 부를 수 있다(1번의 역할 재부여). `Command.defer` 계약대로
     *   `true` — 조립부가 먼저 "생각 중" 을 보내 3초 창을 15분으로 늘린다. 링크 발급 경로는
     *   DB 만 만지지만, 한 명령이 두 얼굴을 가질 수는 없다 — 어느 경로로 갈지는 실행해 봐야
     *   안다. 비용은 클릭당 REST 1회(defer)이고, 버튼은 사람이 누르는 속도로만 온다.
     */
    defer: true,

    async execute(ctx: CommandContext): Promise<CommandReply> {
      const now = deps.clock.now();

      // ── 1. 이미 연동됨 (AC-12 a) ────────────────────────────────
      const existing = deps.links.get(ctx.guildId, ctx.userId);
      if (existing !== undefined) {
        return alreadyLinked(ctx, existing.chzzkChannelName);
      }

      // ── 2. 진행 중인 흐름 → 같은 링크 재제시 (AC-12 b) ──────────
      const pending = deps.sessions.findPending(ctx.userId);
      if (pending !== undefined) {
        return startReply(
          buildStartUrl(deps.publicBaseUrl, pending.state),
          pending.expiresAt,
          now,
          true,
        );
      }

      // ── 3. 진입 리밋 (§5.6.2) ───────────────────────────────────
      const entry = deps.guard.tryEnter({
        guildId: ctx.guildId,
        userId: ctx.userId,
        pendingInGuild: deps.sessions.pendingCount(),
      });
      if (!entry.ok) {
        log('인증 진입 거절', { reason: entry.reason });
        return {
          ephemeral: true,
          content:
            entry.reason === 'cooldown' ? cooldownMessage(entry.retryAfterSec) : busyMessage(),
        };
      }

      // ── 4. 발급 ────────────────────────────────────────────────
      const issued = deps.sessions.issue(ctx.userId);
      return startReply(buildStartUrl(deps.publicBaseUrl, issued.state), issued.expiresAt, now, false);
    },
  };
}
