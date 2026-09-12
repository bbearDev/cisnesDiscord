import { describe, it, expect } from 'vitest';
import { ButtonStyle, ComponentType } from 'discord.js';

import { DiscordSendError, type SendPayload } from '../../src/discord/client.js';
import { createGateChannelCommand } from '../../src/discord/commands/gate-channel.js';
import {
  AUTH_PANEL_BUTTON_LINK,
  AUTH_PANEL_BUTTON_STATUS,
  AUTH_PANEL_LINK_LABEL,
  AUTH_PANEL_STATE_KEY,
  AUTH_PANEL_STATUS_LABEL,
  MAX_CUSTOM_ID_LENGTH,
  buildAuthPanel,
  createAuthPanelKeeper,
  describeAuthPanelResult,
  readAuthPanelLocation,
  type AuthPanelKeeper,
} from '../../src/discord/panel.js';
import { ManualClock } from '../../src/runtime/clock.js';
import type { RuntimeStateStore } from '../../src/runtime/liveness-stamp.js';

/**
 * 인증 패널 (`docs/spec-auth-panel.md` D-1 · D-2).
 *
 * ★ 여기서 판정하는 것은 **패널이 정확히 하나로 유지되는가** 다.
 *   없으면 올리고, 있으면 고치고, 지워졌으면 다시 올리되, **살아 있을지 모르는 상태에서는
 *   하나 더 만들지 않는다.** 둘이 되면 둘 중 하나는 영영 안 지워진다.
 */

const START = Date.parse('2026-09-12T00:00:00.000Z');
const CHANNEL = '555555555555555555';

function memoryState(): RuntimeStateStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    get: (k) => rows.get(k),
    set: (k, v) => {
      rows.set(k, v);
    },
  };
}

interface FakeGateway {
  sent: { channelId: string; payload: SendPayload }[];
  edited: { channelId: string; messageId: string; payload: SendPayload }[];
  failSend?: DiscordSendError;
  failEdit?: DiscordSendError;
  hang?: boolean;
  send(channelId: string, payload: SendPayload, o?: { signal?: AbortSignal }): Promise<{ id: string }>;
  editMessage(
    channelId: string,
    messageId: string,
    payload: SendPayload,
    o?: { signal?: AbortSignal },
  ): Promise<void>;
}

function fakeGateway(): FakeGateway {
  let seq = 0;
  const gw: FakeGateway = {
    sent: [],
    edited: [],
    send(channelId, payload, o): Promise<{ id: string }> {
      if (gw.hang === true) return hangUntil(o?.signal);
      if (gw.failSend !== undefined) return Promise.reject(gw.failSend);
      seq += 1;
      gw.sent.push({ channelId, payload });
      return Promise.resolve({ id: `msg-${String(seq)}` });
    },
    editMessage(channelId, messageId, payload, o): Promise<void> {
      if (gw.hang === true) return hangUntil(o?.signal);
      if (gw.failEdit !== undefined) return Promise.reject(gw.failEdit);
      gw.edited.push({ channelId, messageId, payload });
      return Promise.resolve();
    },
  };
  return gw;
}

/** 시그널로만 끝나는 프라미스 — 타임아웃 배선이 실제로 걸려 있는지는 이것으로만 본다 */
function hangUntil<T>(signal: AbortSignal | undefined): Promise<T> {
  return new Promise<T>((_, reject) => {
    signal?.addEventListener(
      'abort',
      () => {
        reject(new DiscordSendError('timeout', 'aborted'));
      },
      { once: true },
    );
  });
}

function harness(opts: { timeoutMs?: number } = {}): {
  keeper: AuthPanelKeeper;
  gw: FakeGateway;
  state: ReturnType<typeof memoryState>;
  clock: ManualClock;
  logs: string[];
} {
  const clock = new ManualClock(START);
  const gw = fakeGateway();
  const state = memoryState();
  const logs: string[] = [];
  const keeper = createAuthPanelKeeper({
    gateway: gw,
    state,
    clock,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    onLog: (m) => logs.push(m),
  });
  return { keeper, gw, state, clock, logs };
}

// ══════════════════════════════════════════════════════════════════
//  D-1 본문
// ══════════════════════════════════════════════════════════════════

