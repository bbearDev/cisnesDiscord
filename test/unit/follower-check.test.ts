import { describe, it, expect } from 'vitest';

import { UPSTREAM_FOLLOWER_CACHE_MIN } from '../../src/config/schema.js';
import {
  createFollowerChecker,
  RECHECK_EPSILON_MS,
  type FollowerLookup,
} from '../../src/chzzk/follower-check.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { createHttpBudget } from '../../src/runtime/http-budget.js';
import { createStuckWatch, buildSpecs } from '../../src/live/stuck-watch.js';
import { loadJsonFixture } from '../e2e/harness/fake-chzzkbot.js';

/**
 * ★★ §5.2-b 판정표 — **위에서부터 순서대로**.
 *
 * | # | 조건 | 결과 |
 * |---|---|---|
 * | 0   | 4xx·5xx·타임아웃·예산·응답 channelId 불일치(R5) | `unknown` |
 * | 0-b | cachedAt 부재·null·파싱불가, 필수필드 누락, zod 실패 | `unknown` |
 * | 1   | `everSynced:false` | `unknown` (**보류, 거부 아님**) |
 * | 2   | ★ cachedAt 나이 > staleAfterMin | `unknown` — **isFollower 를 보지 않는다** |
 * | 3   | `isFollower:true` | `yes` |
 * | 4   | `isFollower:false` AND cachedAt < 클릭시각 | `no` + AD-2 재조회 1회 |
 * | 5   | `isFollower:false` | `no` |
 *
 * 이 파일이 판정하는 것은 **표의 순서**다. 값 하나하나가 아니라 순서가 계약이다 —
 * 신선도 게이트를 아래로 내리면 낡은 캐시가 신규 멤버를 잘못 거부한다(§3-a 3위).
 */

const OUR_CHANNEL = 'c3355ea2b3bea6c646789510796379d6';
const VIEWER = 'aaaa1111bbbb2222cccc3333dddd4444';
const STALE_AFTER_MIN = 150;

/** 픽스처의 신선한 스냅샷 시각 */
const CACHED_FRESH = Date.parse('2026-09-06T18:55:00.000Z');

function jsonFetch(status: number, body: unknown): typeof fetch {
  return (): Promise<Response> =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
}

/** 응답을 영영 주지 않는다 — `AbortSignal` 로만 끊긴다 */
const hangFetch = ((_url: string, init?: { signal?: AbortSignal }): Promise<Response> =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new Error('aborted'));
    });
  })) as unknown as typeof fetch;

/** 마이크로태스크만으로는 부족하다 — 재조회는 fetch 를 한 번 더 탄다 */
function flush(): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, 0);
  });
}

interface Harness {
  checker: ReturnType<typeof createFollowerChecker>;
  clock: ManualClock;
  calls: { url: string; token: string | undefined }[];
}

function harness(opts: {
  now: number;
  fetchImpl: typeof fetch;
  onLookup?: (l: FollowerLookup) => void;
}): Harness {
  const clock = new ManualClock(opts.now);
  const calls: { url: string; token: string | undefined }[] = [];
  const traced = ((url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, token: init?.headers?.['x-chzzkbot-token'] });
    return (opts.fetchImpl as unknown as (u: string, i?: unknown) => Promise<Response>)(url, init);
  }) as unknown as typeof fetch;

  const checker = createFollowerChecker({
    budget: createHttpBudget({ fetchImpl: traced }),
    baseUrl: 'http://127.0.0.1:8080',
    token: 'x'.repeat(32),
    channelId: OUR_CHANNEL,
    staleAfterMin: STALE_AFTER_MIN,
    clock,
    ...(opts.onLookup === undefined ? {} : { onLookup: opts.onLookup }),
  });
  return { checker, clock, calls };
}

