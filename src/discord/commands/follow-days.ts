import { PermissionFlagsBits } from 'discord.js';

import type { FollowerChecker, FollowerLookup } from '../../chzzk/follower-check.js';
import type { Clock } from '../../runtime/clock.js';
import type { LinkRepo } from '../../store/repos/link-repo.js';
import { formatKst, snapshotLine, unknownReasonDetail } from '../messages.js';
import type { CommandContext, CommandDefinition, CommandReply, SlashCommand } from './types.js';
import { OPTION_TYPE_USER } from './types.js';

/**
 * `/팔로우 대상:@멤버` — 운영자가 한 멤버의 **팔로우 일수**를 본다.
 *
 * ★ 두 단계다. ① `account_links` 에서 그 디스코드 계정의 치지직 채널을 찾고,
 *   ② 상류(chzzkbot)에 그 채널이 팔로워인지 **한 번** 묻는다. 상류 응답의
 *   `followedAt`(팔로우 시작 시각)으로 일수를 센다. 연동이 없으면 치지직 채널을
 *   모르므로 ② 로 갈 수 없다 — 그 사실을 그대로 말한다.
 *
 * ★★ **`/연동상태` 와 다른 명령이다.** 그쪽은 DB 만 본다(연동 시각). 이쪽은 상류에
 *   묻는다(팔로우 시각). "연동한 지 며칠" 과 "팔로우한 지 며칠" 은 다른 숫자이고,
 *   운영자가 알고 싶은 것은 뒤의 것이다 — 인증 전부터 팔로우한 사람이 대부분이다.
 *
 * ★ 판정은 `follower-check.ts` 의 3상태 그대로다. `unknown` 을 *"팔로우하지
 *   않았다"* 로 적지 않는다 — 게이트가 지키는 문장을 운영자 명령이 깨면 운영자가
 *   그 오해로 사람을 내보낸다.
 *
 * ★ 일수는 **KST 날짜 경계**로 세고 오늘이 1일째다 — 상류 `!팔로우` 와 같은 규칙이다.
 *   두 창구가 같은 사람에게 다른 숫자를 답하면 어느 쪽도 못 믿게 된다.
 *
 * ★ `defer: true` — 상류 조회 회당 타임아웃이 3초라 상호작용 창(3초)을 넘길 수 있다.
 */

export const FOLLOW_DAYS_COMMAND_NAME = '팔로우';

export const FOLLOW_DAYS_COMMAND: CommandDefinition = {
  name: FOLLOW_DAYS_COMMAND_NAME,
  description: '멤버가 치지직 채널을 팔로우한 지 며칠인지 확인합니다 (운영자 전용)',
  dm_permission: false,
  default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
  options: [
    {
      type: OPTION_TYPE_USER,
      // ★ `/연동상태`·`/연동해제` 와 같은 이름이어야 한다 — 조립부(`interactions.ts`)가
      //   `TARGET_OPTION_NAME` 하나로 대상을 뽑는다.
      name: '대상',
      description: '조회할 멤버',
      required: true,
    },
  ],
};

/** 상류 조회 포트 — 판정기 중 이 명령이 쓰는 만큼만. `check` 가 들어오면 재조회 예약 경로가 열린다 */
export type FollowerInspectPort = Pick<FollowerChecker, 'inspect'>;

