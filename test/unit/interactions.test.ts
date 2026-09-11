import { describe, it, expect, vi } from 'vitest';
import { MessageFlags, PermissionFlagsBits, type Interaction } from 'discord.js';

import type { CommandReply, SlashCommand } from '../../src/discord/commands/types.js';
import { createInteractionRouter, DM_REJECT_MESSAGE } from '../../src/discord/interactions.js';

/**
 * 상호작용 → 명령 접기 (`docs/spec-auth-panel.md` D-4).
 *
 * ★ 이 파일이 이 저장소에서 `discord.js` 상호작용 API 에 닿는 유일한 코드를 시험한다.
 *   보는 것은 셋이다 — **어느 dispatch 로 가는가**, **응답이 정확히 한 번·어떤 모양인가**,
 *   **`defer` 명령만 `deferReply`→`editReply` 짝을 타는가**.
 */

const GUILD = '111';
const ROW = [{ type: 1 as const, components: [] }];

interface FakeInteraction {
  reply: ReturnType<typeof vi.fn>;
  deferReply: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
  interaction: Interaction;
}

function fakeInteraction(shape: {
  kind: 'button' | 'slash' | 'other';
  guildId?: string | null;
  operator?: boolean;
  customId?: string;
  commandName?: string;
  user?: string | null;
  channel?: string | null;
}): FakeInteraction {
  const reply = vi.fn().mockResolvedValue(undefined);
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const raw = {
    isChatInputCommand: () => shape.kind === 'slash',
    isButton: () => shape.kind === 'button',
    guildId: shape.guildId === undefined ? GUILD : shape.guildId,
    user: { id: 'user-1' },
    memberPermissions:
      shape.operator === undefined
        ? null
        : { has: (p: bigint) => p === PermissionFlagsBits.ManageGuild && shape.operator === true },
    customId: shape.customId ?? '',
    commandName: shape.commandName ?? '',
    options: {
      getUser: () => (shape.user === undefined || shape.user === null ? null : { id: shape.user }),
      getChannel: () =>
        shape.channel === undefined || shape.channel === null ? null : { id: shape.channel },
    },
    reply,
    deferReply,
    editReply,
  };
  return { reply, deferReply, editReply, interaction: raw as unknown as Interaction };
}

function harness(replies: { command?: CommandReply; button?: CommandReply } = {}) {
  const commandCalls: { name: string; ctx: unknown }[] = [];
  const buttonCalls: { id: string; ctx: unknown }[] = [];
  const deferCmd: SlashCommand = {
    definition: { name: '인증채널', description: '', dm_permission: false },
    defer: true,
    execute: () => Promise.resolve({ ephemeral: true, content: '' }),
  };
  const plainCmd: SlashCommand = {
    definition: { name: '연동해제', description: '', dm_permission: false },
    execute: () => Promise.resolve({ ephemeral: true, content: '' }),
  };
  const route = createInteractionRouter({
    commands: new Map([
      ['인증채널', deferCmd],
      ['연동해제', plainCmd],
    ]),
    dispatchCommand: (name, ctx) => {
      commandCalls.push({ name, ctx });
      return Promise.resolve(replies.command ?? { ephemeral: true, content: `cmd:${name}` });
    },
    dispatchButton: (id, ctx) => {
      buttonCalls.push({ id, ctx });
      return Promise.resolve(replies.button ?? { ephemeral: true, content: `btn:${id}` });
    },
    targetUserOption: '대상',
    targetChannelOption: '채널',
  });
  return { route, commandCalls, buttonCalls };
}

describe('버튼', () => {
  it('★ custom_id 로 dispatchButton 에 가고, 답장은 ephemeral 한 번 + components 그대로', async () => {
    const h = harness({ button: { ephemeral: true, content: '링크', components: ROW } });
    const f = fakeInteraction({ kind: 'button', customId: 'cisnes:auth:link', operator: false });
    await h.route(f.interaction);

    expect(h.buttonCalls).toEqual([
      { id: 'cisnes:auth:link', ctx: { guildId: GUILD, userId: 'user-1', isOperator: false } },
    ]);
    expect(h.commandCalls).toHaveLength(0);
    expect(f.reply).toHaveBeenCalledTimes(1);
    expect(f.reply).toHaveBeenCalledWith({ content: '링크', components: ROW, flags: MessageFlags.Ephemeral });
    expect(f.deferReply).not.toHaveBeenCalled();
    expect(f.editReply).not.toHaveBeenCalled();
  });

  it('components 가 없으면 키 자체를 싣지 않는다', async () => {
    const h = harness();
    const f = fakeInteraction({ kind: 'button', customId: 'cisnes:auth:status' });
    await h.route(f.interaction);
    expect(f.reply).toHaveBeenCalledWith({ content: 'btn:cisnes:auth:status', flags: MessageFlags.Ephemeral });
  });

  it('memberPermissions 가 없으면 운영자가 아니다', async () => {
    const h = harness();
    const f = fakeInteraction({ kind: 'button', customId: 'x' });
    await h.route(f.interaction);
    expect(h.buttonCalls[0]?.ctx).toMatchObject({ isOperator: false });
  });
});

