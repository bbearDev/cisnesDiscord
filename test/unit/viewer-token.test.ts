import { describe, it, expect } from 'vitest';

import {
  buildAuthorizeUrl,
  createViewerTokenClient,
  REVOKE_PATH,
  TOKEN_PATH,
  type ViewerTokenClient,
} from '../../src/chzzk/oauth/viewer-token.js';
import { USERS_ME_PATH } from '../../src/chzzk/api/user-api.js';
import { createHttpBudget } from '../../src/runtime/http-budget.js';

/**
 * ★★ AC-10 — **우리가 보관하는 치지직 토큰은 하나도 없다.**
 *
 *   교환 → `users/me` → 메모리 폐기 + `revoke`(fire-and-forget).
 *
 * 그리고 AD-1 — **보호 채널은 revoke 하지 않는다.** 우리 `clientId` 가 chzzkbot 것과
 * 같아지는 사고(§5.2-c)가 나면 그 한 번의 revoke 가 **상류 스트리머 토큰을 죽인다.**
 * fail-safe 방향은 언제나 *"의심스러우면 revoke 하지 않는다"* 다.
 */

const BASE = 'https://openapi.test';
const OUR_CHANNEL = 'c3355ea2b3bea6c646789510796379d6';
const ACCESS = 'access-token-abcdefghijklmnopqrstuvwxyz';

interface Call {
  path: string;
  body: unknown;
  authorization: string | undefined;
}

function harness(opts: {
  protectedChannelIds?: readonly string[] | undefined;
  channelId?: string;
  revokeStatus?: number;
  tokenStatus?: number;
  meStatus?: number;
  revokeBody?: string;
}): { client: ViewerTokenClient; calls: Call[]; revokeFailures: string[] } {
  const calls: Call[] = [];
  const revokeFailures: string[] = [];

  const fetchImpl = ((url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    const u = new URL(url);
    calls.push({
      path: u.pathname,
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
      authorization: init?.headers?.['Authorization'],
    });

    const json = (status: number, body: string): Response =>
      new Response(body, { status, headers: { 'content-type': 'application/json' } });

    if (u.pathname === TOKEN_PATH) {
      return Promise.resolve(
        json(
          opts.tokenStatus ?? 200,
          JSON.stringify({
            code: 200,
            content: { accessToken: ACCESS, refreshToken: 'refresh-token-zzz', expiresIn: 3600 },
          }),
        ),
      );
    }
    if (u.pathname === USERS_ME_PATH) {
      return Promise.resolve(
        json(
          opts.meStatus ?? 200,
          JSON.stringify({
            code: 200,
            content: { channelId: opts.channelId ?? 'viewer-channel', channelName: '시청자' },
          }),
        ),
      );
    }
    if (u.pathname === REVOKE_PATH) {
      return Promise.resolve(json(opts.revokeStatus ?? 200, opts.revokeBody ?? '{"code":200}'));
    }
    return Promise.resolve(json(404, '{}'));
  }) as unknown as typeof fetch;

  const client = createViewerTokenClient({
    budget: createHttpBudget({ fetchImpl }),
    clientId: 'ours',
    clientSecret: 'secret',
    baseUrl: BASE,
    protectedChannelIds: opts.protectedChannelIds,
    onRevokeFailure: (d) => revokeFailures.push(d),
  });
  return { client, calls, revokeFailures };
}

