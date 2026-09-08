import type { Clock } from '../../runtime/clock.js';
import type { LinkRepo } from '../../store/repos/link-repo.js';
import { alreadyLinkedMessage, busyMessage, cooldownMessage } from '../messages.js';
import type { AuthGuard } from './guard.js';
import type { CommandContext, CommandDefinition, CommandReply, SlashCommand } from './types.js';

/**
 * `/인증` — 치지직 계정 연동 시작 (AC-2 · AC-12).
 *
 * ★★ **이 명령은 상류를 부르지 않는다.** 여기서 하는 것은 `state` 발급과 URL 안내뿐이고,
 *   토큰 교환·`users/me`·팔로워 조회는 전부 콜백에서 **한 번씩** 일어난다.
 *   그래서 같은 사람이 `/인증` 을 네 번 눌러도 상류 호출은 **0회**다.
 *
 * ★ **판정 순서가 곧 AC-12 다. 이 순서를 바꾸지 않는다.**
 *
 *   1. 이미 연동됨      → 안내만. state 를 새로 만들지 않는다        (AC-12 a)
 *   2. 진행 중인 state  → **같은 URL 을 재제시**한다                 (AC-12 b)
 *   3. 진입 리밋        → 쿨다운·동시 상한                            (§5.6.2)
 *   4. 발급
 *
 *   2번이 3번보다 **위**인 것이 요점이다. 아래로 내리면 URL 을 받고 브라우저를
 *   여는 사이에 다시 누른 사람이 **쿨다운 오류를 보고 방금 받은 URL 도 잃는다** —
 *   그때 그 사람이 할 수 있는 일이 30초 기다리기밖에 없어진다.
 *
 * ★ URL 은 우리 `/oauth/start` 를 가리킨다. 치지직 인가 페이지로 바로 보내지 않는 이유:
 *   **브라우저에 nonce 쿠키를 심을 자리가 거기밖에 없다** (AC-3 그물 B, `web/session.ts`).
 */

export const LINK_COMMAND_NAME = '인증';

export const LINK_COMMAND: CommandDefinition = {
  name: LINK_COMMAND_NAME,
  description: '치지직 계정을 연동하고 팔로워 인증을 받습니다',
  dm_permission: false,
};

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
      '',
      `1. 아래 링크를 눌러 치지직 로그인·동의를 진행해 주십시오 (약 ${String(minutes)}분간 유효).`,
      // ★★ `<>` 로 감싼다 — 디스코드가 **미리보기를 만들려고 링크를 직접 가져가는 것**을 막는다.
      //   `Discordbot/2.0` 이 `/oauth/start` 를 크롤링하면 `attachNonce` 가 nonce 를
      //   **회전**시키고(session.ts), 그 새 쿠키는 크롤러에게 간다. 사용자가 치지직
      //   동의 화면에 머무는 사이에 크롤러가 도착하면 사용자의 쿠키가 서버 해시와
      //   어긋나 **콜백이 state 검증에서 거부**된다. 실배포 로그에서 크롤러가 사용자
      //   클릭 3초 뒤에 도착하는 것을 관측했다 (2026-09-08).
      `<${url}>`,
      '2. 동의가 끝나면 자동으로 돌아와 팔로워 확인 후 역할이 부여됩니다.',
      '',
      '※ 이 링크는 **본인 전용**입니다. 다른 사람에게 전달하지 마십시오.',
    ].join('\n'),
  };
}

export function createLinkCommand(deps: LinkCommandDeps): SlashCommand {
  const log = (message: string, extra?: Record<string, unknown>): void => {
    try {
      deps.onLog?.(message, extra);
    } catch {
      /* 진단 로그가 명령을 죽이면 안 된다 (Principle 2) */
    }
  };

  return {
    definition: LINK_COMMAND,

    execute(ctx: CommandContext): Promise<CommandReply> {
      const now = deps.clock.now();

      // ── 1. 이미 연동됨 (AC-12 a) ────────────────────────────────
      const existing = deps.links.get(ctx.guildId, ctx.userId);
      if (existing !== undefined) {
        return Promise.resolve({
          ephemeral: true,
          content: alreadyLinkedMessage(existing.chzzkChannelName),
        });
      }

      // ── 2. 진행 중인 흐름 → 같은 URL 재제시 (AC-12 b) ───────────
      const pending = deps.sessions.findPending(ctx.userId);
      if (pending !== undefined) {
        return Promise.resolve(
          startReply(
            buildStartUrl(deps.publicBaseUrl, pending.state),
            pending.expiresAt,
            now,
            true,
          ),
        );
      }

      // ── 3. 진입 리밋 (§5.6.2) ───────────────────────────────────
      const entry = deps.guard.tryEnter({
        guildId: ctx.guildId,
        userId: ctx.userId,
        pendingInGuild: deps.sessions.pendingCount(),
      });
      if (!entry.ok) {
        log('/인증 진입 거절', { reason: entry.reason });
        return Promise.resolve({
          ephemeral: true,
          content:
            entry.reason === 'cooldown' ? cooldownMessage(entry.retryAfterSec) : busyMessage(),
        });
      }

      // ── 4. 발급 ────────────────────────────────────────────────
      const issued = deps.sessions.issue(ctx.userId);
      return Promise.resolve(
        startReply(buildStartUrl(deps.publicBaseUrl, issued.state), issued.expiresAt, now, false),
      );
    },
  };
}
