// 출처: chzzkbot src/chzzk/http-client.ts 의 AbortController · finally clearTimeout ·
//       Retry-After 우선 백오프 패턴 (계획 §14). 상류의 스로틀·토큰 계층은 우리에게
//       없으므로 가져오지 않았다 — 우리 요구는 §5.6.1 의 전역 규칙 하나다.
/**
 * 전역 아웃바운드 예산 — 계획 §5.6.1 (FM2).
 *
 * ★ 왜 이 모듈이 있는가.
 *   rev.2 전체에서 명시된 타임아웃은 **디스코드 발송기 3초 하나뿐**이었다.
 *   팔로워 조회 · `GET /api/live` · RSS 폴 · WebSub 구독 · OAuth 교환에 전부 없었다.
 *   **단일 이벤트 루프(D1)에서 하나가 응답 없이 매달리면 그 요청이 무기한 루프에 남는다.**
 *
 * ★★ **예산 초과는 실패가 아니라 `unknown` 이다.**
 *   §3-a 의 직접 적용 — "모른다"는 2위이고, 시간이 없어서 못 봤다는 이유로
 *   "미팔로우"·"방송 종료"를 단정하면 3위(틀리게 보내기)로 떨어진다.
 *   그래서 이 모듈은 **절대 throw 하지 않고** 결과를 판별 유니온으로 돌려준다.
 *
 * ★ `clearTimeout` 을 `finally` 에서 반드시 부른다.
 *   chzzkbot 이 같은 함정을 두 번 적어뒀다(`discord-webhook.ts`, `live-event-notifier.ts`):
 *   *"clearTimeout 을 빠뜨리면 타이머가 이벤트 루프를 붙잡아 종료가 발송마다
 *   최대 timeoutMs 씩 늦어진다."*
 */

/**
 * 호출 종류 — 지표 `outbound_timeout_total{call}` 의 라벨이자 타임아웃 표의 키.
 *
 * ★ 문자열 유니온이라 오타가 컴파일에 걸린다. 특정 호출만 타임아웃이 치솟으면
 *   그 상류가 병들고 있다는 뜻이라, 라벨이 갈리면 그 신호를 잃는다.
 */
export type OutboundCall =
  /** chzzkbot 팔로워 단건 조회 — 3초 */
  | 'follower-lookup'
  /** `GET /api/live` — 3초. cisnesDiscord 가 chzzkbot 을 부르는 유일한 아웃바운드 */
  | 'live-api'
  /** 치지직 OAuth 토큰 교환 — 5초 */
  | 'oauth-token'
  /** 치지직 `users/me` — 5초 */
  | 'users-me'
  /** 치지직 토큰 revoke — 5초. fire-and-forget 이지만 매달리면 안 된다 */
  | 'oauth-revoke'
  /** RSS 폴 1건 — 5초 */
  | 'rss-poll'
  /** WebSub 구독·갱신 — 5초 */
  | 'websub-subscribe';

/** §5.6.1 표의 "회당 타임아웃". **여기서만 정의한다** */
export const CALL_TIMEOUT_MS: Readonly<Record<OutboundCall, number>> = {
  'follower-lookup': 3_000,
  'live-api': 3_000,
  'oauth-token': 5_000,
  'users-me': 5_000,
  'oauth-revoke': 5_000,
  'rss-poll': 5_000,
  'websub-subscribe': 5_000,
};

/**
 * 전역 동시성 기본 상한.
 *
 * ⚠️ `auth.maxConcurrentFlows`(8, §5.6.2)와 **다른 것이다.** 저쪽은 `/인증` **진입**
 *   동시 상한이고 이쪽은 **나가는 HTTP** 동시 상한이다. 값이 같아 혼동하기 쉬우므로
 *   이름으로 구분한다. **AC-P3 (b) 의 합격 임계가 이 값이다.**
 */
export const DEFAULT_MAX_CONCURRENT = 8;

/** 429 지수 백오프 1s → 2s → 4s → 8s */
export const RETRY_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];
export const DEFAULT_MAX_RETRIES = 3;

