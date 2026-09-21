import { PermissionFlagsBits } from 'discord.js';

import type { Clock } from '../../runtime/clock.js';
import type { BlacklistEntry, BlacklistRepo } from '../../store/repos/blacklist-repo.js';
import { toDiscordSendError, type AnnouncementEmbed, type SendOptions } from '../client.js';
import { formatKst } from '../messages.js';
import type {
  CommandContext,
  CommandDefinition,
  CommandReply,
  SlashCommand,
} from './types.js';
import { OPTION_TYPE_STRING, OPTION_TYPE_SUB_COMMAND, OPTION_TYPE_USER } from './types.js';

/**
 * `/블랙리스트 추가|해제|목록` — 운영자가 한 멤버의 인증을 차단·해제하고 목록을 본다.
 *
 * ★★ **`/연동해제` 와 다른 명령이다.** 그쪽은 "다시 인증할 수 있게 자리를 비우는 것" 이고
 *   역할을 회수하지 않는다(Non-Goal). 이쪽은 정반대다 — **역할을 즉시 떼고 다시 인증할 수
 *   없게** 한다. 하나의 명령에 두 뜻을 옵션으로 섞으면 운영자가 옵션 하나 차이로 사람을
 *   내보내게 되므로 이름부터 갈라 둔다.
 *
 * ★ `추가` 의 순서 — **DB 먼저, REST 나중.**
 *   ① 차단 행 기록 + 연동 행 삭제(한 트랜잭션 — `blacklist-repo.ts` 머리말) → ② 역할 회수.
 *   ②가 403 으로 실패해도(봇 역할이 대상 역할보다 아래) ①은 이미 끝나 있어 재인증은 막힌다.
 *   응답에 "역할은 직접 떼 달라" 고 말한다 — 콜백의 `grant()` 가 연동 행을 역할 부여 **전에**
 *   쓰는 것과 같은 방향이다(`commands/link.ts` 머리말). 반대로 하면 REST 실패가 곧
 *   "차단이 안 됐다" 가 되고, 그 사람은 그 사이에 다시 인증한다.
 *
 *   이 순서의 알려진 창 하나: 그 사람의 `addRole` REST 가 **날아가는 중**(≤ 2.5초)에 운영자가
 *   `추가` 를 누르면 우리 `removeRole` 이 먼저 닿고 `addRole` 이 뒤에 붙어 *차단됨 + 역할 있음*
 *   이 남을 수 있다. 되돌리려면 게이트가 역할을 떼는 능력을 가져야 하는데 그것은 두지 않기로
 *   했다(`client.ts` `removeRole` 주석). 운영자가 `/블랙리스트 목록` 과 멤버 역할을 대조하면 보인다.
 *
 * ★ 연동 행을 **지운다** (soft-delete 없음 — `link-repo.ts` AC-9 와 같은 원칙). 지우지 않으면
 *   `UNIQUE (guild_id, chzzk_channel_id)` 가 남아 있어, 해제 뒤 본인이 다시 인증할 때
 *   자기 자신 때문에 AC-7 거부를 맞는다. 차단 시점의 치지직 채널은 `blacklist` 행이 보관한다.
 *
 * ★ `해제` 는 차단 행만 지운다. 연동도 역할도 **되살리지 않는다** — 해제된 사람은 인증 패널에서
 *   다시 인증한다. 되살리려면 그 시점의 팔로우 여부를 다시 물어야 하는데 그것이 곧 인증이다.
 *
 * ★ `defer: true` — `추가` 가 역할 회수 REST 를 부른다. 한 명령이 하위 명령에 따라 두 얼굴을
 *   가질 수는 없다(`commands/link.ts` 와 같은 이유).
 */

export const BLACKLIST_COMMAND_NAME = '블랙리스트';
export const BLACKLIST_SUB_ADD = '추가';
export const BLACKLIST_SUB_REMOVE = '해제';
export const BLACKLIST_SUB_LIST = '목록';
/** `/블랙리스트 추가` 의 사유 옵션 이름 — 조립부(`interactions.ts`)가 이 이름으로 뽑는다 */
export const BLACKLIST_REASON_OPTION_NAME = '사유';
/** 사유 상한 — 디스코드가 입력 UI 에서 막는다 */
export const BLACKLIST_REASON_MAX_LENGTH = 100;
/**
 * 목록 임베드에 싣는 최대 인원. 넘치면 최근 순으로 자르고 푸터에 남은 수를 적는다.
 *
 * ★ 이 수가 상한의 전부가 아니다 — `EMBED_DESCRIPTION_MAX` 가 먼저 걸린다. 줄당 고정 오버헤드
 *   (멘션 두 개 · 시각 · 구분자)가 ~100자라 사유 100자 · 긴 채널명이면 20명이 4600자를 넘는다.
 *   글자 예산으로 끊지 않으면 디스코드가 400 을 내고 운영자는 목록을 **아예** 못 본다.
 */
