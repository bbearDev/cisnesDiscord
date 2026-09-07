import { describe, it, expect } from 'vitest';
import type { Client } from 'discord.js';

import {
  createDiscordClient,
  createDiscordGateway,
  GATEWAY_EVENTS,
  REQUIRED_INTENTS,
  type GatewayEventName,
  type GatewayEventRecord,
} from '../../src/discord/client.js';
import { ManualClock } from '../../src/runtime/clock.js';

/**
 * `discord.js` 어댑터 (계획 §S3).
 *
 * ★ 여기서 판정하는 것은 **주입점이 실제로 열려 있는가** 다.
 *   주입점이 없으면 `fake-discord.ts` 를 만들어도 붙일 자리가 없고,
 *   §9.3 e2e 계층 전체가 실행 불가가 된다 (계획 §S3 B-2).
 *
 * ★ 네트워크를 타지 않는다. `client.rest` 를 가로채 REST 호출의 **모양**만 본다 —
 *   경로 · 본문 · `AbortSignal` 전달 · 오류 분류.
 */

interface RestCall {
  verb: 'post' | 'put' | 'patch';
  route: string;
  data: { body?: unknown; signal?: AbortSignal } | undefined;
}

function stubClient(reply: (call: RestCall) => unknown = () => ({ id: 'msg-1' })) {
  const calls: RestCall[] = [];
  const listeners = new Map<string, (() => void)[]>();
  let loginToken: string | undefined;
  let destroyed = false;

  const run =
    (verb: RestCall['verb']) =>
    (route: string, data?: { body?: unknown; signal?: AbortSignal }): Promise<unknown> => {
      const call: RestCall = { verb, route, data };
      calls.push(call);
      try {
        return Promise.resolve(reply(call));
      } catch (e: unknown) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    };

  const client = {
    rest: { post: run('post'), put: run('put'), patch: run('patch') },
    on(name: string, fn: () => void) {
      listeners.set(name, [...(listeners.get(name) ?? []), fn]);
      return this;
    },
    login(token: string) {
      loginToken = token;
      return Promise.resolve(token);
    },
    destroy() {
      destroyed = true;
      return Promise.resolve();
    },
  };

  return {
    client: client as unknown as Client,
    calls,
    fire(name: GatewayEventName) {
      for (const fn of listeners.get(name) ?? []) fn();
    },
    get loginToken() {
      return loginToken;
    },
    get destroyed() {
      return destroyed;
    },
  };
}