describe('판정표 — 픽스처 전 분기', () => {
  it('3 → yes (신선 + isFollower:true)', async () => {
    const now = CACHED_FRESH + 60_000;
    const h = harness({ now, fetchImpl: jsonFetch(200, loadJsonFixture('chzzkbot/followers/yes.json')) });
    const r = await h.checker.check(VIEWER, now, {});
    expect(r.verdict).toBe('yes');
    expect(r.reason).toBeUndefined();
    expect(r.cachedAt).toBe('2026-09-06T18:55:00.000Z');
    expect(r.snapshotAgeSec).toBe(60);
  });

  it('5 → no. cachedAt 이 클릭보다 나중이면 재조회를 예약하지 않는다', async () => {
    const now = CACHED_FRESH + 60_000;
    const h = harness({ now, fetchImpl: jsonFetch(200, loadJsonFixture('chzzkbot/followers/no.json')) });
    // 클릭이 스냅샷보다 **먼저** — 그 스냅샷은 이미 이 사람을 볼 수 있었다.
    const r = await h.checker.check(VIEWER, CACHED_FRESH - 60_000, {});
    expect(r.verdict).toBe('no');
    expect(r.recheckAt).toBeUndefined();
  });

  it('★ 4 → no + AD-2 재조회 예약. cachedAt 이 클릭보다 앞선다', async () => {
    const now = CACHED_FRESH + 60_000;
    const h = harness({ now, fetchImpl: jsonFetch(200, loadJsonFixture('chzzkbot/followers/no.json')) });
    const r = await h.checker.check(VIEWER, now, {});
    expect(r.verdict).toBe('no');
    // cachedAt + followerCacheMin + ε
    expect(r.recheckAt).toBe(CACHED_FRESH + UPSTREAM_FOLLOWER_CACHE_MIN * 60_000 + RECHECK_EPSILON_MS);
  });

  it('★ 1 → unknown(not-synced). everSynced:false 는 **거부가 아니라 보류**다', async () => {
    const now = CACHED_FRESH + 60_000;
    const h = harness({
      now,
      fetchImpl: jsonFetch(200, loadJsonFixture('chzzkbot/followers/not-synced.json')),
    });
    const r = await h.checker.check(VIEWER, now, {});
    expect(r.verdict).toBe('unknown');
    expect(r.reason).toBe('not-synced');
    // ★ 미팔로우로 접히지 않았다
    expect(r.verdict).not.toBe('no');
  });

  it('★★ 2 → unknown(stale). isFollower:true 여도 낡았으면 보지 않는다', async () => {
    // 픽스처 cachedAt 15:00 · 지금 19:00 → 240분 > 150분
    const now = Date.parse('2026-09-06T19:00:00.000Z');
    const h = harness({
      now,
      fetchImpl: jsonFetch(200, loadJsonFixture('chzzkbot/followers/stale-but-follower.json')),
    });
    const r = await h.checker.check(VIEWER, now, {});
    expect(r.verdict).toBe('unknown');
    expect(r.reason).toBe('stale');
    // ★ 신선도 게이트가 isFollower 판정보다 먼저다 — 아니었다면 yes 가 나왔다
    expect(r.verdict).not.toBe('yes');
  });

  it('★★ 0-b → unknown(bad-shape). cachedAt:null + isFollower:true 가 yes 로 새면 안 된다', async () => {
    const now = CACHED_FRESH;
    const h = harness({
      now,
      fetchImpl: jsonFetch(200, loadJsonFixture('chzzkbot/followers/null-cachedat.json')),
    });
    const r = await h.checker.check(VIEWER, now, {});
    expect(r.verdict).toBe('unknown');
    expect(r.reason).toBe('bad-shape');
  });

  it('★ 0 → unknown(wrong-channel). 토큰 하나가 남의 채널도 연다 (R5)', async () => {
    const now = CACHED_FRESH + 60_000;
    const h = harness({
      now,
      fetchImpl: jsonFetch(200, loadJsonFixture('chzzkbot/followers/wrong-channel.json')),
    });
    const r = await h.checker.check(VIEWER, now, {});
    expect(r.verdict).toBe('unknown');
    expect(r.reason).toBe('wrong-channel');
  });
});

