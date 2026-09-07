import type { LinkRepo } from '../../store/repos/link-repo.js';
import { formatKst } from '../messages.js';
import type {
  CommandContext,
  CommandDefinition,
  CommandReply,
  SlashCommand,
} from './types.js';
import { OPTION_TYPE_USER } from './types.js';

/**
 * `/연동상태` — 지금 어떤 치지직 계정에 묶여 있는지 본다 (AC-2 보조).
 *
 * ★ 운영자는 다른 멤버를 조회할 수 있고, 일반 멤버는 **자기 것만** 본다.
 *   대상을 지정했는데 운영자가 아니면 조용히 자기 것을 보여주지 않고 **거부한다** —
 *   "지정을 무시하고 내 것을 보여준다" 는 사용자가 남의 정보를 봤다고 오해할 여지를
 *   남긴다.
 *
 * ★ 연동 여부는 개인정보라 응답이 항상 ephemeral 이다 (`types.ts` 주석).
 */

export const STATUS_COMMAND_NAME = '연동상태';

export const STATUS_COMMAND: CommandDefinition = {
  name: STATUS_COMMAND_NAME,
  description: '치지직 연동 상태를 확인합니다',
  dm_permission: false,
  options: [
    {
      type: OPTION_TYPE_USER,
      name: '대상',
      description: '조회할 멤버 (운영자만 지정할 수 있습니다)',
      required: false,
    },
  ],
};

export interface StatusCommandDeps {
  links: LinkRepo;
}

export function createStatusCommand(deps: StatusCommandDeps): SlashCommand {
  return {
    definition: STATUS_COMMAND,

    execute(ctx: CommandContext): Promise<CommandReply> {
      const wantsOther = ctx.targetUserId !== undefined && ctx.targetUserId !== ctx.userId;
      if (wantsOther && ctx.isOperator !== true) {
        return Promise.resolve({
          ephemeral: true,
          content: '다른 멤버의 연동 상태는 운영자만 조회할 수 있습니다.',
        });
      }

      const subject = wantsOther ? (ctx.targetUserId ?? ctx.userId) : ctx.userId;
      const link = deps.links.get(ctx.guildId, subject);
      if (link === undefined) {
        return Promise.resolve({
          ephemeral: true,
          content: wantsOther
            ? '해당 멤버는 아직 연동돼 있지 않습니다.'
            : '아직 연동돼 있지 않습니다. `/인증` 으로 시작해 주십시오.',
        });
      }

      const linkedAt = Date.parse(link.linkedAt);
      return Promise.resolve({
        ephemeral: true,
        content: [
          wantsOther ? `<@${subject}> 의 연동 상태입니다.` : '연동돼 있습니다.',
          `· 치지직 채널: **${link.chzzkChannelName}**`,
          `· 연동 시각: ${Number.isFinite(linkedAt) ? formatKst(linkedAt) : link.linkedAt}`,
        ].join('\n'),
      });
    },
  };
}