describe('createDiscordGateway — 주입점', () => {
  it('주입한 클라이언트를 그대로 쓴다 (login / destroy 가 전달된다)', async () => {
    const stub = stubClient();
    const gw = createDiscordGateway({ token: 'bot-token', client: stub.client });

    await gw.login();
    expect(stub.loginToken).toBe('bot-token');
    await gw.destroy();
    expect(stub.destroyed).toBe(true);
  });

  it('★ 발송은 REST 로 하고 AbortSignal 을 그대로 넘긴다 (§5.6.1)', async () => {
    const stub = stubClient();
    const gw = createDiscordGateway({ token: 't', client: stub.client });
    const ac = new AbortController();

    const out = await gw.send('chan-1', { content: '안녕' }, { signal: ac.signal });

    expect(out).toEqual({ id: 'msg-1' });
    expect(stub.calls[0]?.verb).toBe('post');
    expect(stub.calls[0]?.route).toBe('/channels/chan-1/messages');
    expect(stub.calls[0]?.data?.body).toEqual({ content: '안녕' });
    // ★ 시그널이 안 실리면 3초 타임아웃이 배선만 되고 실제로는 안 끊긴다.
    expect(stub.calls[0]?.data?.signal).toBe(ac.signal);
  });

  it('시그널을 주지 않으면 키 자체를 붙이지 않는다', async () => {
    const stub = stubClient();
    const gw = createDiscordGateway({ token: 't', client: stub.client });
    await gw.send('chan-1', {});
    expect(stub.calls[0]?.data).toEqual({ body: {} });
  });

  it('★ 2xx 인데 messageId 가 없으면 실패로 본다 (추적이 끊기는 것을 막는다)', async () => {
    const stub = stubClient(() => ({ noId: true }));
    const gw = createDiscordGateway({ token: 't', client: stub.client });
    await expect(gw.send('chan-1', {})).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('REST 오류를 우리 어휘로 접어 올린다', async () => {
    const stub = stubClient(() => {
      throw Object.assign(new Error('rate limited'), { status: 429, retryAfter: 2 });
    });
    const gw = createDiscordGateway({ token: 't', client: stub.client });
    await expect(gw.send('c', {})).rejects.toMatchObject({
      kind: 'rate-limited',
      retryAfterMs: 2_000,
    });
  });

  it('역할 부여·닉네임 변경도 REST 경로와 시그널이 맞다 (AC-6 · AC-12)', async () => {
    const stub = stubClient(() => undefined);
    const gw = createDiscordGateway({ token: 't', client: stub.client });
    const ac = new AbortController();

    await gw.addRole('g1', 'u1', 'r1', { signal: ac.signal });
    await gw.setNickname('g1', 'u1', '시스네팬');
    await gw.setNickname('g1', 'u1', null);

    expect(stub.calls[0]).toMatchObject({
      verb: 'put',
      route: '/guilds/g1/members/u1/roles/r1',
    });
    expect(stub.calls[0]?.data?.signal).toBe(ac.signal);
    expect(stub.calls[1]).toMatchObject({ verb: 'patch', route: '/guilds/g1/members/u1' });
    expect(stub.calls[1]?.data?.body).toEqual({ nick: '시스네팬' });
    // null 은 "닉네임 해제" 다 — undefined 로 접으면 변경 자체가 안 나간다.
    expect(stub.calls[2]?.data?.body).toEqual({ nick: null });
  });
});

describe('createDiscordGateway — 게이트웨이 재연결 (AC-P3 (a))', () => {
  it('★ 세 이벤트를 전부 구독하되 재연결로 세는 것은 하나다', () => {
    const stub = stubClient();
    const clock = new ManualClock(1_000);
    const seen: { e: GatewayEventRecord; count: number }[] = [];
    const gw = createDiscordGateway({
      token: 't',
      client: stub.client,
      clock,
      onGatewayEvent: (e, count) => seen.push({ e, count }),
    });

    for (const name of GATEWAY_EVENTS) stub.fire(name);

    // 지표 discord_gateway_reconnects 와 같은 값. 셋을 다 세면 3이 된다.
    expect(gw.reconnectCount).toBe(1);
    expect(seen.map((s) => s.e.name)).toEqual([...GATEWAY_EVENTS]);
    expect(seen.at(-1)?.count).toBe(1);
    expect(seen[0]?.e.at).toBe(1_000);
  });

  it('지표 콜백이 던져도 게이트웨이는 계속 돈다 (Principle 2)', () => {
    const stub = stubClient();
    const gw = createDiscordGateway({
      token: 't',
      client: stub.client,
      onGatewayEvent: () => {
        throw new Error('지표 수집기가 죽었다');
      },
    });

    expect(() => {
      stub.fire('shardReconnecting');
    }).not.toThrow();
    expect(gw.reconnectCount).toBe(1);
  });
});

describe('createDiscordClient — 기본 클라이언트', () => {
  it('Intents 세 개로 만들어진다 (Guilds · GuildMembers · GuildMessages)', async () => {
    const client = createDiscordClient();
    try {
      for (const intent of REQUIRED_INTENTS) {
        expect(client.options.intents.has(intent)).toBe(true);
      }
      expect(client.options.intents.toArray()).toHaveLength(REQUIRED_INTENTS.length);
    } finally {
      // 로그인하지 않았으므로 소켓은 없다. 그래도 자원을 남기지 않는다.
      await client.destroy();
    }
  });

  it('주입하지 않으면 기본 클라이언트를 스스로 만든다', async () => {
    const gw = createDiscordGateway({ token: 't' });
    expect(gw.reconnectCount).toBe(0);
    await gw.destroy();
  });
});
