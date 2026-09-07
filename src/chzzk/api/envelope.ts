// 출처: chzzkbot src/chzzk/api/envelope.ts — 봉투를 한 곳에서만 벗긴다는 규율을 그대로
//       옮기고, 전송 계층만 우리 `http-budget`(§5.6.1)으로 갈아 끼웠다 (계획 §14).
import { z } from 'zod';

import type { OutboundResult } from '../../runtime/http-budget.js';

/**
 * 치지직 공통 응답 봉투.
 *
 *   성공: `{ code: 200, message: null, content: {...} }`
 *   실패: `{ code: <int>, message: "..." }`
 *
 * ★ 봉투를 각 API 모듈이 따로 벗기면 벗기는 방식이 조금씩 달라진다.
 *   여기 한 곳에서 벗기고, 각 모듈은 `content` 스키마만 갖는다.
 *
 * ★ **예외를 던지지 않는다.** 호출부는 인증 흐름이고, 그 흐름은 어떤 응답을
 *   받아도 사람에게 안내를 돌려줘야 한다 (Principle 2).
 */

export const Envelope = z.object({
  code: z.number(),
  message: z.string().nullable().optional(),
  content: z.unknown().optional(),
});

/** `OutboundResult` 의 실패 갈래만. 성공은 `ApiResult.ok` 쪽으로 간다 */
export type TransportFailure = Extract<OutboundResult<unknown>, { ok: false }>;

export type ApiResult<T> =
  | { ok: true; data: T }
  /** HTTP 는 성공했으나 응답 모양이 계약과 다르다 — 스키마 변경 신호다 */
  | { ok: false; kind: 'shape'; detail: string }
  /** 전송 자체가 실패했다 (`http-budget` 이 이미 예외를 삼킨 뒤다) */
  | { ok: false; kind: 'transport'; result: TransportFailure };

/**
 * 봉투를 벗기고 `content` 를 스키마로 좁힌다.
 *
 * ★ `content` 가 없는 응답(예: revoke 성공)도 있다. 그때는 스키마가
 *   그것을 받아들이도록 호출부가 정하고, 여기서는 판단하지 않는다.
 *
 * ★ **봉투가 아닌 평평한 본문도 받는다.** 치지직 토큰 발급 응답이 실측에서
 *   봉투 없이 온 사례가 있어(상류 `parseRefreshBody` 가 `content ?? body` 로
 *   같은 대비를 한다) 그 대비를 그대로 승계한다. 봉투 검증에 실패했다는
 *   이유만으로 정상 응답을 버리면 인증이 통째로 막힌다.
 */
export function unwrapEnvelope<T>(
  res: OutboundResult<unknown>,
  schema: z.ZodType<T>,
): ApiResult<T> {
  if (!res.ok) return { ok: false, kind: 'transport', result: res };

  const env = Envelope.safeParse(res.body);
  const content = env.success ? (env.data.content ?? res.body) : res.body;

  const parsed = schema.safeParse(content);
  if (!parsed.success) {
    return { ok: false, kind: 'shape', detail: `content 형식 불일치: ${parsed.error.message}` };
  }
  return { ok: true, data: parsed.data };
}

/** 실패 응답의 `message`. 사람에게 보여줄 사유를 만들 때만 쓴다 */
export function envelopeMessage(body: unknown): string | undefined {
  const env = Envelope.safeParse(body);
  if (!env.success) return undefined;
  return env.data.message ?? undefined;
}