export type OutboundResult<T> =
  | { ok: true; status: number; body: T }
  /** 요청은 나갔고 실패 응답을 받았다 */
  | { ok: false; kind: 'http'; status: number; bodyText: string; retried: number }
  /** 회당 타임아웃 초과 — `unknown` 으로 접어야 한다 */
  | { ok: false; kind: 'timeout'; retried: number }
  /** 작업 전체 예산 초과 — 요청을 보내지도 못했거나 중간에 끊겼다 */
  | { ok: false; kind: 'budget' }
  /** 네트워크·DNS·연결 거부 */
  | { ok: false; kind: 'network'; detail: string; retried: number }
  /** 응답은 왔으나 본문이 JSON 이 아니다 */
  | { ok: false; kind: 'bad-body'; detail: string };

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  /**
   * 작업 전체 예산의 **마감 시각**(epoch ms). §5.6.1 의 "작업 전체 예산" 열이다.
   *
   * ★ 남은 시간과 회당 타임아웃 중 **짧은 쪽**이 실제 타임아웃이 된다.
   *   인증 왕복 10초 예산에서 이미 8초를 썼다면 `users-me` 는 5초가 아니라 2초다.
   */
  deadlineAt?: number;
  maxRetries?: number;
  /**
   * 성공 본문을 어떻게 읽을 것인가. 기본 `'json'`.
   *
   * ★ 왜 옵션이 필요한가. **우리 아웃바운드가 전부 JSON 이 아니다** —
   *   RSS 피드는 Atom XML 이고, WebSub 허브의 구독 응답은 **본문이 비어 있는 202** 다.
   *   무조건 `JSON.parse` 하면 둘 다 `bad-body` 로 떨어져
   *   *"허브가 거절했다"* 와 *"받아줬는데 JSON 이 아니다"* 를 구분할 수 없다.
   *
   * ★★ 이것을 호출 지점의 인자로 두는 이유: 대안은 composition-root 에서 `fetch` 를
   *   감싸 두는 것인데, 그러면 **그 한 줄을 빠뜨리는 순간 유튜브 호출이 전부 조용히
   *   실패한다.** 계획이 exit 78 을 재사용하며 피한 것과 같은 종류의 함정이다
   *   (§5.4 — *"목록을 고쳐야 하는 설계였다면 그 한 줄을 빠뜨리는 순간…"*).
   *   여기서는 **부르는 쪽이 자기 응답 형식을 말하므로 빠뜨릴 자리가 없다.**
   *
   * - `'json'` — `JSON.parse` 한 값. 실패하면 `bad-body`
   * - `'text'` — 원문 문자열 그대로. 빈 본문이면 빈 문자열 (202 가 정상인 경로용)
   */
  expect?: 'json' | 'text';
}

export interface HttpBudget {
  request<T = unknown>(
    call: OutboundCall,
    url: string,
    opts?: RequestOptions,
  ): Promise<OutboundResult<T>>;
  /** 지금 나가 있는 요청 수. **AC-P3 (b) 가 이 값을 관측한다** */
  readonly inFlight: number;
  /** 동시에 관측된 최대치. 테스트가 상한 준수를 단언한다 */
  readonly peakInFlight: number;
}

export interface HttpBudgetOptions {
  maxConcurrent?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 지표 `outbound_timeout_total{call}` */
  onTimeout?: (call: OutboundCall) => void;
  /** 지표 — 호출 왕복 시간 (`follower_lookup_ms` 등) */
  onLatency?: (call: OutboundCall, ms: number) => void;
}

/**
 * 아주 작은 세마포어.
 *
 * ★ 라이브러리를 쓰지 않는 이유: 필요한 것이 "N개까지 통과, 나머지는 FIFO 대기"
 *   하나뿐이고, 이 정도를 위해 의존성을 늘리면 §5.6.1 이 막으려는 것과 무관한
 *   공급망 위험만 는다.
 */
function createSemaphore(limit: number): {
  acquire: () => Promise<void>;
  release: () => void;
  readonly held: number;
} {
  let held = 0;
  const queue: (() => void)[] = [];
  return {
    async acquire(): Promise<void> {
      if (held < limit) {
        held += 1;
        return;
      }
      await new Promise<void>((resolve) => queue.push(resolve));
      held += 1;
    },
    release(): void {
      held -= 1;
      const next = queue.shift();
      if (next !== undefined) next();
    },
    get held() {
      return held;
    },
  };
}

