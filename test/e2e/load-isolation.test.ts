import { describe, expect, it } from 'vitest';

import { DEFAULT_MAX_CONCURRENT } from '../../src/runtime/http-budget.js';
import { CHZZKBOT_WEBHOOK_PATH } from '../../src/web/routes/chzzkbot-webhook.js';
import { SIS, WEBHOOK_TOKEN, boot, flush } from '../helpers/app-harness.js';

/**
 * ★★ AC-P3 — FM1 부하 격리 (계획 §9.3 · §5.6.1).
 *
 * ## 무엇이 무서운가
 *
 * `/인증` 은 길드 멤버 누구나 누를 수 있고, 초대 링크가 새면 30명이 동시에 누른다
 * (§10 시나리오 3-b). 그 팬아웃이 그대로 상류로 나가면 **단일 이벤트 루프(D1)** 가
 * 상류 응답을 기다리는 요청으로 가득 찬다. 그러면 인증만 느려지는 게 아니라
 * **디스코드 게이트웨이가 흔들리고**, 그 흔들림이 다시 부하를 만든다.
 *
 * ## 세 축을 함께 본다
 *
 * (a) 게이트웨이 **재연결 0건** — 부하가 본체를 흔들지 않았다
 * (b) 아웃바운드 **in-flight ≤ `http.maxConcurrent`(8)** — 팬아웃이 상한에 걸렸다
 * (c) 각 조회가 **예산 안에 종결** — 상한이 굶김으로 바뀌지 않았다
 *
 * ★ (b) 만 보면 "8개씩 아주 천천히" 도 통과하고, (c) 만 보면 "전부 동시에 쏴서 빠르게" 도
 *   통과한다. 셋을 같이 봐야 상한이 제 일을 한다는 뜻이 된다.
 *
 * ## ★★ (a) 는 한 번 **구조적으로 통과할 수밖에 없는** 상태였다
 *
 * 초판은 게이트웨이를 이 테스트 안에서 따로 만들고 **부하 경로에 연결하지 않았다.**
 * 그러니 `reconnectCount` 가 0인 것은 *"부하가 본체를 흔들지 않았다"* 의 증거가 아니라
 * **"계기가 꽂혀 있지 않다"** 의 결과였다.
 *
 * → 지금은 **앱이 실제로 쓰는 게이트웨이**(`app.gateway`)를 재고, 부하 구간 동안
 *   그 게이트웨이가 **실제로 발송을 했는지**(`fake.sent.length > 0`)를 함께 단언한다.
 *   그 한 줄이 "0건" 을 **살아 있는 계기의 0건**으로 만든다.
 */

const UPSTREAM_DELAY_MS = 300;
const BUDGET_MS = 10_000;
const VIEWERS = 10;
const VIEWER_ID = (i: number): string => `viewer${String(i).padStart(2, '0')}`.padEnd(32, '0');

