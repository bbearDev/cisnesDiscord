import { PermissionFlagsBits } from 'discord.js';

import type { Clock } from '../../runtime/clock.js';
import type { AuthPanelKeeper } from '../panel.js';
import type { CommandContext, CommandDefinition, CommandReply, SlashCommand } from './types.js';
import { CHANNEL_TYPE_GUILD_TEXT, OPTION_TYPE_CHANNEL } from './types.js';

/**
 * `/인증채널` — 운영자가 인증 패널을 놓을 채널을 정한다 (`docs/spec-auth-panel.md` D-7).
 *
 * ★ 이 명령이 있는 이유. 패널은 `guild_config.gate_channel_id` 에 게시되는데 그 값을 채우는
 *   유일한 방법이 `sqlite3` 였다. 슬래시 `/인증` 이 사라진 뒤로는 **패널이 없으면 인증 진입점이
 *   0개**이므로, 채널을 정하는 일이 운영자가 디스코드 안에서 끝낼 수 있는 일이어야 한다.
 *
 * ★ 저장하고 **그 자리에서 게시한다.** 저장만 하고 "재기동하십시오" 로 끝내면 운영자는 패널이
 *   실제로 뜨는지 재기동 뒤에야 안다. 게시 결과를 답장에 그대로 싣는다 — 실패했으면 왜인지.
 *
 * ★ `defer: true` — 게시가 REST 1회(타임아웃 5초)라 상호작용 3초 창을 넘길 수 있다.
 *
 * ★ 채널을 옮겨도 **옛 패널은 지우지 않는다** (`panel.ts` 머리말). 답장에 그 사실을 적어
 *   운영자가 직접 지우게 한다.
 *
 * ★ 권한 게이트가 두 겹이다 (`unlink.ts` 와 같은 이유) — `default_member_permissions` 는
 *   표시 제어이고 `ctx.isOperator` 가 검사다.
 */

export const GATE_CHANNEL_COMMAND_NAME = '인증채널';
/** 채널 옵션 이름. 조립부가 상호작용에서 이 이름으로 꺼낸다 */
export const GATE_CHANNEL_OPTION_NAME = '채널';

export const GATE_CHANNEL_COMMAND: CommandDefinition = {
  name: GATE_CHANNEL_COMMAND_NAME,
  description: '인증 패널을 게시할 채널을 지정하고 바로 게시합니다 (운영자 전용)',
  dm_permission: false,
  default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
  options: [
    {
      type: OPTION_TYPE_CHANNEL,
      name: GATE_CHANNEL_OPTION_NAME,
      description: '인증 패널을 놓을 텍스트 채널',
      required: true,
      channel_types: [CHANNEL_TYPE_GUILD_TEXT],
    },
  ],
};

/** `guild_config` 중 이 명령이 쓰는 만큼 */
export interface GateChannelConfigPort {
  /** 현재 게이트 채널. 없으면 `undefined` */
  gateChannelId(guildId: string): string | undefined;
  /** 게이트 채널만 바꾼다. 다른 컬럼은 건드리지 않는다 */
  setGateChannel(guildId: string, channelId: string, at: string): void;
}

export interface GateChannelCommandDeps {
  config: GateChannelConfigPort;
  panel: AuthPanelKeeper;
  clock: Clock;
  onLog?: (message: string, extra?: Record<string, unknown>) => void;
}

export function createGateChannelCommand(deps: GateChannelCommandDeps): SlashCommand {
  const log = (message: string, extra?: Record<string, unknown>): void => {
    try {
      deps.onLog?.(message, extra);
    } catch {
      /* 진단 로그가 명령을 죽이면 안 된다 (Principle 2) */
    }
  };

  return {
    definition: GATE_CHANNEL_COMMAND,
    defer: true,

    async execute(ctx: CommandContext): Promise<CommandReply> {
      if (ctx.isOperator !== true) {
        return {
          ephemeral: true,
          content: '이 명령은 서버 관리 권한(`Manage Guild`)이 있는 운영자만 사용할 수 있습니다.',
        };
      }

      const channelId = ctx.targetChannelId;
      if (channelId === undefined || channelId === '') {
        return { ephemeral: true, content: '패널을 놓을 채널을 지정해 주십시오.' };
      }

      const previous = deps.config.gateChannelId(ctx.guildId);
      deps.config.setGateChannel(ctx.guildId, channelId, deps.clock.date().toISOString());
      log('게이트 채널 변경', { guildId: ctx.guildId, channelId, previous, by: ctx.userId });

      const result = await deps.panel.ensure(channelId);

      if (result.outcome === 'skipped') {
        // 저장은 됐다. 다음 기동이 다시 시도하지만, 그때까지 진입점이 없다는 사실을 말한다.
        return {
          ephemeral: true,
          content: [
            `게이트 채널을 <#${channelId}> 로 저장했지만 **패널을 게시하지 못했습니다** (${result.reason}${result.detail === undefined ? '' : ` — ${result.detail}`}).`,
            '봇이 그 채널에서 `View Channel` · `Send Messages` · `Embed Links` 를 갖는지 확인한 뒤 이 명령을 다시 실행해 주십시오.',
            '※ 패널이 없는 동안은 멤버가 인증을 시작할 수 없습니다.',
          ].join('\n'),
        };
      }

      const lines = [
        result.outcome === 'posted'
          ? `인증 패널을 <#${channelId}> 에 게시했습니다.`
          : `인증 패널이 이미 <#${channelId}> 에 있어 최신 문안으로 갱신했습니다.`,
      ];
      if (previous !== undefined && previous !== channelId) {
        lines.push(
          `※ 이전 채널 <#${previous}> 의 패널은 지우지 않았습니다. 필요하면 직접 삭제해 주십시오 (그 버튼도 계속 동작합니다).`,
        );
      }
      return { ephemeral: true, content: lines.join('\n') };
    },
  };
}