export function createHttpBudget(opts: HttpBudgetOptions = {}): HttpBudget {
  const limit = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? ((): number => Date.now());
  const sleep =
    opts.sleep ??
    ((ms: number): Promise<void> =>
      new Promise((r) => {
        // ★ unref. 종료 중에 남은 백오프 타이머가 프로세스를 붙잡으면 안 된다.
        const t = setTimeout(r, ms);
        if (typeof t === 'object' && 'unref' in t) t.unref();
      }));
  const sem = createSemaphore(limit);
  let peak = 0;

  /** 한 번 나갔다 온다. 타임아웃과 `clearTimeout` 이 여기 산다 */
  async function once<T>(
    call: OutboundCall,
    url: string,
    o: RequestOptions,
    budgetMs: number,
  ): Promise<OutboundResult<T> | { retryAfterMs: number }> {
    const ac = new AbortController();
    const timer = setTimeout(() => {
      ac.abort();
    }, budgetMs);
    const started = now();
    try {
      const res = await doFetch(url, {
        method: o.method ?? 'GET',
        ...(o.headers === undefined ? {} : { headers: o.headers }),
        ...(o.body === undefined ? {} : { body: o.body }),
        signal: ac.signal,
      });

      // ★ 429 는 서버가 말한 시각을 백오프보다 **우선**한다 (§5.6.1).
      if (res.status === 429) {
        const ra = res.headers.get('retry-after');
        const secs = ra === null ? NaN : Number(ra);
        return { retryAfterMs: Number.isFinite(secs) ? secs * 1_000 : -1 };
      }

      const text = await res.text();
      if (!res.ok) {
        return { ok: false, kind: 'http', status: res.status, bodyText: text, retried: 0 };
      }
      // ★ 본문 없는 202 도 여기로 온다 — `'text'` 면 빈 문자열이 정상 결과다.
      if (o.expect === 'text') {
        return { ok: true, status: res.status, body: text as T };
      }
      try {
        return { ok: true, status: res.status, body: JSON.parse(text) as T };
      } catch (e: unknown) {
        return { ok: false, kind: 'bad-body', detail: e instanceof Error ? e.message : String(e) };
      }
    } catch (e: unknown) {
      // AbortError 는 타임아웃이다. 그 외는 네트워크.
      if (ac.signal.aborted) {
        opts.onTimeout?.(call);
        return { ok: false, kind: 'timeout', retried: 0 };
      }
      return {
        ok: false,
        kind: 'network',
        detail: e instanceof Error ? e.message : String(e),
        retried: 0,
      };
    } finally {
      // ★★ 빠뜨리면 타이머가 이벤트 루프를 붙잡는다. 반드시 finally 다.
      clearTimeout(timer);
      opts.onLatency?.(call, now() - started);
    }
  }

  return {
    get inFlight() {
      return sem.held;
    },
    get peakInFlight() {
      return peak;
    },

    async request<T = unknown>(
      call: OutboundCall,
      url: string,
      o: RequestOptions = {},
    ): Promise<OutboundResult<T>> {
      const maxRetries = o.maxRetries ?? DEFAULT_MAX_RETRIES;
      await sem.acquire();
      if (sem.held > peak) peak = sem.held;
      try {
        let retried = 0;
        for (;;) {
          // 회당 타임아웃과 남은 작업 예산 중 **짧은 쪽**을 쓴다.
          const perCall = CALL_TIMEOUT_MS[call];
          const remaining = o.deadlineAt === undefined ? perCall : o.deadlineAt - now();
          if (remaining <= 0) return { ok: false, kind: 'budget' };
          const budgetMs = Math.min(perCall, remaining);

          const r = await once<T>(call, url, o, budgetMs);
          if (!('retryAfterMs' in r)) {
            return 'retried' in r ? { ...r, retried } : r;
          }

          // ── 429 경로 ──────────────────────────────────────────────
          if (retried >= maxRetries) {
            return { ok: false, kind: 'http', status: 429, bodyText: '', retried };
          }
          const backoff = RETRY_BACKOFF_MS[Math.min(retried, RETRY_BACKOFF_MS.length - 1)] ?? 1_000;
          const waitMs = r.retryAfterMs >= 0 ? r.retryAfterMs : backoff;
          // ★ 기다리면 예산을 넘기는 경우, 자고 나서 실패하지 말고 **지금 접는다.**
          //   자고 일어나 예산 초과를 확인하는 것은 그 시간만큼 루프를 붙잡는 낭비다.
          if (o.deadlineAt !== undefined && now() + waitMs >= o.deadlineAt) {
            return { ok: false, kind: 'budget' };
          }
          await sleep(waitMs);
          retried += 1;
        }
      } finally {
        sem.release();
      }
    },
  };
}
