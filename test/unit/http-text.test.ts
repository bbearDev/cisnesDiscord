import { describe, expect, it, vi } from 'vitest';

import {
  CALL_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT,
  createHttpBudget,
  type HttpBudget,
} from '../../src/runtime/http-budget.js';
import { createTextClient } from '../../src/youtube/http-text.js';

/**
 * 계획 §5.6.1 — 유튜브 아웃바운드도 **전역 예산 안에서** 돈다.
 *
 * ★★ 우리 유튜브 응답 둘은 JSON 이 아니다 — Atom XML 과 **본문 없는 202** 다.
 *   그래서 `budget.request` 에 `expect: 'text'` 를 실어 보낸다.
 *   이 파일이 고정하는 것은 ① XML·빈 본문이 텍스트로 나온다
 *   ② **JSON 호출은 영향받지 않는다** ③ `expect` 없이 부르면 그 사실이 드러난다, 셋이다.
 *
 * ★ 이전 설계는 composition-root 에서 `fetch` 를 감쌌는데, 그러면 **그 한 줄을
 *   빠뜨리는 순간 유튜브 호출이 전부 조용히 실패**한다. 부르는 쪽이 형식을 말하도록
 *   바꿔 빠뜨릴 자리를 없앴다 (§5.4 의 exit 78 재사용과 같은 교훈).
 */

function fetchOf(
  body: string,
  init: { status?: number; contentType?: string } = {},
): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(body, {
        status: init.status ?? 200,
        headers: init.contentType === undefined ? {} : { 'content-type': init.contentType },
      }),
    );
}

/** 204 처럼 본문을 가질 수 없는 응답 */
function nullBodyFetch(status: number, contentType?: string): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(null, {
        status,
        headers: contentType === undefined ? {} : { 'content-type': contentType },
      }),
    );
}

const XML = '<feed><entry><yt:videoId>V1</yt:videoId></entry></feed>';

describe("expect: 'text' — 비-JSON 응답 처리", () => {
  it('★ XML 본문이 텍스트 그대로 나온다', async () => {
    const budget = createHttpBudget({
      fetchImpl: fetchOf(XML, { contentType: 'application/atom+xml' }),
    });
    const r = await createTextClient(budget).request('rss-poll', 'https://x/feed');
    expect(r).toEqual({ ok: true, status: 200, text: XML });
  });

  it('★★ 본문 없는 202/204 에서 상태 코드를 왜곡하지 않는다', async () => {
    // ★ 허브의 정상 응답이 이 범위에 든다. 빈 본문은 빈 문자열이지 오류가 아니다.
    for (const status of [202, 204, 205, 304]) {
      const budget = createHttpBudget({ fetchImpl: nullBodyFetch(status) });
      const r = await createTextClient(budget).request('websub-subscribe', 'https://hub/');
      if (status < 300) {
        expect(r).toEqual({ ok: true, status, text: '' });
      } else {
        // 3xx 는 `res.ok` 가 false 다 — 상태가 보존되는지만 본다.
        expect(r).toMatchObject({ ok: false, kind: 'http', status });
      }
    }
  });

  it('★★ expect 를 안 준 호출은 여전히 JSON 으로 읽는다 — 기본값이 안전하다', async () => {
    const budget = createHttpBudget({
      fetchImpl: fetchOf('{"a":1}', { contentType: 'application/json; charset=utf-8' }),
    });
    const r = await budget.request<{ a: number }>('live-api', 'https://x/api');
    expect(r).toEqual({ ok: true, status: 200, body: { a: 1 } });
  });

  it('실패 응답의 본문이 그대로 진단에 실린다', async () => {
    const budget = createHttpBudget({ fetchImpl: fetchOf('허브가 거절했습니다', { status: 400 }) });
    const r = await createTextClient(budget).request('websub-subscribe', 'https://hub/');
    expect(r).toEqual({
      ok: false,
      kind: 'http',
      status: 400,
      detail: '허브가 거절했습니다',
    });
  });
});