export const BLACKLIST_EMBED_MAX = 20;
/** 디스코드 임베드 `description` 상한. 넘기면 `Invalid Form Body` 400 */
export const EMBED_DESCRIPTION_MAX = 4096;
/** 디스코드 기본 팔레트의 빨강 — 차단 목록은 한눈에 "경고" 로 읽혀야 한다 */
export const BLACKLIST_EMBED_COLOR = 0xed4245;

/**
 * 역할 회수 REST 한 번의 상한. `defer` 라 3초 창과 무관하고 "운영자를 얼마나 기다리게 할
 * 것인가" 만 정한다 — `link.ts` 의 `REGRANT_TIMEOUT_MS` 보다 길게 둔다. 운영자 명령은 사람이
 * 한 번 누르는 것이라 팬아웃 걱정이 없고, 429 대기를 조금 더 품는 편이 "실패 → 직접 떼세요"
 * 보다 낫다.
 */
export const REVOKE_TIMEOUT_MS = 5_000;

export const BLACKLIST_COMMAND: CommandDefinition = {
  name: BLACKLIST_COMMAND_NAME,
  description: '인증 차단 목록을 관리합니다 (운영자 전용)',
  dm_permission: false,
  default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
  options: [
    {
      type: OPTION_TYPE_SUB_COMMAND,
      name: BLACKLIST_SUB_ADD,
      description: '멤버를 차단합니다 — 역할을 즉시 회수하고 다시 인증할 수 없게 합니다',
      options: [
        {
          type: OPTION_TYPE_USER,
          // ★ `/연동상태`·`/연동해제`·`/팔로우` 와 같은 이름 — 조립부가 `TARGET_OPTION_NAME` 하나로 뽑는다.
          name: '대상',
          description: '차단할 멤버',
          required: true,
        },
        {
          type: OPTION_TYPE_STRING,
          name: BLACKLIST_REASON_OPTION_NAME,
          description: '차단 사유 (목록에 표시됩니다)',
          required: false,
          max_length: BLACKLIST_REASON_MAX_LENGTH,
        },
      ],
    },
    {
      type: OPTION_TYPE_SUB_COMMAND,
      name: BLACKLIST_SUB_REMOVE,
      description: '차단을 해제합니다 — 본인이 다시 인증해야 역할을 받습니다',
      options: [
        {
          type: OPTION_TYPE_USER,
          name: '대상',
          description: '해제할 멤버',
          required: true,
        },
      ],
    },
    {
      type: OPTION_TYPE_SUB_COMMAND,
      name: BLACKLIST_SUB_LIST,
      description: '차단 목록을 봅니다',
    },
  ],
};

/** 역할 회수에 쓰는 만큼의 디스코드 표면. `DiscordGateway` 가 그대로 맞는다 */
export interface BlacklistGateway {
  removeRole(guildId: string, userId: string, roleId: string, opts?: SendOptions): Promise<void>;
}

export interface BlacklistCommandDeps {
  blacklist: BlacklistRepo;
  gateway: BlacklistGateway;
  /** `guild_config.verified_role_id`. 없으면 회수할 역할이 없다 — 그 사실을 응답에 적는다 */
  resolveVerifiedRoleId: (guildId: string) => string | undefined;
  clock: Clock;
  /** 회수 REST 상한. 기본 `REVOKE_TIMEOUT_MS` */
  revokeTimeoutMs?: number;
  onLog?: (message: string, extra?: Record<string, unknown>) => void;
}

type RevokeOutcome =
  | { kind: 'removed' }
  | { kind: 'no-role-configured' }
  /** 404 — 대상이 이미 서버를 떠났다. 떠난 사람을 선제 차단하는 것은 정상 운영이다 */
  | { kind: 'member-gone' }
  | { kind: 'failed'; failure: string; detail: string };

function revokeLine(outcome: RevokeOutcome): string {
  switch (outcome.kind) {
    case 'removed':
      return '· 역할: 회수했습니다.';
    case 'no-role-configured':
      return '· 역할: 인증 역할이 설정돼 있지 않아 회수할 역할이 없습니다.';
    case 'member-gone':
      return '· 역할: 서버에 없는 멤버입니다 — 회수할 역할이 없습니다. 다시 들어와도 인증은 막힙니다.';
    case 'failed':
      return outcome.failure === 'forbidden'
        ? '· 역할: **회수하지 못했습니다** — 봇에게 권한이 없습니다(봇 역할이 대상 역할보다 아래인지 확인). 디스코드에서 직접 제거해 주십시오.'
        : `· 역할: **회수하지 못했습니다** (${outcome.detail}). 디스코드에서 직접 제거해 주십시오.`;
  }
}

