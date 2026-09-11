import { describe, expect, it, vi } from 'vitest';

import {
  CALL_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT,
  createHttpBudget,
} from '../../src/runtime/http-budget.js';
import type { OutboundCall } from '../../src/runtime/http-budget.js';

/**
 * 아웃바운드 예산 배선 — 계획 §9.2 가 지목한 검증.
 *
 * ★ 이 계층이 없으면 무엇이 깨지는가 (§5.6.1 FM2).
 *   단일 이벤트 루프에서 아웃바운드 하나가 응답 없이 매달리면 그 요청이 무기한
 *   루프에 남는다. rev.2 전체에서 명시된 타임아웃은 디스코드 발송기 3초 하나뿐이었다.
 *
 * ★★ **예산 초과는 실패가 아니라 `unknown` 이다** (§3-a).
 *   시간이 없어 못 봤다는 이유로 "미팔로우"·"방송 종료"를 단정하면 3위로 떨어진다.
 */

const ALL_CALLS = Object.keys(CALL_TIMEOUT_MS) as OutboundCall[];

/** 응답을 영영 주지 않는 fetch. abort 될 때만 거부한다 */
function hangingFetch(): typeof fetch {
  return ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    })) as unknown as typeof fetch;
}

function okFetch(delayMs = 0): typeof fetch {
  return async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  };
}

describe('§5.6.1 표 — 호출별 타임아웃이 실제로 걸린다', () => {
  it.each(ALL_CALLS)('%s 는 AbortSignal 을 걸고 표의 값에서 끊는다', async (call) => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const b = createHttpBudget({ fetchImpl: hangingFetch(), onTimeout });
      const p = b.request(call, 'http://x/');

      // 표의 값 **직전**에는 아직 끊기지 않았다
      await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS[call] - 1);
      expect(onTimeout).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      const r = await p;
      expect(r.ok).toBe(false);
      expect(!r.ok && r.kind).toBe('timeout');
      expect(onTimeout).toHaveBeenCalledWith(call);
    } finally {
      vi.useRealTimers();
    }
  });

  it('팔로워 조회와 /api/live 는 3초, 나머지는 5초다', () => {
    // ★ 값을 여기 다시 적지 않고 표를 읽는다 — 복제가 7분/8분 사고의 원인이었다.
    expect(CALL_TIMEOUT_MS['follower-lookup']).toBe(3_000);
    expect(CALL_TIMEOUT_MS['live-api']).toBe(3_000);
    expect(CALL_TIMEOUT_MS['oauth-token']).toBe(5_000);
    expect(CALL_TIMEOUT_MS['users-me']).toBe(5_000);
    expect(CALL_TIMEOUT_MS['rss-poll']).toBe(5_000);
    // ★ 5초에서 올렸다 — 하루치 실측에서 411건 타임아웃 / 3건 성공이었다.
    expect(CALL_TIMEOUT_MS['websub-subscribe']).toBe(15_000);
  });
});

describe('★ clearTimeout 을 finally 에서 부른다 — 타이머 누수 검출', () => {
  /**
   * 누수하면 무엇이 나빠지는가: chzzkbot 이 같은 함정을 두 번 적어뒀다 —
   * *"clearTimeout 을 빠뜨리면 타이머가 이벤트 루프를 붙잡아 종료가 발송마다
   * 최대 timeoutMs 씩 늦어진다."* 즉 증상이 **종료 지연**이라 기능 테스트로는 안 잡힌다.
   */
  it('성공한 요청은 살아 있는 타이머를 남기지 않는다', async () => {
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const b = createHttpBudget({ fetchImpl: okFetch() });
    for (let i = 0; i < 20; i++) {
      const r = await b.request('live-api', 'http://x/');
      expect(r.ok).toBe(true);
    }
    const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    // 20건을 돌렸는데 타이머가 쌓여 있으면 clearTimeout 이 빠진 것이다.
    expect(after - before).toBeLessThanOrEqual(1);
  });

  it('실패(네트워크 오류)한 요청도 타이머를 남기지 않는다', async () => {
    const boom = ((): Promise<Response> =>
      Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const b = createHttpBudget({ fetchImpl: boom });
    for (let i = 0; i < 20; i++) {
      const r = await b.request('live-api', 'http://x/');
      expect(!r.ok && r.kind).toBe('network');
    }
    const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    expect(after - before).toBeLessThanOrEqual(1);
  });
});

describe('★ 전역 동시성 상한 — AC-P3 (b) 의 합격 임계', () => {
  it('동시 20건을 넣어도 나가 있는 요청이 8을 넘지 않는다', async () => {
    let live = 0;
    let peak = 0;
    const counting = (async (): Promise<Response> => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    }) as unknown as typeof fetch;

    const b = createHttpBudget({ fetchImpl: counting });
    await Promise.all(Array.from({ length: 20 }, () => b.request('live-api', 'http://x/')));

    expect(peak).toBeLessThanOrEqual(DEFAULT_MAX_CONCURRENT);
    expect(b.peakInFlight).toBeLessThanOrEqual(DEFAULT_MAX_CONCURRENT);
    // 상한이 실제로 걸렸는지 — 20건이 전부 동시였다면 이 단언이 무의미해진다
    expect(peak).toBeGreaterThan(1);
  });

  it('모든 호출 종류가 같은 상한을 나눠 쓴다', async () => {
    // ★ 종류별로 상한을 따로 두면 합이 8을 넘는다. §5.6.1 은 **전 아웃바운드**가
    //   하나를 나눠 쓴다고 규정했다.
    let live = 0;
    let peak = 0;
    const counting = (async (): Promise<Response> => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    }) as unknown as typeof fetch;

    const b = createHttpBudget({ fetchImpl: counting });
    await Promise.all(ALL_CALLS.flatMap((c) => [0, 1, 2].map(() => b.request(c, 'http://x/'))));
    expect(peak).toBeLessThanOrEqual(DEFAULT_MAX_CONCURRENT);
  });

  it('상한에 걸려 대기하다가도 전부 완료된다 — 굶지 않는다', async () => {
    const b = createHttpBudget({ fetchImpl: okFetch(1) });
    const rs = await Promise.all(
      Array.from({ length: 30 }, () => b.request('rss-poll', 'http://x/')),
    );
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(b.inFlight).toBe(0);
  });
});

