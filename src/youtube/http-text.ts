import {
  CALL_TIMEOUT_MS,
  type HttpBudget,
  type OutboundCall,
  type RequestOptions,
} from '../runtime/http-budget.js';

/**
 * 텍스트 응답 클라이언트 — 유튜브 아웃바운드 전용 얇은 층.
 *
 * ★ 왜 필요한가. **우리 유튜브 아웃바운드는 JSON 이 아니다** — RSS 피드는 Atom XML 이고,
 *   WebSub 허브의 구독 응답은 **본문이 비어 있는 202** 다.
 *
 * ★★ 그래서 `budget.request` 에 `expect: 'text'` 를 실어 보낸다.
 *   대안은 composition-root 에서 `fetch` 를 감싸 두는 것이었는데, 그러면
 *   **그 한 줄을 빠뜨리는 순간 유튜브 호출이 전부 조용히 실패한다.**
 *   계획이 exit 78 을 재사용하며 피한 것과 같은 종류의 함정이다 (§5.4) —
 *   *"목록을 고쳐야 하는 설계였다면 그 한 줄을 빠뜨리는 순간 결함이 되살아난다."*
 *   부르는 쪽이 자기 응답 형식을 말하면 **빠뜨릴 자리 자체가 없다.**
 *
 * ★ `fetch` 를 직접 부르지 않는 이유: 그러면 동시성 8 · 회당 타임아웃 · `deadlineAt` ·
 *   429 백오프를 다시 구현하게 되고, 그것이 §5.6.1 이 막으려는 상태
 *   (**예산 밖에서 도는 아웃바운드**)다.
 */

export type TextFailureKind =
  /** 요청은 나갔고 실패 응답을 받았다 */
  | 'http'
  /** 회당 타임아웃 초과 */
  | 'timeout'
  /** 작업 전체 예산 초과 */
  | 'budget'
  /** 네트워크·DNS·연결 거부 */
  | 'network'
  /** 본문을 텍스트로 받지 못했다 — `expect: 'text'` 에서는 도달 불가 */
  | 'not-text';

export type TextOutcome =
  | { ok: true; status: number; text: string }
  | { ok: false; kind: TextFailureKind; status?: number; detail: string };

export interface TextClient {
  request(call: OutboundCall, url: string, opts?: RequestOptions): Promise<TextOutcome>;
}

/** 진단 문자열 상한. 허브·유튜브가 HTML 오류 페이지를 통째로 주는 일이 있다 */
export const MAX_DETAIL = 300;

export function createTextClient(budget: HttpBudget): TextClient {
  return {
    async request(call, url, opts = {}): Promise<TextOutcome> {
      // ★ 응답 형식을 **부르는 쪽이 말한다.** composition-root 가 fetch 를 감싸는
      //   방식이면 그 한 줄을 빠뜨리는 순간 전부 조용히 실패한다 (§5.4 의 교훈).
      const r = await budget.request<string>(call, url, { ...opts, expect: 'text' });

      // `expect: 'text'` 이므로 성공 본문은 **항상 문자열**이다 (빈 202 는 빈 문자열).
      if (r.ok) return { ok: true, status: r.status, text: r.body };

      switch (r.kind) {
        case 'http':
          return {
            ok: false,
            kind: 'http',
            status: r.status,
            detail: r.bodyText.slice(0, MAX_DETAIL),
          };
        case 'timeout':
          return {
            ok: false,
            kind: 'timeout',
            detail: `${call} 회당 타임아웃 ${String(CALL_TIMEOUT_MS[call])}ms 초과`,
          };
        case 'budget':
          return { ok: false, kind: 'budget', detail: `${call} 작업 전체 예산 초과` };
        case 'network':
          return { ok: false, kind: 'network', detail: r.detail.slice(0, MAX_DETAIL) };
        case 'bad-body':
          // ★ `expect: 'text'` 에서는 도달할 수 없다 — 예산이 본문을 파싱하지 않기 때문이다.
          //   그래도 분기를 남기는 이유: 나중에 누가 `expect` 를 지우면 **여기가 켜져서**
          //   원인을 말해 준다. 없애면 그 변경이 조용한 실패가 된다.
          return {
            ok: false,
            kind: 'not-text',
            detail: `${r.detail} — request 에 expect:'text' 가 실렸는지 확인하십시오`,
          };
      }
    },
  };
}