function entryLine(e: BlacklistEntry, index: number): string {
  const head = [`**${String(index)}.** <@${e.discordUserId}>`];
  if (e.chzzkChannelName !== undefined) head.push(`치지직 **${e.chzzkChannelName}**`);
  head.push(e.reason === undefined ? '사유 없음' : `사유: ${e.reason}`);
  const at = Date.parse(e.addedAt);
  const when = Number.isFinite(at) ? formatKst(at) : e.addedAt;
  return `${head.join(' · ')}\n└ 등록: <@${e.addedBy}> · ${when}`;
}

/**
 * 목록 임베드. 최근 차단이 앞이고, **인원 상한과 글자 예산 중 먼저 닿는 쪽**에서 끊는다.
 *
 * ★ 글자 예산이 있는 이유는 `BLACKLIST_EMBED_MAX` 주석에 있다. 끊긴 사람 수는 인원 상한이든
 *   글자 예산이든 같은 푸터 한 줄로 말한다 — 운영자에게 "왜 잘렸는가" 는 중요하지 않고
 *   "몇 명이 안 보이는가" 가 중요하다.
 *
 * ★ 사유는 운영자가 적은 자유 문자열이다. 이 임베드는 **운영자에게만**(ephemeral) 가므로
 *   멘션·마크다운을 굳이 지우지 않는다 — 지우면 운영자가 적은 그대로가 아니게 된다.
 */
export function blacklistEmbed(entries: readonly BlacklistEntry[]): AnnouncementEmbed {
  const lines: string[] = [];
  let length = 0;
  for (const e of entries) {
    if (lines.length >= BLACKLIST_EMBED_MAX) break;
    const line = entryLine(e, lines.length + 1);
    const next = length + line.length + (lines.length === 0 ? 0 : 1); // 줄바꿈 1자
    if (next > EMBED_DESCRIPTION_MAX) {
      // 첫 줄부터 넘는 일은 없지만(사유 100자 + 오버헤드 ~150자), 있어도 빈 임베드는 내지 않는다.
      if (lines.length === 0) lines.push(line.slice(0, EMBED_DESCRIPTION_MAX));
      break;
    }
    lines.push(line);
    length = next;
  }
  const hidden = entries.length - lines.length;
  return {
    title: `블랙리스트 — ${String(entries.length)}명`,
    description: lines.join('\n'),
    color: BLACKLIST_EMBED_COLOR,
    ...(hidden > 0 ? { footer: { text: `외 ${String(hidden)}명은 표시하지 않았습니다 (최근 순)` } } : {}),
  };
}

const OPERATOR_ONLY = '이 명령은 서버 관리 권한(`Manage Guild`)이 있는 운영자만 사용할 수 있습니다.';