describe('429 — Retry-After 가 백오프를 이긴다', () => {
  it('Retry-After 헤더가 있으면 그 값을 쓴다', async () => {
    let calls = 0;
    const slept: number[] = [];
    const rl = ((): Promise<Response> => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? new Response('', { status: 429, headers: { 'retry-after': '2' } })
          : new Response(JSON.stringify({ ok: 1 }), { status: 200 }),
      );
    }) as unknown as typeof fetch;

    const b = createHttpBudget({
      fetchImpl: rl,
      sleep: (ms): Promise<void> => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    const r = await b.request('rss-poll', 'http://x/');
    expect(r.ok).toBe(true);
    // 백오프 1단계는 1000ms 인데 헤더가 2초라 했으므로 2000 이어야 한다
    expect(slept).toEqual([2_000]);
  });

  it('Retry-After 가 없으면 지수 백오프 1s → 2s → 4s 를 쓴다', async () => {
    const slept: number[] = [];
    const always429 = ((): Promise<Response> =>
      Promise.resolve(new Response('', { status: 429 }))) as unknown as typeof fetch;
    const b = createHttpBudget({
      fetchImpl: always429,
      sleep: (ms): Promise<void> => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    const r = await b.request('rss-poll', 'http://x/');
    expect(!r.ok && r.kind === 'http' && r.status).toBe(429);
    expect(slept).toEqual([1_000, 2_000, 4_000]);
  });

  it('Retry-After 가 숫자가 아니면 백오프로 되돌아간다', async () => {
    const slept: number[] = [];
    const weird = ((): Promise<Response> =>
      Promise.resolve(
        new Response('', {
          status: 429,
          headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
        }),
      )) as unknown as typeof fetch;
    const b = createHttpBudget({
      fetchImpl: weird,
      sleep: (ms): Promise<void> => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    await b.request('rss-poll', 'http://x/');
    expect(slept[0]).toBe(1_000);
  });
});

describe('★ 작업 전체 예산 — 초과는 실패가 아니라 budget 이다', () => {
  it('마감이 이미 지났으면 요청을 보내지 않고 budget 을 준다', async () => {
    const spy = vi.fn(okFetch());
    const b = createHttpBudget({ fetchImpl: spy as unknown as typeof fetch });
    const r = await b.request('users-me', 'http://x/', { deadlineAt: Date.now() - 1 });
    expect(!r.ok && r.kind).toBe('budget');
    expect(spy).not.toHaveBeenCalled();
  });

  it('남은 예산이 회당 타임아웃보다 짧으면 짧은 쪽을 쓴다', async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const b = createHttpBudget({ fetchImpl: hangingFetch(), onTimeout });
      // users-me 는 표에서 5초지만 남은 예산이 2초다
      const p = b.request('users-me', 'http://x/', { deadlineAt: Date.now() + 2_000 });
      await vi.advanceTimersByTimeAsync(2_000);
      const r = await p;
      expect(!r.ok && r.kind).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('백오프가 예산을 넘기면 자지 않고 즉시 접는다', async () => {
    // ★ 자고 일어나 예산 초과를 확인하는 것은 그 시간만큼 루프를 붙잡는 낭비다.
    const always429 = ((): Promise<Response> =>
      Promise.resolve(
        new Response('', { status: 429, headers: { 'retry-after': '2' } }),
      )) as unknown as typeof fetch;
    const b = createHttpBudget({
      fetchImpl: always429,
      sleep: (): Promise<void> => Promise.reject(new Error('자면 안 된다')),
    });
    const r = await b.request('rss-poll', 'http://x/', { deadlineAt: Date.now() + 500 });
    expect(!r.ok && r.kind).toBe('budget');
  });
});

describe('절대 throw 하지 않는다 (Principle 2)', () => {
  it('fetch 가 던져도 결과로 돌려준다', async () => {
    const boom = ((): Promise<Response> =>
      Promise.reject(new Error('DNS 실패'))) as unknown as typeof fetch;
    const b = createHttpBudget({ fetchImpl: boom });
    const r = await b.request('live-api', 'http://x/');
    expect(!r.ok && r.kind).toBe('network');
    expect(!r.ok && r.kind === 'network' && r.detail).toContain('DNS');
  });

  // ⚠️ 결과 종류는 `bad-body` 다. 계획의 지표 라벨
  //    `follower_lookup_unknown_total{reason='bad-shape'}` 와 **다른 것**이다 —
  //    저쪽은 팔로워 판정표 0-b(응답 형태 불량)의 사유 라벨이고, 이쪽은 HTTP 결과 종류다.
  it('본문이 JSON 이 아니면 bad-body 로 돌려준다 — 파싱 예외가 새지 않는다', async () => {
    const html = ((): Promise<Response> =>
      Promise.resolve(
        new Response('<html>502 Bad Gateway</html>', { status: 200 }),
      )) as unknown as typeof fetch;
    const b = createHttpBudget({ fetchImpl: html });
    const r = await b.request('live-api', 'http://x/');
    expect(!r.ok && r.kind).toBe('bad-body');
  });

  it('4xx/5xx 는 본문과 함께 http 로 돌려준다', async () => {
    const e401 = ((): Promise<Response> =>
      Promise.resolve(new Response('unauthorized', { status: 401 }))) as unknown as typeof fetch;
    const b = createHttpBudget({ fetchImpl: e401 });
    const r = await b.request('live-api', 'http://x/');
    expect(!r.ok && r.kind === 'http' && r.status).toBe(401);
  });
});

describe("expect — 본문을 어떻게 읽는가", () => {
  it('기본은 json 이다 (안전한 기본값)', async () => {
    const b = createHttpBudget({ fetchImpl: okFetch() });
    const r = await b.request<{ ok: number }>('live-api', 'http://x/');
    expect(r.ok && r.body).toEqual({ ok: 1 });
  });

  it("expect:'text' 는 원문 문자열을 그대로 준다 — XML 이 bad-body 로 떨어지지 않는다", async () => {
    const xml = '<feed><entry/></feed>';
    const f = ((): Promise<Response> =>
      Promise.resolve(new Response(xml, { status: 200 }))) as unknown as typeof fetch;
    const b = createHttpBudget({ fetchImpl: f });
    const r = await b.request<string>('rss-poll', 'http://x/', { expect: 'text' });
    expect(r.ok && r.body).toBe(xml);
  });

  it("★ expect:'text' 는 본문 없는 202 를 빈 문자열로 준다 — 허브의 정상 응답이다", async () => {
    // WebSub 은 비동기 검증이라 허브가 POST 에 202 만 준다. 그것을 오류로 읽으면
    // 정상 구독이 매번 실패로 기록된다.
    const f = ((): Promise<Response> =>
      Promise.resolve(new Response(null, { status: 202 }))) as unknown as typeof fetch;
    const b = createHttpBudget({ fetchImpl: f });
    const r = await b.request<string>('websub-subscribe', 'http://hub/', { expect: 'text' });
    expect(r).toEqual({ ok: true, status: 202, body: '' });
  });

  it("expect:'text' 여도 4xx 는 http 로 분류된다 — 성공으로 삼키지 않는다", async () => {
    const f = ((): Promise<Response> =>
      Promise.resolve(new Response('거절', { status: 400 }))) as unknown as typeof fetch;
    const b = createHttpBudget({ fetchImpl: f });
    const r = await b.request<string>('websub-subscribe', 'http://hub/', { expect: 'text' });
    expect(!r.ok && r.kind === 'http' && r.status).toBe(400);
  });
});
