import { describe, it, expect, vi } from 'vitest';

import { FOLLOWER_SYNC_BUDGET_MS, createFollowerSyncClient } from '../../src/chzzk/follower-check.js';
import { createFollowRefreshCommand } from '../../src/discord/commands/follow-refresh.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { CALL_TIMEOUT_MS, createHttpBudget, type HttpBudget } from '../../src/runtime/http-budget.js';

/**
 * 상류 전수 동기화 요청 — `POST /api/followers/<채널>/sync` (`/팔로우갱신` 의 바닥).
 *
 * ★★ 이 파일이 지키는 문장:
 *   ① 요청 모양 — POST · 우리 채널 경로 · 토큰 헤더
 *   ② 429 를 **재시도하지 않는다** — 상류 쿨다운 60초를 기다리며 운영자를 묶지 않는다
 *   ③ 옛 판 상류(404·405 HTML)가 아무것도 깨지 않는다
 *   ④ 타임아웃·형태 불량은 실패가 아니라 **미확인**이다
 *   ⑤ 겹친 호출은 요청 **하나**를 나눠 받는다 — 전역 슬롯을 연타 수만큼 쥐지 않는다
 *   ⑥ 프록시의 429·502 를 상류의 쿨다운·동기화 실패로 읽지 않는다
 */

const OUR_CHANNEL = 'c3355ea2b3bea6c646789510796379d6';
const TOKEN = 't'.repeat(48);
const CACHED_AT = '2026-10-04T03:00:00.000Z';

interface Seen {
  url: string;
  method: string | undefined;
  token: string | undefined;
}

function respond(status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch {
  return (): Promise<Response> =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
    );
}

interface MakeOptions {
  sleep?: (ms: number) => Promise<void>;
  maxConcurrent?: number;
  logs?: unknown[];
}

function make(fetchImpl: typeof fetch, o: MakeOptions = {}) {
  const seen: Seen[] = [];
  const clock = new ManualClock(Date.parse('2026-10-04T03:00:00.000Z'));
  const traced = ((url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    seen.push({ url, method: init?.method, token: init?.headers?.['x-chzzkbot-token'] });
    return (fetchImpl as unknown as (u: string, i?: unknown) => Promise<Response>)(url, init);
  }) as unknown as typeof fetch;
  const budget: HttpBudget = createHttpBudget({
    fetchImpl: traced,
    now: () => clock.now(),
    ...(o.sleep === undefined ? {} : { sleep: o.sleep }),
    ...(o.maxConcurrent === undefined ? {} : { maxConcurrent: o.maxConcurrent }),
  });
  const client = createFollowerSyncClient({
    budget,
    // 끝 슬래시는 접힌다 — 판정기와 같은 규칙
    baseUrl: 'http://127.0.0.1:8080/',
    token: TOKEN,
    channelId: OUR_CHANNEL,
    clock,
    onLog: (message, extra) => {
      o.logs?.push({ message, extra });
    },
  });
  return { client, seen, clock, budget };
}

describe('★ 요청 모양', () => {
  it('POST · /api/followers/<우리 채널>/sync · x-chzzkbot-token', async () => {
    const { client, seen } = make(
      respond(200, { version: 1, channelId: OUR_CHANNEL, ok: true, count: 612, cachedAt: CACHED_AT, durationMs: 8_400 }),
    );
    const r = await client.requestSync();
    expect(r).toEqual({ outcome: 'synced', count: 612, cachedAt: CACHED_AT, durationMs: 8_400 });
    expect(seen).toEqual([
      { url: `http://127.0.0.1:8080/api/followers/${OUR_CHANNEL}/sync`, method: 'POST', token: TOKEN },
    ]);
  });

  it('회당 타임아웃은 60초, 대기열 포함 예산은 90초다 — 전수(658명 = 14쪽)는 3초에 끝나지 않는다', () => {
    expect(CALL_TIMEOUT_MS['follower-sync']).toBe(60_000);
    expect(FOLLOWER_SYNC_BUDGET_MS).toBe(90_000);
    expect(FOLLOWER_SYNC_BUDGET_MS).toBeGreaterThan(CALL_TIMEOUT_MS['follower-sync']);
    expect(CALL_TIMEOUT_MS['follower-sync']).toBeGreaterThan(CALL_TIMEOUT_MS['follower-lookup']);
  });
});