export function createBlacklistCommand(deps: BlacklistCommandDeps): SlashCommand {
  const log = (message: string, extra?: Record<string, unknown>): void => {
    try {
      deps.onLog?.(message, extra);
    } catch {
      /* 진단 로그가 명령을 죽이면 안 된다 (Principle 2) */
    }
  };

  /** ③ 역할 회수 — 던지지 않는다. 결과를 판정으로 돌려준다 */
  async function revoke(guildId: string, userId: string): Promise<RevokeOutcome> {
    const roleId = deps.resolveVerifiedRoleId(guildId);
    if (roleId === undefined) return { kind: 'no-role-configured' };

    const ac = new AbortController();
    const timer = setTimeout(() => {
      ac.abort();
    }, deps.revokeTimeoutMs ?? REVOKE_TIMEOUT_MS);
    try {
      await deps.gateway.removeRole(guildId, userId, roleId, { signal: ac.signal });
      return { kind: 'removed' };
    } catch (e: unknown) {
      const err = toDiscordSendError(e);
      // ★ 404 = 서버에 없는 멤버. 실패가 아니라 "뗄 역할이 없다" 다 — 차단은 이미 끝났다.
      if (err.status === 404) {
        log('블랙리스트 대상이 서버에 없습니다', { guildId, userId });
        return { kind: 'member-gone' };
      }
      log('블랙리스트 역할 회수 실패', { guildId, userId, roleId, kind: err.kind, detail: err.message });
      return { kind: 'failed', failure: err.kind, detail: err.message };
    } finally {
      clearTimeout(timer);
    }
  }

  async function add(ctx: CommandContext, target: string): Promise<CommandReply> {
    if (target === ctx.userId) {
      return { ephemeral: true, content: '자기 자신은 차단할 수 없습니다.' };
    }
    const at = deps.clock.date().toISOString();
    const reason = ctx.reason?.trim();

    // ① 차단 행 + 연동 행 삭제 — 한 트랜잭션. 치지직 채널은 저장소가 연동 행에서 복사한다.
    const added = deps.blacklist.add({
      guildId: ctx.guildId,
      discordUserId: target,
      reason: reason === undefined || reason === '' ? undefined : reason,
      addedBy: ctx.userId,
      addedAt: at,
    });
    if (!added.ok) {
      const since = Date.parse(added.existing.addedAt);
      return {
        ephemeral: true,
        content: [
          `<@${target}> 은(는) 이미 블랙리스트에 있습니다 (${Number.isFinite(since) ? formatKst(since) : added.existing.addedAt} 등록).`,
          '사유를 바꾸려면 해제한 뒤 다시 추가해 주십시오.',
        ].join('\n'),
      };
    }

    // ② 역할 회수 — 여기서 실패해도 ① 은 끝나 있다 (머리말 ★).
    const revoked = await revoke(ctx.guildId, target);

    const removedLink = added.unlinked;
    log('블랙리스트 추가', {
      guildId: ctx.guildId,
      target,
      by: ctx.userId,
      chzzkChannelId: removedLink?.chzzkChannelId,
      hadLink: removedLink !== undefined,
      role: revoked.kind,
      at,
    });

    return {
      ephemeral: true,
      content: [
        `<@${target}> 을(를) 블랙리스트에 추가했습니다.`,
        removedLink === undefined
          ? '· 연동: 연동돼 있지 않았습니다 — 디스코드 계정만 차단됩니다.'
          : `· 연동: 치지직 채널 **${removedLink.chzzkChannelName}** 연동을 해제했고, 이 치지직 계정도 함께 차단됩니다.`,
        revokeLine(revoked),
        reason === undefined || reason === '' ? '· 사유: (없음)' : `· 사유: ${reason}`,
        '해제하기 전까지 이 멤버는 다시 인증할 수 없습니다.',
      ].join('\n'),
    };
  }

  function remove(ctx: CommandContext, target: string): CommandReply {
    const at = deps.clock.date().toISOString();
    const removed = deps.blacklist.remove(ctx.guildId, target, ctx.userId, at);
    if (removed === undefined) {
      return { ephemeral: true, content: `<@${target}> 은(는) 블랙리스트에 없습니다.` };
    }
    log('블랙리스트 해제', { guildId: ctx.guildId, target, by: ctx.userId, at });
    return {
      ephemeral: true,
      content: [
        `<@${target}> 을(를) 블랙리스트에서 해제했습니다.`,
        '· 연동과 역할은 되살리지 않습니다 — 본인이 인증 패널에서 다시 인증해야 역할을 받습니다.',
      ].join('\n'),
    };
  }

  function list(ctx: CommandContext): CommandReply {
    const entries = deps.blacklist.list(ctx.guildId);
    if (entries.length === 0) {
      return { ephemeral: true, content: '블랙리스트가 비어 있습니다.' };
    }
    return { ephemeral: true, content: '', embeds: [blacklistEmbed(entries)] };
  }

  return {
    definition: BLACKLIST_COMMAND,
    defer: true,

    async execute(ctx: CommandContext): Promise<CommandReply> {
      if (ctx.isOperator !== true) {
        return { ephemeral: true, content: OPERATOR_ONLY };
      }

      switch (ctx.subcommand) {
        case BLACKLIST_SUB_LIST:
          return list(ctx);
        case BLACKLIST_SUB_ADD:
        case BLACKLIST_SUB_REMOVE: {
          // 옵션이 `required` 라 디스코드가 막지만, 표시 제어처럼 이쪽도 우리가 한 번 더 본다.
          const target = ctx.targetUserId;
          if (target === undefined || target === '') {
            return { ephemeral: true, content: '대상 멤버를 `대상` 옵션으로 지정해 주십시오.' };
          }
          return ctx.subcommand === BLACKLIST_SUB_ADD ? add(ctx, target) : remove(ctx, target);
        }
        default:
          // ★ 조용히 첫 갈래로 가지 않는다 — 옛 정의가 디스코드에 남은 날의 안전장치.
          return {
            ephemeral: true,
            content: `알 수 없는 하위 명령입니다. \`${BLACKLIST_SUB_ADD}\` · \`${BLACKLIST_SUB_REMOVE}\` · \`${BLACKLIST_SUB_LIST}\` 중 하나를 사용해 주십시오.`,
          };
      }
    },
  };
}