describe('★★ AC-10 — 토큰은 반환값에도 없다', () => {
  it('identify 결과에 토큰이 담기지 않는다', async () => {
    const h = harness({ protectedChannelIds: [] });
    const r = await h.client.identify({ code: 'c1' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(JSON.stringify(r.identity)).not.toContain(ACCESS);
      expect(JSON.stringify(r.identity)).not.toContain('refresh');
      expect(r.identity).toEqual({ channelId: 'viewer-channel', channelName: '시청자' });
    }
  });

  it('교환 → users/me → revoke 순서로 정확히 3회 부른다', async () => {
    const h = harness({ protectedChannelIds: [] });
    await h.client.identify({ code: 'c1' });
    await h.client.settled();
    expect(h.calls.map((c) => c.path)).toEqual([TOKEN_PATH, USERS_ME_PATH, REVOKE_PATH]);
    // users/me 는 Bearer 로 그 토큰을 쓴다
    expect(h.calls[1]?.authorization).toBe(`Bearer ${ACCESS}`);
  });

  it('channelName 이 없으면 channelId 로 대체한다 — 표시 문자열 때문에 인증을 실패시키지 않는다', async () => {
    const fetchImpl = ((url: string) => {
      const u = new URL(url);
      const body =
        u.pathname === TOKEN_PATH
          ? JSON.stringify({ code: 200, content: { accessToken: ACCESS } })
          : JSON.stringify({ code: 200, content: { channelId: 'only-id' } });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    }) as unknown as typeof fetch;
    const client = createViewerTokenClient({
      budget: createHttpBudget({ fetchImpl }),
      clientId: 'ours',
      clientSecret: 'secret',
      baseUrl: BASE,
      protectedChannelIds: [],
    });
    const r = await client.identify({ code: 'c1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity.channelName).toBe('only-id');
  });
});

describe('★★ AD-1 — 보호 채널은 revoke 하지 않는다', () => {
  it('보호 목록에 있으면 건너뛴다', async () => {
    const h = harness({ protectedChannelIds: [OUR_CHANNEL], channelId: OUR_CHANNEL });
    await h.client.identify({ code: 'c1' });
    await h.client.settled();
    expect(h.calls.map((c) => c.path)).not.toContain(REVOKE_PATH);
    expect(h.client.revokeSkipped).toBe(1);
    expect(h.client.revokeAttempts).toBe(0);
  });

  it('★ 보호 목록 자체를 모르면 건너뛴다 (fail-safe: 의심스러우면 하지 않는다)', async () => {
    const h = harness({ protectedChannelIds: undefined });
    await h.client.identify({ code: 'c1' });
    await h.client.settled();
    expect(h.calls.map((c) => c.path)).not.toContain(REVOKE_PATH);
    expect(h.client.revokeSkipped).toBe(1);
  });

  it('보호 목록 밖이면 revoke 한다', async () => {
    const h = harness({ protectedChannelIds: [OUR_CHANNEL], channelId: 'someone-else' });
    await h.client.identify({ code: 'c1' });
    await h.client.settled();
    expect(h.client.revokeAttempts).toBe(1);
    expect(h.calls[2]?.body).toMatchObject({ token: ACCESS, tokenTypeHint: 'access_token' });
  });
});

describe('★ revoke 실패는 인증을 되돌리지 않는다 (§3-a)', () => {
  it('500 이어도 identify 는 성공이고 실패만 센다', async () => {
    const h = harness({ protectedChannelIds: [], revokeStatus: 500 });
    const r = await h.client.identify({ code: 'c1' });
    expect(r.ok).toBe(true);
    await h.client.settled();
    expect(h.client.revokeFailures).toBe(1);
    expect(h.revokeFailures).toEqual(['status 500']);
  });

  it('본문이 빈 2xx 는 실패가 아니다 — revoke 응답에는 본문이 없을 수 있다', async () => {
    const h = harness({ protectedChannelIds: [], revokeBody: '' });
    await h.client.identify({ code: 'c1' });
    await h.client.settled();
    expect(h.client.revokeFailures).toBe(0);
  });
});

describe('실패 갈래', () => {
  it('교환 실패 → exchange-failed. users/me 를 부르지 않는다', async () => {
    const h = harness({ protectedChannelIds: [], tokenStatus: 400 });
    const r = await h.client.identify({ code: 'bad' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('exchange-failed');
    expect(h.calls.map((c) => c.path)).toEqual([TOKEN_PATH]);
  });

  it('★ 주인 확인 실패 → owner-unknown. 주인을 모르면 revoke 도 하지 않는다', async () => {
    const h = harness({ protectedChannelIds: [], meStatus: 401 });
    const r = await h.client.identify({ code: 'c1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('owner-unknown');
    await h.client.settled();
    expect(h.calls.map((c) => c.path)).not.toContain(REVOKE_PATH);
    expect(h.client.revokeSkipped).toBe(1);
  });
});

describe('인가 URL', () => {
  it('clientId · redirectUri · state 를 싣는다', () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: 'ours',
        redirectUri: 'https://example.com/oauth/callback',
        state: 'st',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://chzzk.naver.com/account-interlock');
    expect(url.searchParams.get('clientId')).toBe('ours');
    expect(url.searchParams.get('redirectUri')).toBe('https://example.com/oauth/callback');
    expect(url.searchParams.get('state')).toBe('st');
  });
});
