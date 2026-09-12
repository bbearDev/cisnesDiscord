import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import type { Interaction } from 'discord.js';

import type { ActionRow } from './client.js';
import type { Command, CommandContext, CommandReply, SlashCommand } from './commands/types.js';

/**
 * 디스코드 상호작용 → 명령 (계획 §S4 · `docs/spec-auth-panel.md` D-4).
 *
 * `discord.js` 의 `Interaction` 을 만지는 **유일한** 자리다. 슬래시든 버튼이든 여기서
 * `CommandContext` 로 접혀 같은 `execute()` 를 탄다 — 명령 본체는 어느 쪽으로 불렸는지 모른다.
 *
 * ★ 조립부(`main.ts`)에서 떼어 낸 이유: 여기가 이 저장소에서 `discord.js` 상호작용 API 에
 *   직접 닿는 유일한 코드인데, `main.ts` 안에 있으면 실제 `Client` 없이는 한 줄도 시험할 수 없다.
 *   순수 함수로 두면 가짜 상호작용 객체로 분기·응답 모양·`defer` 짝을 전부 잡는다.
 *
 * ★ **응답은 한 번, 반드시.** 답하지 않으면 사용자는 "애플리케이션이 응답하지 않음" 만 본다.
 *   `defer` 명령은 `deferReply` → `editReply` 한 쌍, 나머지는 `reply` 한 번이다.
 *   `dispatch*` 는 던지지 않기로 돼 있고(조립부가 감싼다), 여기서 새는 것은 디스코드 REST
 *   자체의 실패뿐이다 — 그것은 호출부가 로그로 받는다.
 *
 * ★★ **`defer` 계약은 버튼과 슬래시에 똑같이 적용된다.** 버튼이라고 REST 를 안 타는 것이
 *   아니다 — `인증` 버튼의 역할 재부여 경로가 `addRole` 을 부른다(`commands/link.ts`). 그 2.5초
 *   상한에 `reply` 왕복까지 더하면 3초 창에 남는 것이 ~500ms 뿐이라, 하필 복구 경로에서
 *   "응답 없음" 이 날 확률이 가장 높았다 (PR #8 리뷰). 명령이 `defer` 를 들면 진입 수단과
 *   무관하게 먼저 "생각 중" 을 보낸다.
 */

export interface InteractionRouterDeps {
  /** 슬래시로 등록된 명령. `defer` 판정에만 쓴다 — 실행은 `dispatchCommand` 가 한다 */
  commands: ReadonlyMap<string, SlashCommand>;
  /** 패널 버튼 `custom_id` → 명령. 역시 `defer` 판정에만 쓴다 — 실행은 `dispatchButton` 이 한다 */
  buttons: ReadonlyMap<string, Command>;
  dispatchCommand(name: string, ctx: CommandContext): Promise<CommandReply>;
  dispatchButton(customId: string, ctx: CommandContext): Promise<CommandReply>;
  /** `/연동해제` · `/연동상태` 의 멤버 옵션 이름 */
  targetUserOption: string;
  /** `/인증채널` 의 채널 옵션 이름 */
  targetChannelOption: string;
}

export const DM_REJECT_MESSAGE = '이 명령은 서버 안에서만 사용할 수 있습니다.';

function replyBody(reply: CommandReply): { content: string; components?: ActionRow[] } {
  return {
    content: reply.content,
    ...(reply.components === undefined ? {} : { components: reply.components }),
  };
}

export function createInteractionRouter(
  deps: InteractionRouterDeps,
): (interaction: Interaction) => Promise<void> {
  return async (interaction) => {
    if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
    if (interaction.guildId === null) {
      await interaction.reply({ content: DM_REJECT_MESSAGE, flags: MessageFlags.Ephemeral });
      return;
    }

    // ★ 상호작용에서 컨텍스트를 뽑는 것이 조립부의 일이다 (`commands/types.ts`).
    const base: CommandContext = {
      guildId: interaction.guildId,
      userId: interaction.user.id,
      // ★ `default_member_permissions` 와 두 겹이다. 그쪽은 디스코드가 안 보여주는
      //   것이고 이쪽은 우리가 거부하는 것이다 — 표시 제어는 권한 검사가 아니다.
      isOperator: interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
    };

    if (interaction.isButton()) {
      const deferred = deps.buttons.get(interaction.customId)?.defer === true;
      if (deferred) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const reply = await deps.dispatchButton(interaction.customId, base);
      if (deferred) await interaction.editReply(replyBody(reply));
      else await interaction.reply({ ...replyBody(reply), flags: MessageFlags.Ephemeral });
      return;
    }

    const ctx: CommandContext = {
      ...base,
      targetUserId: interaction.options.getUser(deps.targetUserOption)?.id,
      targetChannelId: interaction.options.getChannel(deps.targetChannelOption)?.id,
    };

    // ★ 응답 전에 REST 를 부르는 명령(`/인증채널`)은 3초 창을 넘길 수 있다 —
    //   먼저 "생각 중" 을 보내 창을 15분으로 늘리고, 결과로 고쳐 쓴다.
    const deferred = deps.commands.get(interaction.commandName)?.defer === true;
    if (deferred) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reply = await deps.dispatchCommand(interaction.commandName, ctx);
    if (deferred) await interaction.editReply(replyBody(reply));
    else await interaction.reply({ ...replyBody(reply), flags: MessageFlags.Ephemeral });
  };
}