/** 우리 두 상류 호출을 전부 300ms 늦춰 답하는 fetch */
function delayedUpstream(counters: { inFlight: number; peak: number }): typeof fetch {
  return async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    counters.inFlight += 1;
    counters.peak = Math.max(counters.peak, counters.inFlight);
    await new Promise((r) => setTimeout(r, UPSTREAM_DELAY_MS));
    counters.inFlight -= 1;

    const body = url.includes('/api/followers/')
      ? { channelId: SIS, isFollower: true, everSynced: true, cachedAt: new Date().toISOString() }
      : {
          version: 1,
          generatedAt: new Date().toISOString(),
          channels: [
            { channelId: SIS, live: false, confirmed: false, exact: false, status: 'running' },
          ],
        };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function webhookBody(hash: string): string {
  return JSON.stringify({
    event: 'live.started',
    version: 1,
    channelId: SIS,
    channelName: '시스네',
    openDate: '2026-09-07 03:56:39',
    openedAt: '2026-09-06T18:56:39.000Z',
    liveHash: hash,
    detectedAt: '2026-09-06T18:57:31.000Z',
  });
}

describe('AC-P3 — 동시 10건 + 상류 300ms 지연', () => {
  it('★★ (a) 재연결 0건 (살아 있는 게이트웨이 기준) · (b) in-flight ≤ 8 · (c) 예산 내 종결', async () => {
    const counters = { inFlight: 0, peak: 0 };
    const { app, fake } = await boot(() => undefined, {
      fetchImpl: delayedUpstream(counters),
    });

    const reconnectsBefore = app.gateway.reconnectCount;
    const startedAt = Date.now();

    // 부하 구간: 팔로워 조회 10건 **과 동시에** 게이트웨이도 실제로 일하게 한다.
    // ★ 게이트웨이가 놀고 있으면 "재연결 0건" 은 아무 뜻이 없다.
    const lookups = Array.from({ length: VIEWERS }, (_, i) =>
      app.followers
        .check(VIEWER_ID(i), startedAt, { deadlineAt: startedAt + BUDGET_MS })
        .then((lookup) => ({ lookup, elapsed: Date.now() - startedAt })),
    );
    const posts = ['aaaa1111', 'bbbb2222', 'cccc3333'].map((hash) =>
      fetch(`${app.baseUrl}${CHZZKBOT_WEBHOOK_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-chzzkbot-token': WEBHOOK_TOKEN },
        body: webhookBody(hash),
      }),
    );

    const [results, responses] = await Promise.all([Promise.all(lookups), Promise.all(posts)]);
    await flush();
    const totalElapsed = Date.now() - startedAt;

    // ── ★★ 계기가 꽂혀 있는지 먼저 확인한다 ──────────────────────
    //    이 두 줄이 없으면 아래 (a) 는 "게이트웨이가 논다" 로도 통과한다.
    expect(responses.every((r) => r.status < 300)).toBe(true);
    expect(fake.sent.length).toBeGreaterThan(0);

    // ── (a) 살아서 발송까지 한 게이트웨이의 재연결이 0건이다 ──────
    expect(app.gateway.reconnectCount - reconnectsBefore).toBe(0);

    // ── (b) 아웃바운드 in-flight 가 상한을 넘지 않았다 ────────────
    expect(counters.peak).toBeLessThanOrEqual(DEFAULT_MAX_CONCURRENT);
    expect(app.http.peakInFlight).toBeLessThanOrEqual(DEFAULT_MAX_CONCURRENT);
    // ★ 반공허 가드 — 10건이 우연히 순차로 흘렀다면 위 단언이 공짜로 통과한다
    expect(counters.peak).toBeGreaterThan(1);

    // ── (c) 각 조회가 예산 안에 끝났다 ───────────────────────────
    for (const r of results) {
      expect(r.elapsed).toBeLessThan(BUDGET_MS);
      // 예산 초과로 접히지 않았다 — 상한이 굶김으로 바뀌면 여기가 unknown 이 된다
      expect(r.lookup.verdict).toBe('yes');
    }
    expect(totalElapsed).toBeLessThan(BUDGET_MS);

    // ── 증폭 계수 1 — 조회 10건에 상류 호출 10회 (§5.2-b R1) ─────
    expect(app.followers.metrics.lookups).toBe(VIEWERS);

    // ⚠️ 범위: 여기서 재는 것은 **팔로워 조회** 예산이다. OAuth 왕복 전체
    //    (교환 → users/me → 팔로워)는 `test/e2e/auth-flow.test.ts` 가 단건으로 덮는다.
    //    이 파일이 책임지는 것은 **동시 부하에서의 격리**다.
  }, 30_000);

  it('★ 상한 때문에 굶지 않는다 — 30건을 넣어도 전부 완주한다', async () => {
    const counters = { inFlight: 0, peak: 0 };
    const { app } = await boot(() => undefined, { fetchImpl: delayedUpstream(counters) });

    const now = Date.now();
    const out = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        app.followers.check(VIEWER_ID(i), now, { deadlineAt: now + BUDGET_MS }),
      ),
    );

    // 전부 판정이 났다 — 대기열에서 잊히는 요청이 없다
    expect(out).toHaveLength(30);
    expect(out.every((r) => r.verdict === 'yes')).toBe(true);
    expect(app.http.inFlight).toBe(0);
    expect(counters.peak).toBeLessThanOrEqual(DEFAULT_MAX_CONCURRENT);
    expect(counters.peak).toBeGreaterThan(1);
  }, 30_000);
});