describe('판정표 0 — 전송 실패는 전부 unknown 이다 (★ no 로 접지 않는다)', () => {
  const cases: { name: string; status: number; reason: string }[] = [
    { name: '401', status: 401, reason: 'http-4xx' },
    { name: '404', status: 404, reason: 'http-4xx' },
    { name: '500', status: 500, reason: 'http-5xx' },
    { name: '503', status: 503, reason: 'http-5xx' },
  ];

  for (const c of cases) {
    it(`${c.name} → unknown(${c.reason})`, async () => {
      const now = CACHED_FRESH;
      const h = harness({ now, fetchImpl: jsonFetch(c.status, { error: 'nope' }) });
      const r = await h.checker.check(VIEWER, now, {});
      expect(r.verdict).toBe('unknown');
      expect(r.reason).toBe(c.reason);
    });
  }

  it('본문이 JSON 이 아니다 → unknown(bad-shape)', async () => {
    const now = CACHED_FRESH;
    const h = harness({ now, fetchImpl: jsonFetch(200, '<html>oops</html>') });
    const r = await h.checker.check(VIEWER, now, {});
    expect(r.verdict).toBe('unknown');
    expect(r.reason).toBe('bad-shape');
  });

  it('네트워크 오류 → unknown(timeout)', async () => {
    const now = CACHED_FRESH;
    const h = harness({
      now,
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    const r = await h.checker.check(VIEWER, now, {});
    expect(r.verdict).toBe('unknown');
    expect(r.reason).toBe('timeout');
  });

  it('★ 작업 예산이 이미 지났다 → unknown. **요청을 보내지도 않는다**', async () => {
    const now = CACHED_FRESH;
    const h = harness({ now, fetchImpl: jsonFetch(200, loadJsonFixture('chzzkbot/followers/yes.json')) });
    const r = await h.checker.check(VIEWER, now, { deadlineAt: Date.now() - 1 });
    expect(r.verdict).toBe('unknown');
    expect(r.reason).toBe('timeout');
    expect(h.calls).toHaveLength(0);
  });

  it('★ 무응답 → AbortSignal 로 끊기고 unknown(timeout). §5.6.1 배선 검증', async () => {
    const now = CACHED_FRESH;
    const h = harness({ now, fetchImpl: hangFetch });
    // 남은 예산 50ms 가 회당 타임아웃(3초)보다 짧아 그쪽이 이긴다.
    const r = await h.checker.check(VIEWER, now, { deadlineAt: Date.now() + 50 });
    expect(r.verdict).toBe('unknown');
    expect(r.reason).toBe('timeout');
  });
});

describe('★★ 신선도 경계 — 149:59 통과 / 150:00 unknown', () => {
  function bodyWithAge(ms: number, now: number): Record<string, unknown> {
    return {
      channelId: OUR_CHANNEL,
      viewerChannelId: VIEWER,
      isFollower: true,
      everSynced: true,
      cachedAt: new Date(now - ms).toISOString(),
    };
  }

  it('149분 59초 → yes', async () => {
    const now = Date.parse('2026-09-06T19:00:00.000Z');
    const h = harness({ now, fetchImpl: jsonFetch(200, bodyWithAge(149 * 60_000 + 59_000, now)) });
    const r = await h.checker.check(VIEWER, now, {});
    expect(r.verdict).toBe('yes');
  });

  it('★ 정확히 150분 00초 → unknown(stale)', async () => {
    const now = Date.parse('2026-09-06T19:00:00.000Z');
    const h = harness({ now, fetchImpl: jsonFetch(200, bodyWithAge(150 * 60_000, now)) });
    const r = await h.checker.check(VIEWER, now, {});
    expect(r.verdict).toBe('unknown');
    expect(r.reason).toBe('stale');
  });

  it('미래 시각 스냅샷은 나이 0 으로 접는다 (시계가 뒤로 가도 stale 이 되지 않는다)', async () => {
    const now = Date.parse('2026-09-06T19:00:00.000Z');
    const h = harness({ now, fetchImpl: jsonFetch(200, bodyWithAge(-60_000, now)) });
    const r = await h.checker.check(VIEWER, now, {});
    expect(r.verdict).toBe('yes');
    expect(r.snapshotAgeSec).toBe(0);
  });
});

describe('★★ AD-2 재조회 — 정확히 1회, 절대 두 번이 아니다', () => {
  it('예약은 1회만 잡히고, 재조회 결과는 다시 예약하지 않는다', async () => {
    const now = CACHED_FRESH + 60_000;
    const h = harness({ now, fetchImpl: jsonFetch(200, loadJsonFixture('chzzkbot/followers/no.json')) });

    const first = await h.checker.check(VIEWER, now, {});
    expect(first.recheckAt).toBeDefined();

    // ★ lookup **전체**를 받는다. verdict 만 꺼내면 아래 recheckAt 단언을 쓸 수 없고,
    //   그러면 이 테스트가 주석으로 선언한 것을 한 번도 검사하지 않게 된다.
    const seen: FollowerLookup[] = [];
    expect(h.checker.scheduleRecheck(VIEWER, first, (r) => seen.push(r))).toBe(true);
    // ★ 같은 결과로 한 번 더 예약해도 잡히지 않는다
    expect(h.checker.scheduleRecheck(VIEWER, first, () => undefined)).toBe(false);

    h.clock.advance(30 * 60_000);
    await flush();

    expect(seen.map((r) => r.verdict)).toEqual(['no']);
    expect(h.checker.metrics.rechecks).toBe(1);
    // 최초 1회 + 재조회 1회 = 2. 인증 1건당 상류 호출이 최대 2회다.
    expect(h.checker.metrics.lookups).toBe(2);
    expect(h.calls).toHaveLength(2);

    // ★★ **여기가 AD-2 "정확히 1회" 의 구조적 근거다.**
    //   재조회가 만든 판정에는 `recheckAt` 이 실리지 않는다(`allowRecheck: false`).
    //   그래서 호출부가 그 결과로 다시 예약하려 해도 **예약할 값이 없다** —
    //   가드가 아니라 자료의 모양이 두 번째 예약을 막는다.
    //
    //   ⚠️ 이 단언이 없으면 `follower-check.ts` 의 `allowRecheck &&` 를 지워도
    //   스위트 전체가 녹색이다(변이로 확인됨). 그러면 콜백에서 재예약하도록
    //   배선을 바꾸는 순간 **상류에 무한 재조회 루프**가 걸린다 — §5.2 R1 이
    //   막으려는 증폭 그 자체다.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.recheckAt).toBeUndefined();

    h.clock.advance(60 * 60_000);
    await flush();
    expect(h.checker.metrics.rechecks).toBe(1);
    expect(h.calls).toHaveLength(2);
  });

  it('재조회가 yes 로 바뀌면 그 결과를 전달한다', async () => {
    const now = CACHED_FRESH + 60_000;
    let body: unknown = loadJsonFixture('chzzkbot/followers/no.json');
    const h = harness({
      now,
      fetchImpl: () =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    });

    const first = await h.checker.check(VIEWER, now, {});
    const seen: string[] = [];
    h.checker.scheduleRecheck(VIEWER, first, (r) => seen.push(r.verdict));

    // 재조회 시점에는 상류 캐시가 갱신돼 있다.
    body = {
      channelId: OUR_CHANNEL,
      viewerChannelId: VIEWER,
      isFollower: true,
      everSynced: true,
      cachedAt: new Date(first.recheckAt ?? now).toISOString(),
    };
    h.clock.advance(30 * 60_000);
    await flush();

    expect(seen).toEqual(['yes']);
  });

  it('예약 대상이 아닌 결과(recheckAt 없음)는 예약되지 않는다', async () => {
    const now = CACHED_FRESH + 60_000;
    const h = harness({ now, fetchImpl: jsonFetch(200, loadJsonFixture('chzzkbot/followers/yes.json')) });
    const r = await h.checker.check(VIEWER, now, {});
    expect(h.checker.scheduleRecheck(VIEWER, r, () => undefined)).toBe(false);
    expect(h.clock.pending).toBe(0);
  });

  it('dispose 가 예약을 전부 취소한다 (타이머 누수 없음)', async () => {
    const now = CACHED_FRESH + 60_000;
    const h = harness({ now, fetchImpl: jsonFetch(200, loadJsonFixture('chzzkbot/followers/no.json')) });
    const r = await h.checker.check(VIEWER, now, {});
    h.checker.scheduleRecheck(VIEWER, r, () => undefined);
    expect(h.clock.pending).toBe(1);
    h.checker.dispose();
    expect(h.clock.pending).toBe(0);
  });
});

describe('요청 모양 · 지표', () => {
  it('단건 경로를 부르고 x-chzzkbot-token 을 싣는다', async () => {
    const now = CACHED_FRESH;
    const h = harness({ now, fetchImpl: jsonFetch(200, loadJsonFixture('chzzkbot/followers/yes.json')) });
    await h.checker.check(VIEWER, now, {});
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.url).toBe(`http://127.0.0.1:8080/api/followers/${OUR_CHANNEL}/${VIEWER}`);
    expect(h.calls[0]?.token).toBe('x'.repeat(32));
    // ★ 목록도 ?channel= 도 없다 (R1)
    expect(h.calls[0]?.url).not.toContain('?');
  });

  it('follower_lookup_unknown_total{reason} 이 사유별로 갈린다', async () => {
    const now = Date.parse('2026-09-06T19:00:00.000Z');
    const h = harness({
      now,
      fetchImpl: jsonFetch(200, loadJsonFixture('chzzkbot/followers/stale-but-follower.json')),
    });
    await h.checker.check(VIEWER, now, {});
    await h.checker.check(VIEWER, now, {});
    expect(h.checker.metrics.unknownByReason.stale).toBe(2);
    expect(h.checker.metrics.unknownByReason['not-synced']).toBe(0);
    // follower_snapshot_age_sec — 안내에 싣는 값과 같은 값
    expect(h.checker.metrics.lastSnapshotAgeSec).toBe(240 * 60);
  });

  it("★ stuck-watch 'follower-stale' 은 **세기만 하고 경보하지 않는다** (armed:false)", async () => {
    const now = Date.parse('2026-09-06T19:00:00.000Z');
    const watch = createStuckWatch({
      specs: buildSpecs({
        confirmedStuckMs: 300_000,
        pollFailCount: 5,
        rssFailCount: 5,
        renewFailCount: 3,
        followerStaleCount: 1,
      }),
    });
    const alerts: unknown[] = [];
    const h = harness({
      now,
      fetchImpl: jsonFetch(200, loadJsonFixture('chzzkbot/followers/stale-but-follower.json')),
      onLookup: (l) => {
        const a = watch.observe('follower-stale', OUR_CHANNEL, l.reason === 'stale', now);
        if (a !== undefined) alerts.push(a);
      },
    });

    await h.checker.check(VIEWER, now, {});
    await h.checker.check(VIEWER, now, {});

    // 센다
    expect(watch.value('follower-stale', OUR_CHANNEL, now)).toBe(2);
    // ★ 그러나 발화하지 않는다 — S1-J 실측 전까지 경보를 켜지 않는다
    expect(alerts).toHaveLength(0);
  });
});