describe('슬래시', () => {
  it('대상 멤버·채널 옵션이 컨텍스트로 접힌다. 운영자 여부는 Manage Guild 다', async () => {
    const h = harness();
    const f = fakeInteraction({
      kind: 'slash',
      commandName: '연동해제',
      operator: true,
      user: 'target-9',
      channel: 'chan-3',
    });
    await h.route(f.interaction);
    expect(h.commandCalls).toEqual([
      {
        name: '연동해제',
        ctx: {
          guildId: GUILD,
          userId: 'user-1',
          isOperator: true,
          targetUserId: 'target-9',
          targetChannelId: 'chan-3',
        },
      },
    ]);
    expect(f.reply).toHaveBeenCalledTimes(1);
    expect(f.reply).toHaveBeenCalledWith({ content: 'cmd:연동해제', flags: MessageFlags.Ephemeral });
    expect(f.deferReply).not.toHaveBeenCalled();
  });

  it('★★ defer 명령은 deferReply(ephemeral) → editReply 한 쌍이고 reply 는 부르지 않는다', async () => {
    const h = harness({ command: { ephemeral: true, content: '게시했습니다' } });
    const f = fakeInteraction({ kind: 'slash', commandName: '인증채널', operator: true, channel: 'c' });
    await h.route(f.interaction);

    expect(f.deferReply).toHaveBeenCalledTimes(1);
    expect(f.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(f.editReply).toHaveBeenCalledTimes(1);
    expect(f.editReply).toHaveBeenCalledWith({ content: '게시했습니다' });
    expect(f.reply).not.toHaveBeenCalled();
    // ★ defer 가 dispatch 보다 먼저다 — 순서가 뒤집히면 3초 창을 늘리는 의미가 없다
    const deferAt = f.deferReply.mock.invocationCallOrder[0] ?? Infinity;
    const editAt = f.editReply.mock.invocationCallOrder[0] ?? -1;
    expect(deferAt).toBeLessThan(editAt);
  });

  it('모르는 명령도 dispatchCommand 로 간다 (거기서 "알 수 없는 명령" 을 답한다) — defer 아님', async () => {
    const h = harness();
    const f = fakeInteraction({ kind: 'slash', commandName: '없는명령' });
    await h.route(f.interaction);
    expect(h.commandCalls[0]?.name).toBe('없는명령');
    expect(f.deferReply).not.toHaveBeenCalled();
    expect(f.reply).toHaveBeenCalledTimes(1);
  });
});

describe('경계', () => {
  it('DM(guildId null) 은 버튼이든 슬래시든 같은 거부 문구, dispatch 0회', async () => {
    for (const kind of ['button', 'slash'] as const) {
      const h = harness();
      const f = fakeInteraction({ kind, guildId: null, customId: 'x', commandName: 'y' });
      await h.route(f.interaction);
      expect(f.reply).toHaveBeenCalledWith({ content: DM_REJECT_MESSAGE, flags: MessageFlags.Ephemeral });
      expect(h.buttonCalls).toHaveLength(0);
      expect(h.commandCalls).toHaveLength(0);
    }
  });

  it('버튼도 슬래시도 아닌 상호작용은 건드리지 않는다', async () => {
    const h = harness();
    const f = fakeInteraction({ kind: 'other' });
    await h.route(f.interaction);
    expect(f.reply).not.toHaveBeenCalled();
    expect(h.buttonCalls).toHaveLength(0);
    expect(h.commandCalls).toHaveLength(0);
  });

  it('reply 자체가 실패하면 그 예외가 그대로 올라간다 — 호출부가 로그로 받는다', async () => {
    const h = harness();
    const f = fakeInteraction({ kind: 'button', customId: 'x' });
    f.reply.mockRejectedValueOnce(new Error('Unknown interaction'));
    await expect(h.route(f.interaction)).rejects.toThrow('Unknown interaction');
  });
});
