import { PermissionFlagsBits } from 'discord.js';

import type { Clock } from '../../runtime/clock.js';
import type { LinkRepo } from '../../store/repos/link-repo.js';
import type {
  CommandContext,
  CommandDefinition,
  CommandReply,
  SlashCommand,
} from './types.js';
import { OPTION_TYPE_USER } from './types.js';

/**
 * `/연동해제` — 운영자가 멤버의 연동을 지운다 (AC-9).
 *
 * ★★ **행을 삭제한다. soft-delete 를 두지 않는다.**
 *   지워지지 않은 행은 `UNIQUE (guild_id, chzzk_channel_id)` 를 계속 점유한다 —
 *   해제한 사람이 다시 인증하려 할 때 **자기 자신 때문에 AC-7 거부**를 맞는다.
 *   "이력을 남기고 싶다" 는 요구는 `ops_events` 가 받는다. 연동 테이블은 **현재
 *   상태**만 담는다.
 *
 * ★ 권한 게이트가 두 겹이다.
 *   ① `default_member_permissions` — 디스코드가 명령을 아예 안 보여준다
 *   ② `ctx.isOperator` — 우리가 거부한다
 *   ①만으로는 안 되는 이유: 서버 관리자가 UI 에서 명령 권한을 덮어쓸 수 있어서
 *   **표시 제어는 권한 검사가 아니다.**
 *
 * ★ **역할을 회수하지 않는다.** Non-Goal(*"인증 후 언팔해도 역할을 회수하지 않는다"*)의
 *   연장이다. 연동 해제는 "다시 인증할 수 있게 자리를 비우는 것" 이고, 역할 회수는
 *   운영자가 디스코드에서 하는 별개 동작이다. 여기서 함께 하면 되돌릴 수 없는 일을
 *   한 명령에 묶게 된다 — 응답에 그 사실을 명시한다.
 */

export const UNLINK_COMMAND_NAME = '연동해제';

export const UNLINK_COMMAND: CommandDefinition = {
  name: UNLINK_COMMAND_NAME,
  description: '지정한 멤버의 치지직 연동을 해제합니다 (운영자 전용)',
  dm_permission: false,
  default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
  options: [
    {
      type: OPTION_TYPE_USER,
      name: '대상',
      description: '연동을 해제할 멤버',
      required: true,
    },
  ],
};

export interface UnlinkCommandDeps {
  links: LinkRepo;
  clock: Clock;
  onLog?: (message: string, extra?: Record<string, unknown>) => void;
}

export function createUnlinkCommand(deps: UnlinkCommandDeps): SlashCommand {
  const log = (message: string, extra?: Record<string, unknown>): void => {
    try {
      deps.onLog?.(message, extra);
    } catch {
      /* 진단 로그가 명령을 죽이면 안 된다 (Principle 2) */
    }
  };

  return {
    definition: UNLINK_COMMAND,

    execute(ctx: CommandContext): Promise<CommandReply> {
      if (ctx.isOperator !== true) {
        return Promise.resolve({
          ephemeral: true,
          content: '이 명령은 서버 관리 권한(`Manage Guild`)이 있는 운영자만 사용할 수 있습니다.',
        });
      }

      const target = ctx.targetUserId;
      if (target === undefined || target === '') {
        return Promise.resolve({ ephemeral: true, content: '해제할 대상을 지정해 주십시오.' });
      }

      const removed = deps.links.unlink(ctx.guildId, target);
      if (removed === undefined) {
        return Promise.resolve({
          ephemeral: true,
          content: '해당 멤버는 연동돼 있지 않습니다.',
        });
      }

      log('연동 해제', {
        guildId: ctx.guildId,
        target,
        by: ctx.userId,
        at: deps.clock.date().toISOString(),
      });

      return Promise.resolve({
        ephemeral: true,
        content: [
          `연동을 해제했습니다 — 치지직 채널 **${removed.chzzkChannelName}**.`,
          '이제 이 치지직 계정으로 다시 인증할 수 있습니다.',
          '※ 이미 부여된 역할은 그대로 남습니다. 필요하면 디스코드에서 직접 제거해 주십시오.',
        ].join('\n'),
      });
    },
  };
}