describe('buildAuthPanel — 임베드 + 버튼 JSON', () => {
  it('임베드 1개 · 버튼 행 1개 · 버튼 2개, custom_id 는 상수 그대로다', () => {
    const p = buildAuthPanel();
    expect(p.embeds).toHaveLength(1);
    expect(p.embeds?.[0]?.title).toBe('치지직 팔로워 인증');
    expect(p.components).toHaveLength(1);
    const row = p.components?.[0];
    expect(row?.type).toBe(ComponentType.ActionRow);
    expect(row?.components.map((c) => ('custom_id' in c ? c.custom_id : c.url))).toEqual([
      AUTH_PANEL_BUTTON_LINK,
      AUTH_PANEL_BUTTON_STATUS,
    ]);
  });

  it('★ [치지직 계정 인증] 은 초록(Success), [내 연동 상태] 는 회색(Secondary) 이다', () => {
    const [link, status] = buildAuthPanel().components?.[0]?.components ?? [];
    expect(link).toMatchObject({ type: ComponentType.Button, style: ButtonStyle.Success, label: AUTH_PANEL_LINK_LABEL });
    expect(status).toMatchObject({ type: ComponentType.Button, style: ButtonStyle.Secondary, label: AUTH_PANEL_STATUS_LABEL });
  });

  it('custom_id 는 cisnes: 접두 + 100자 이내, 본문에는 URL 이 없다', () => {
    for (const id of [AUTH_PANEL_BUTTON_LINK, AUTH_PANEL_BUTTON_STATUS]) {
      expect(id.startsWith('cisnes:')).toBe(true);
      expect(id.length).toBeLessThanOrEqual(MAX_CUSTOM_ID_LENGTH);
    }
    const p = buildAuthPanel();
    expect(p.content).toBeUndefined();
    expect(p.embeds?.[0]?.description).not.toMatch(/https?:\/\//);
    // 안내 문안이 실제 버튼 라벨을 가리킨다 — 라벨을 바꾸면 여기가 깨져야 한다
    expect(p.embeds?.[0]?.description).toContain(AUTH_PANEL_LINK_LABEL);
  });

  it('순수 함수다 — 두 번 불러도 같다', () => {
    expect(buildAuthPanel()).toEqual(buildAuthPanel());
  });
});

// ══════════════════════════════════════════════════════════════════
//  D-2 수명주기
// ══════════════════════════════════════════════════════════════════

describe('ensure — 패널은 정확히 하나', () => {
  it('(a) 기록 없음 → POST 1회, 위치 저장', async () => {
    const h = harness();
    const r = await h.keeper.ensure(CHANNEL);
    expect(r).toEqual({ outcome: 'posted', channelId: CHANNEL, messageId: 'msg-1' });
    expect(h.gw.sent).toHaveLength(1);
    expect(h.gw.edited).toHaveLength(0);
    expect(readAuthPanelLocation(h.state)).toEqual({ channelId: CHANNEL, messageId: 'msg-1' });
    expect(h.keeper.current()).toEqual({ channelId: CHANNEL, messageId: 'msg-1' });
  });

  it('(b) 기록 있음 → PATCH 1회, POST 0회 — 문안이 코드를 따라온다', async () => {
    const h = harness();
    await h.keeper.ensure(CHANNEL);
    const r = await h.keeper.ensure(CHANNEL);
    expect(r).toEqual({ outcome: 'updated', channelId: CHANNEL, messageId: 'msg-1' });
    expect(h.gw.sent).toHaveLength(1);
    expect(h.gw.edited).toHaveLength(1);
    expect(h.gw.edited[0]?.payload).toEqual(buildAuthPanel());
  });

  it('★ (c) PATCH 404 → 새로 POST, 위치 갱신', async () => {
    const h = harness();
    await h.keeper.ensure(CHANNEL);
    h.gw.failEdit = new DiscordSendError('unknown', 'Unknown Message', 404);
    const r = await h.keeper.ensure(CHANNEL);
    expect(r).toEqual({ outcome: 'posted', channelId: CHANNEL, messageId: 'msg-2' });
    expect(h.gw.sent).toHaveLength(2);
    expect(h.keeper.current()?.messageId).toBe('msg-2');
  });

  it('★★ (d) PATCH 가 404 아닌 이유로 실패 → POST 0회, 위치 유지 (둘이 되지 않는다)', async () => {
    const h = harness();
    await h.keeper.ensure(CHANNEL);
    for (const err of [
      new DiscordSendError('server', '503', 503),
      new DiscordSendError('rate-limited', '429', 429, 1_000),
      new DiscordSendError('forbidden', '403', 403),
    ]) {
      h.gw.failEdit = err;
      const r = await h.keeper.ensure(CHANNEL);
      expect(r).toMatchObject({ outcome: 'skipped', reason: 'edit-failed' });
    }
    expect(h.gw.sent).toHaveLength(1);
    expect(h.keeper.current()?.messageId).toBe('msg-1');
  });

  it('(e) 게이트 채널 없음 → 호출 0회, skipped:no-gate-channel', async () => {
    const h = harness();
    for (const v of [undefined, '']) {
      const r = await h.keeper.ensure(v);
      expect(r).toEqual({ outcome: 'skipped', reason: 'no-gate-channel' });
      expect(describeAuthPanelResult(r)).toBe('skipped:no-gate-channel');
    }
    expect(h.gw.sent).toHaveLength(0);
    expect(h.gw.edited).toHaveLength(0);
  });

  it('(f) 채널이 바뀌면 새 채널에 POST, 옛 메시지는 건드리지 않는다', async () => {
    const h = harness();
    await h.keeper.ensure(CHANNEL);
    const r = await h.keeper.ensure('666666666666666666');
    expect(r).toMatchObject({ outcome: 'posted', channelId: '666666666666666666' });
    expect(h.gw.edited).toHaveLength(0);
    expect(h.gw.sent.map((m) => m.channelId)).toEqual([CHANNEL, '666666666666666666']);
    expect(h.keeper.current()?.channelId).toBe('666666666666666666');
  });

  it('POST 실패 → skipped:send-failed, 위치는 남기지 않는다', async () => {
    const h = harness();
    h.gw.failSend = new DiscordSendError('forbidden', '권한 없음', 403);
    const r = await h.keeper.ensure(CHANNEL);
    expect(r).toMatchObject({ outcome: 'skipped', reason: 'send-failed', detail: 'forbidden (status 403)' });
    expect(h.keeper.current()).toBeUndefined();
  });

  it('★ 무응답은 타임아웃으로 끊긴다 — 기동을 영영 붙들지 않는다. 안내는 "올라갔을 수 있다" 를 말한다', async () => {
    const h = harness({ timeoutMs: 20 });
    h.gw.hang = true;
    const r = await h.keeper.ensure(CHANNEL);
    expect(r).toMatchObject({ outcome: 'skipped', reason: 'send-failed' });
    // ★ 타임아웃은 "실패" 가 아니라 "모름" 이다 — 요청이 받아들여졌는데 응답만 늦었을 수 있다.
    //   그 사실을 숨기면 안내를 따라 다시 실행한 운영자가 패널을 둘로 만든다.
    expect(r.outcome === 'skipped' ? r.detail : '').toMatch(/^timeout — 패널이 실제로 올라갔을 수 있습니다/);
  });

  it('★★ 위치 기록이 실패해도 결과는 posted — 패널은 올라갔다 (send-failed 로 보고하면 둘이 된다)', async () => {
    const h = harness();
    h.state.set = () => {
      throw new Error('disk full');
    };
    const r = await h.keeper.ensure(CHANNEL);
    expect(r).toEqual({ outcome: 'posted', channelId: CHANNEL, messageId: 'msg-1' });
    expect(h.gw.sent).toHaveLength(1);
    expect(h.logs.some((m) => m.includes('위치를 기록하지 못했습니다'))).toBe(true);
  });

  it('★ 위치를 읽지 못하면 아무것도 하지 않는다 — 모르는 채 올리면 둘이 될 수 있다', async () => {
    const h = harness();
    await h.keeper.ensure(CHANNEL);
    h.state.get = () => {
      throw new Error('db locked');
    };
    const r = await h.keeper.ensure(CHANNEL);
    expect(r).toMatchObject({ outcome: 'skipped', reason: 'state-unreadable', detail: 'db locked' });
    expect(h.gw.sent).toHaveLength(1);
    expect(h.gw.edited).toHaveLength(0);
  });

  it('★★ 겹쳐 불러도 직렬화된다 — 둘 다 "기록 없음" 을 읽고 둘 다 POST 하는 일이 없다', async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.keeper.ensure(CHANNEL), h.keeper.ensure(CHANNEL)]);
    expect(a.outcome).toBe('posted');
    expect(b.outcome).toBe('updated');
    expect(h.gw.sent).toHaveLength(1);
    expect(h.gw.edited).toHaveLength(1);
  });

  it('깨진 runtime_state 값은 "없음" 으로 본다 — 새로 올린다', async () => {
    const h = harness();
    h.state.set(AUTH_PANEL_STATE_KEY, '{not json', '');
    expect(readAuthPanelLocation(h.state)).toBeUndefined();
    h.state.set(AUTH_PANEL_STATE_KEY, JSON.stringify({ channelId: CHANNEL }), '');
    expect(readAuthPanelLocation(h.state)).toBeUndefined();
    const r = await h.keeper.ensure(CHANNEL);
    expect(r.outcome).toBe('posted');
  });

  it('절대 던지지 않는다 — 게이트웨이가 예외를 내도 값으로 나온다', async () => {
    const h = harness();
    h.gw.failSend = new Error('boom') as DiscordSendError;
    await expect(h.keeper.ensure(CHANNEL)).resolves.toMatchObject({ outcome: 'skipped', detail: 'boom' });
  });
});