describe('createTextClient — 실패 분류', () => {
  it("★ expect 없이 XML 을 부르면 bad-body 다 — expect:'text' 가 필요한 이유", async () => {
    // ★ 이것이 이 설계가 푸는 문제다. TextClient 를 거치면 expect 가 자동으로 실리므로
    //   이 실패는 **일어날 수 없다** — 아래 단언은 예산의 기본 동작을 고정할 뿐이다.
    const budget = createHttpBudget({ fetchImpl: fetchOf(XML) });
    const raw = await budget.request('rss-poll', 'https://x/feed');
    expect(raw.ok).toBe(false);
    expect(!raw.ok && raw.kind).toBe('bad-body');

    // 같은 예산이라도 TextClient 로 부르면 성공한다 — 빠뜨릴 자리가 없다.
    const viaClient = await createTextClient(budget).request('rss-poll', 'https://x/feed');
    expect(viaClient).toEqual({ ok: true, status: 200, text: XML });
  });

  it('네트워크 오류를 분류한다 — 던지지 않는다', async () => {
    const budget = createHttpBudget({
      fetchImpl: () => Promise.reject(new Error('ENOTFOUND www.youtube.com')),
    });
    const r = await createTextClient(budget).request('rss-poll', 'https://x/feed');
    expect(r).toMatchObject({ ok: false, kind: 'network' });
  });

  it('작업 전체 예산이 이미 지났으면 요청을 보내지 않는다', async () => {
    let calls = 0;
    const budget = createHttpBudget({
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(new Response(XML));
      },
      now: () => 10_000,
    });
    const r = await createTextClient(budget).request('rss-poll', 'https://x/feed', {
      deadlineAt: 9_999,
    });
    expect(r).toMatchObject({ ok: false, kind: 'budget' });
    expect(calls).toBe(0);
  });

  it('★ 전역 동시성 상한이 유튜브 호출에도 적용된다 (AC-P3 b)', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const budget = createHttpBudget({
      fetchImpl: async () => {
        await gate;
        return new Response(JSON.stringify(XML), { headers: { 'content-type': 'text/xml' } });
      },
    });
    const client = createTextClient(budget);
    const all = Array.from({ length: 20 }, () => client.request('rss-poll', 'https://x/feed'));
    await Promise.resolve();
    expect(budget.inFlight).toBeLessThanOrEqual(DEFAULT_MAX_CONCURRENT);
    release();
    await Promise.all(all);
    expect(budget.peakInFlight).toBeLessThanOrEqual(DEFAULT_MAX_CONCURRENT);
  });
});

describe('createTextClient — 남은 실패 분류', () => {
  it('회당 타임아웃을 분류하고 표의 값을 진단에 싣는다', async () => {
    // ★ 가짜 타이머를 쓴다. 실시간으로 재면 이 테스트 하나가 5초를 먹는다.
    vi.useFakeTimers();
    try {
      const hanging = ((_u: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener('abort', () => {
            rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        })) as unknown as typeof fetch;
      const budget = createHttpBudget({ fetchImpl: hanging });
      const p = createTextClient(budget).request('rss-poll', 'https://x/feed');
      await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS['rss-poll']);
      const r = await p;
      expect(!r.ok && r.kind).toBe('timeout');
      // ★ 값을 다시 적지 않고 표를 읽는다
      expect(!r.ok && r.detail).toContain(String(CALL_TIMEOUT_MS['rss-poll']));
    } finally {
      vi.useRealTimers();
    }
  });

  it("★ bad-body 카나리아 — expect 가 빠지면 여기가 켜져 원인을 말한다", async () => {
    // ★ `expect:'text'` 에서는 도달할 수 없는 분기라 실제 예산으로는 재현되지 않는다.
    //   그래서 예산을 스텁으로 바꿔 **카나리아가 실제로 말을 하는지**를 고정한다.
    //   이 분기를 지우면 나중에 누가 expect 를 없앴을 때 그 변경이 조용한 실패가 된다.
    const stub = {
      inFlight: 0,
      peakInFlight: 0,
      request: () =>
        Promise.resolve({ ok: false as const, kind: 'bad-body' as const, detail: 'Unexpected token <' }),
    };
    const budget: HttpBudget = stub;
    const r = await createTextClient(budget).request('rss-poll', 'https://x/');
    expect(!r.ok && r.kind).toBe('not-text');
    expect(!r.ok && r.detail).toContain("expect:'text'");
  });
});