export interface FollowDaysCommandDeps {
  links: LinkRepo;
  followers: FollowerInspectPort;
  clock: Clock;
  onLog?: (message: string, extra?: Record<string, unknown>) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MIN = 9 * 60;

/**
 * 팔로우 시작 시각부터 오늘까지의 **일수** — 오늘 팔로우했으면 1.
 *
 * ★ 밀리초 차이를 나누지 않고 **KST 날짜 경계**로 센다. 나누면 오늘 팔로우한
 *   사람이 "0일" 이 되는데 사람은 그걸 "1일째" 로 읽는다. 상류 `!팔로우` 의
 *   `followDays` 와 같은 규칙이라 두 창구의 답이 같다.
 *
 * ★ 미래 시각(시계 어긋남)은 1 로 접는다 — 음수 일수를 답하면 안 된다.
 */
export function followDays(followedAtIso: string, now: number): number | undefined {
  const at = Date.parse(followedAtIso);
  if (!Number.isFinite(at)) return undefined;
  const dayOf = (ms: number): number => Math.floor((ms + KST_OFFSET_MIN * 60_000) / DAY_MS);
  const days = dayOf(now) - dayOf(at);
  return days < 0 ? 1 : days + 1;
}

/** 판정 한 줄. **어느 갈래도 `unknown` 을 "미팔로우" 라고 적지 않는다** */
function verdictLine(lookup: FollowerLookup, now: number): string {
  switch (lookup.verdict) {
    case 'yes': {
      if (lookup.followedAt === undefined) {
        // 팔로우 중인 것은 사실이다. 그것만 적고 모르는 것은 모른다고 한다.
        return '· 팔로우: **팔로우 중** — 시작일은 확인하지 못했습니다 (상류가 일자를 주지 않았습니다)';
      }
      const days = followDays(lookup.followedAt, now);
      const since = formatKst(Date.parse(lookup.followedAt));
      return days === undefined
        ? `· 팔로우: **팔로우 중** — 시작일은 확인하지 못했습니다`
        : `· 팔로우: **${String(days)}일째** (${since} 부터)`;
    }
    case 'no':
      return '· 팔로우: 팔로워로 확인되지 않았습니다';
    case 'unknown':
      return `· 팔로우: **확인하지 못했습니다** — ${unknownReasonDetail(lookup)} (팔로우하지 않았다는 뜻이 아닙니다)`;
  }
}

export function createFollowDaysCommand(deps: FollowDaysCommandDeps): SlashCommand {
  const log = (message: string, extra?: Record<string, unknown>): void => {
    try {
      deps.onLog?.(message, extra);
    } catch {
      /* 진단 로그가 명령을 죽이면 안 된다 (Principle 2) */
    }
  };

  return {
    definition: FOLLOW_DAYS_COMMAND,
    defer: true,

    async execute(ctx: CommandContext): Promise<CommandReply> {
      if (ctx.isOperator !== true) {
        return {
          ephemeral: true,
          content: '이 명령은 서버 관리 권한(`Manage Guild`)이 있는 운영자만 사용할 수 있습니다.',
        };
      }

      // 옵션이 `required` 라 디스코드가 막지만, 표시 제어처럼 이쪽도 우리가 한 번 더 본다.
      const subject = ctx.targetUserId;
      if (subject === undefined) {
        return { ephemeral: true, content: '조회할 멤버를 `대상` 옵션으로 지정해 주십시오.' };
      }

      const link = deps.links.get(ctx.guildId, subject);
      if (link === undefined) {
        return {
          ephemeral: true,
          content: [
            `<@${subject}> 은(는) 아직 연동돼 있지 않습니다.`,
            '치지직 채널을 알 수 없어 팔로우 일수를 확인할 수 없습니다 — 인증을 마친 뒤 다시 조회해 주십시오.',
          ].join('\n'),
        };
      }

      const now = deps.clock.now();
      try {
        /**
         * ★ `Command.execute` 는 **절대 던지지 않기로** 돼 있다 (`types.ts`). 판정기도
         *   던지지 않기로 돼 있지만 계약을 겹으로 지킨다 — `websub-renew.ts` 와 같은 자리.
         */
        const lookup = await deps.followers.inspect(link.chzzkChannelId);
        log('팔로우 일수 조회', {
          by: ctx.userId,
          target: subject,
          verdict: lookup.verdict,
          ...(lookup.reason === undefined ? {} : { reason: lookup.reason }),
        });

        return {
          ephemeral: true,
          content: [
            `<@${subject}> 의 팔로우 상태입니다.`,
            `· 치지직 채널: **${link.chzzkChannelName}**`,
            verdictLine(lookup, now),
            snapshotLine(lookup),
          ].join('\n'),
        };
      } catch (e: unknown) {
        const detail = e instanceof Error ? e.message : String(e);
        log('팔로우 일수 조회 실패', { by: ctx.userId, target: subject, detail });
        return {
          ephemeral: true,
          content: [
            '팔로우 상태를 조회하다 오류가 났습니다. 잠시 후 다시 시도해 주십시오.',
            `사유: ${detail.slice(0, 200)}`,
          ].join('\n'),
        };
      }
    },
  };
}