// ══════════════════════════════════════════════════════════════════
//  /인증채널
// ══════════════════════════════════════════════════════════════════

describe('/인증채널 — 저장하고 그 자리에서 게시한다', () => {
  function cmdHarness(): ReturnType<typeof harness> & {
    config: Map<string, string>;
    execute: (ctx: { userId: string; isOperator?: boolean; targetChannelId?: string }) => Promise<string>;
  } {
    const h = harness();
    const config = new Map<string, string>();
    const cmd = createGateChannelCommand({
      config: {
        gateChannelId: (g) => config.get(g),
        setGateChannel: (g, c) => {
          config.set(g, c);
        },
      },
      panel: h.keeper,
      clock: h.clock,
    });
    return {
      ...h,
      config,
      execute: async (ctx) => (await cmd.execute({ guildId: 'g', ...ctx })).content,
    };
  }

  it('정의 — Manage Guild 전용 · CHANNEL 옵션 필수 · 텍스트 채널만 · defer', () => {
    const cmd = createGateChannelCommand({
      config: { gateChannelId: () => undefined, setGateChannel: () => undefined },
      panel: harness().keeper,
      clock: new ManualClock(START),
    });
    expect(cmd.definition).toMatchObject({
      name: '인증채널',
      dm_permission: false,
      default_member_permissions: '32',
      options: [{ type: 7, name: '채널', required: true, channel_types: [0] }],
    });
    expect(cmd.defer).toBe(true);
  });

  it('운영자가 아니면 거부 — 저장도 게시도 없다', async () => {
    const h = cmdHarness();
    const out = await h.execute({ userId: 'u', isOperator: false, targetChannelId: CHANNEL });
    expect(out).toContain('운영자만');
    expect(h.config.size).toBe(0);
    expect(h.gw.sent).toHaveLength(0);
  });

  it('채널이 없으면 안내만', async () => {
    const h = cmdHarness();
    const out = await h.execute({ userId: 'u', isOperator: true });
    expect(out).toContain('채널을 지정');
    expect(h.gw.sent).toHaveLength(0);
  });

  it('★ 저장 + 게시. 채널을 옮기면 옛 패널을 지우지 않았다는 사실을 말한다', async () => {
    const h = cmdHarness();
    const first = await h.execute({ userId: 'ops', isOperator: true, targetChannelId: CHANNEL });
    expect(first).toContain(`<#${CHANNEL}> 에 게시했습니다`);
    expect(first).not.toContain('이전 채널');
    expect(h.config.get('g')).toBe(CHANNEL);

    const moved = await h.execute({ userId: 'ops', isOperator: true, targetChannelId: '666' });
    expect(moved).toContain('<#666> 에 게시했습니다');
    expect(moved).toContain(`이전 채널 <#${CHANNEL}>`);
    expect(h.config.get('g')).toBe('666');

    // 같은 채널로 다시 — 갱신
    const same = await h.execute({ userId: 'ops', isOperator: true, targetChannelId: '666' });
    expect(same).toContain('갱신했습니다');
    expect(h.gw.sent).toHaveLength(2);
    expect(h.gw.edited).toHaveLength(1);
  });

  it('★ 게시에 실패해도 채널은 저장된다 — 답장이 실패와 그 사유를 말한다', async () => {
    const h = cmdHarness();
    h.gw.failSend = new DiscordSendError('forbidden', '권한 없음', 403);
    const out = await h.execute({ userId: 'ops', isOperator: true, targetChannelId: CHANNEL });
    expect(h.config.get('g')).toBe(CHANNEL);
    expect(out).toContain('게시하지 못했습니다');
    expect(out).toContain('send-failed');
    expect(out).toContain('forbidden (status 403)');
    expect(out).toContain('Send Messages');
  });
});