describe('응답 갈래', () => {
  it('★★ 429 는 재시도하지 않고 상류 본문의 retryAfterSec·cachedAt 을 싣는다', async () => {
    const sleep = vi.fn((): Promise<void> => Promise.resolve());
    const { client, seen } = make(
      respond(
        429,
        { version: 1, channelId: OUR_CHANNEL, error: 'cooldown', retryAfterSec: 42, cachedAt: CACHED_AT },
        { 'retry-after': '42' },
      ),
      { sleep },
    );
    const r = await client.requestSync();
    expect(r).toEqual({ outcome: 'cooldown', retryAfterSec: 42, cachedAt: CACHED_AT });
    expect(seen, '쿨다운인데 다시 쳤다').toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('★ joined:true 는 싣고, 없거나 false 거나 이상한 값이면 싣지 않는다 (옛 판·새 판 모두)', async () => {
    const base = { version: 1, channelId: OUR_CHANNEL, ok: true, count: 658, cachedAt: CACHED_AT, durationMs: 20_000 };
    expect(await make(respond(200, { ...base, joined: true })).client.requestSync()).toEqual({
      outcome: 'synced',
      count: 658,
      cachedAt: CACHED_AT,
      durationMs: 20_000,
      joined: true,
    });
    for (const extra of [{}, { joined: false }, { joined: 'yes' }]) {
      expect(await make(respond(200, { ...base, ...extra })).client.requestSync()).toEqual({
        outcome: 'synced',
        count: 658,
        cachedAt: CACHED_AT,
        durationMs: 20_000,
      });
    }
  });

  it('502 의 joined 는 받아만 둔다 — 실패 판정은 같다', async () => {
    const { client } = make(
      respond(502, { version: 1, channelId: OUR_CHANNEL, ok: false, error: 'sync_failed', lastError: 'x', joined: true }),
    );
    expect(await client.requestSync()).toEqual({ outcome: 'sync-failed', lastError: 'x' });
  });

  it('429 의 cachedAt:null 은 싣지 않는다', async () => {
    const { client } = make(
      respond(429, { version: 1, channelId: OUR_CHANNEL, error: 'cooldown', retryAfterSec: 10, cachedAt: null }),
    );
    expect(await client.requestSync()).toEqual({ outcome: 'cooldown', retryAfterSec: 10 });
  });

  it('★★ 프록시의 502(HTML · 다른 본문)는 동기화 실패가 아니라 미확인이다 — 상류가 죽어 있을 수 있다', async () => {
    for (const body of ['<html><h1>502 Bad Gateway</h1></html>', { error: 'bad_gateway' }]) {
      const { client } = make(respond(502, body));
      expect(await client.requestSync()).toEqual({ outcome: 'unconfirmed', detail: 'HTTP 502' });
    }
  });

  it('★ 상류 모양이 아닌 429(HTML · 다른 본문)는 쿨다운이 아니라 미확인이다', async () => {
    for (const body of ['<html>Too Many Requests</html>', { error: 'rate_limited' }]) {
      const { client } = make(respond(429, body));
      expect(await client.requestSync()).toEqual({ outcome: 'unconfirmed', detail: 'HTTP 429' });
    }
  });

  it('429·502 라도 남의 채널 응답(R5)이면 미확인이다', async () => {
    const a = make(respond(429, { channelId: 'other', error: 'cooldown', retryAfterSec: 1, cachedAt: null }));
    expect(await a.client.requestSync()).toEqual({ outcome: 'unconfirmed', detail: '응답이 이 채널의 것이 아님' });
    const b = make(respond(502, { channelId: 'other', ok: false, error: 'sync_failed', lastError: null }));
    expect(await b.client.requestSync()).toEqual({ outcome: 'unconfirmed', detail: '응답이 이 채널의 것이 아님' });
  });

  it('502 — 상류 사유를 싣는다', async () => {
    const { client } = make(
      respond(502, { version: 1, channelId: OUR_CHANNEL, ok: false, error: 'sync_failed', lastError: 'HTTP 503' }),
    );
    expect(await client.requestSync()).toEqual({ outcome: 'sync-failed', lastError: 'HTTP 503' });
  });

  it('401 — 토큰 불일치', async () => {
    const { client } = make(respond(401, { error: 'unauthorized' }));
    expect(await client.requestSync()).toEqual({ outcome: 'unauthorized' });
  });

  it('404 not_found — 꺼짐 또는 옛 판', async () => {
    const { client } = make(respond(404, { error: 'not_found' }));
    expect(await client.requestSync()).toEqual({ outcome: 'unsupported', status: 404 });
  });

  it('404 channel_not_found — 우리 채널이 상류에 없다', async () => {
    const { client } = make(respond(404, { error: 'channel_not_found' }));
    expect(await client.requestSync()).toEqual({ outcome: 'channel-not-found' });
  });

  it('★ 옛 판 상류 — POST 를 405 HTML 로 돌려보내도 깨지지 않는다', async () => {
    const { client } = make(respond(405, '<!doctype html><h1>지원하지 않는 요청</h1>', { 'content-type': 'text/html' }));
    expect(await client.requestSync()).toEqual({ outcome: 'unsupported', status: 405 });
  });

  it('남의 채널 응답(R5)은 성공으로 읽지 않는다', async () => {
    const { client } = make(
      respond(200, { version: 1, channelId: 'other', ok: true, count: 1, cachedAt: CACHED_AT, durationMs: 1 }),
    );
    expect((await client.requestSync()).outcome).toBe('unconfirmed');
  });

  it('★ 200 인데 형태가 다르면(옛 판의 단건 조회 모양 등) 미확인이다', async () => {
    const { client } = make(
      respond(200, { channelId: OUR_CHANNEL, viewerChannelId: 'sync', isFollower: false, everSynced: true, cachedAt: CACHED_AT }),
    );
    expect(await client.requestSync()).toEqual({ outcome: 'unconfirmed', detail: '응답 형태 불량' });
  });

  it('★ 타임아웃은 실패가 아니라 미확인이다', async () => {
    vi.useFakeTimers();
    try {
      const hang = ((_url: string, init?: { signal?: AbortSignal }): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        })) as unknown as typeof fetch;
      const { client } = make(hang);
      const p = client.requestSync();
      await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS['follower-sync']);
      expect(await p).toEqual({ outcome: 'unconfirmed', detail: '제한 시간 초과' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('★ 네트워크 오류는 던지지 않고 "닿지 못함" 이다 — 동기화가 시작되지도 않았다', async () => {
    const { client } = make(() => Promise.reject(new Error('ECONNREFUSED')));
    expect(await client.requestSync()).toEqual({ outcome: 'unreachable', detail: 'ECONNREFUSED' });
  });

  it('★ 503 shutting_down — 상류가 재기동 중이라 끊었다 (원인 확정이라 미확인과 가른다)', async () => {
    const { client } = make(respond(503, { error: 'shutting_down' }));
    expect(await client.requestSync()).toEqual({ outcome: 'shutting-down' });
  });

  it('상류 모양이 아닌 503(HTML · 다른 본문)은 미확인이다', async () => {
    for (const body of ['<html>Service Unavailable</html>', { error: 'maintenance' }]) {
      const { client } = make(respond(503, body));
      expect(await client.requestSync()).toEqual({ outcome: 'unconfirmed', detail: 'HTTP 503' });
    }
  });

  it('그 밖의 상태(500)는 미확인이다', async () => {
    const { client } = make(respond(500, { error: 'internal' }));
    expect(await client.requestSync()).toEqual({ outcome: 'unconfirmed', detail: 'HTTP 500' });
  });
});

describe('★★ single-flight — 겹친 호출은 요청 하나를 나눠 받는다', () => {
  it('동시 두 번 → fetch 1회, 둘 다 같은 결과', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const ok = respond(200, { version: 1, channelId: OUR_CHANNEL, ok: true, count: 3, cachedAt: CACHED_AT, durationMs: 1 });
    const { client, seen } = make((async (...args: Parameters<typeof fetch>) => {
      await gate;
      return ok(...args);
    }));

    const a = client.requestSync();
    const b = client.requestSync();
    release?.();
    const [ra, rb] = await Promise.all([a, b]);
    expect(seen, '연타가 전역 슬롯을 하나 더 쥐었다').toHaveLength(1);
    expect(ra).toEqual({ outcome: 'synced', count: 3, cachedAt: CACHED_AT, durationMs: 1 });
    expect(rb).toEqual(ra);
  });

  it('끝난 뒤에는 다음 호출이 새로 나간다 — 결과를 붙잡아 두지 않는다', async () => {
    const { client, seen } = make(respond(401, { error: 'unauthorized' }));
    await client.requestSync();
    await client.requestSync();
    expect(seen).toHaveLength(2);
  });
});

describe('★ 작업 예산 — 줄에서 굶으면 미확인으로 접는다', () => {
  it('전역 슬롯이 막혀 90초를 넘기면 요청을 보내지 않고 "작업 예산 초과" 다', async () => {
    let releaseOther: (() => void) | undefined;
    const ok = respond(200, { ok: 1 });
    const { client, clock, budget, seen } = make(
      ((url: string, init?: unknown) =>
        url.endsWith('/other')
          ? new Promise<Response>((r) => {
              releaseOther = () => {
                r(new Response('{}', { status: 200 }));
              };
            })
          : (ok as unknown as (u: string, i?: unknown) => Promise<Response>)(url, init)) as unknown as typeof fetch,
      { maxConcurrent: 1 },
    );
    const other = budget.request('live-api', 'http://127.0.0.1:8080/other');
    const p = client.requestSync();
    // 앞 요청이 실제로 fetch 까지 가 슬롯을 쥘 때까지 한 번 양보한다.
    await new Promise((r) => {
      setTimeout(r, 0);
    });
    expect(releaseOther, '앞 요청이 슬롯을 쥐지 않았다').toBeDefined();
    clock.advance(FOLLOWER_SYNC_BUDGET_MS + 1);
    releaseOther?.();
    await other;
    expect(await p).toEqual({ outcome: 'unconfirmed', detail: '작업 예산 초과' });
    expect(seen.filter((s) => s.url.endsWith('/sync'))).toHaveLength(0);
  });
});

describe('★ 토큰은 어떤 로그에도 실리지 않는다', () => {
  it('모든 갈래의 클라이언트·명령 로그에 토큰이 없다', async () => {
    const cases: [number, unknown][] = [
      [200, { version: 1, channelId: OUR_CHANNEL, ok: true, count: 1, cachedAt: CACHED_AT, durationMs: 1 }],
      [200, { version: 1, channelId: 'other', ok: true, count: 1, cachedAt: CACHED_AT, durationMs: 1 }],
      [429, { channelId: OUR_CHANNEL, error: 'cooldown', retryAfterSec: 5, cachedAt: null }],
      [502, { channelId: OUR_CHANNEL, error: 'sync_failed', lastError: 'x' }],
      [401, { error: 'unauthorized' }],
      [404, { error: 'not_found' }],
      [500, 'boom'],
    ];
    const logs: unknown[] = [];
    for (const [status, body] of cases) {
      const { client } = make(respond(status, body), { logs });
      const cmd = createFollowRefreshCommand({
        followers: client,
        onLog: (message, extra) => {
          logs.push({ message, extra });
        },
      });
      await cmd.execute({ guildId: 'g1', userId: 'op', isOperator: true });
    }
    expect(logs.length).toBeGreaterThanOrEqual(cases.length);
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });
});
