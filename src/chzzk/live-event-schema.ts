// 출처: chzzkbot src/live/live-event-payload.ts 의 `LiveStartedEvent`
//       (필드명·선택성을 한 글자도 바꾸지 않았다 — 계획 §14)
import { z } from 'zod';

/**
 * `POST /hooks/chzzkbot/live` 웹훅 페이로드 검증 (계획 §S5, AC-14).
 *
 * ★★ **`version !== 1` 은 조용히 무시하지 않는다.** 400 으로 거부하고 운영 채널에
 *   기록한다. 무시하면 상류가 계약을 바꾼 사실을 **아무도 못 알아채고**, 그동안
 *   방송 공지가 통째로 사라진다 — 침묵하는 누락(§3-a 2위)의 전형이다.
 *   400 은 chzzkbot 재시도를 유발하지만 그건 의도된 것이다: 재시도 로그가
 *   상류 쪽에도 남아 양쪽에서 같은 사실을 본다.
 *
 * ★ 웹훅에는 `confirmed` 필드가 **없다.** 웹훅은 `onScanAttached`(= `openDate`
 *   확정 시점)에서만 발사되므로 **암묵적으로 확정 상태**다.
 *   → `confirmed` 검사는 조회 API 폴링 경로에만 적용한다 (계획 §S5).
 *
 * ★ `liveHash` 는 **받은 값을 그대로** 원장 `event_key` 로 쓴다. 우리가 계산하지
 *   않는다 — 웹훅과 조회 API 가 상류의 같은 `toLiveIdentity` 로 만들기 때문에
 *   두 경로의 키가 자동으로 일치한다. 우리가 다시 계산하는 순간 그 보증이 깨진다.
 *   (테스트에서만 재계산해 대조한다 — 계획 §14)
 */

/** 상류 `LIVE_EVENT_PAYLOAD_VERSION`. 조회 API 응답도 같은 값을 싣는다 */
export const LIVE_EVENT_PAYLOAD_VERSION = 1;

/**
 * **시간대가 명시된** ISO-8601 순간.
 *
 * ★★ `Date.parse` 만으로는 부족하다. node 는 `"2026-09-07 03:56:39"`(시간대 없음)도
 *   유효한 값으로 파싱하고 **그것을 서버 로컬 시간대로 해석한다.**
 *   즉 시간대 없는 값이 통과하면 `openDate` 를 `openedAt` 자리에 흘려 넣는 사고가
 *   조용히 성공하고, 임베드 타임스탬프가 9시간 어긋난 채 나간다 — 계획 §5.1 이
 *   못 박은 바로 그 결함이다. 그래서 `Z` 또는 `±HH:MM` 을 **요구**한다.
 *
 * ★ `openedAt` · `detectedAt` 에만 건다. `openDate` 에는 **절대 걸지 않는다** —
 *   시간대 표기가 없는 KST 원문이 정상이고, 애초에 `Date` 로 해석하면 안 되는 값이다.
 */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:?\d{2})$/;

const isoInstant = z
  .string()
  .min(1)
  .refine((v) => ISO_INSTANT_RE.test(v) && !Number.isNaN(Date.parse(v)), {
    message: '시간대가 명시된 ISO-8601 이 아닙니다 (Z 또는 ±HH:MM 필요)',
  });

export const LiveStartedEventSchema = z.object({
  event: z.literal('live.started'),
  version: z.number(),
  channelId: z.string().min(1),
  channelName: z.string().optional(),
  /** 치지직 원문 KST, 시간대 표기 없음. ★ 신원·중복 판정 전용 */
  openDate: z.string().min(1),
  /** ISO-8601 UTC. ★ 임베드 타임스탬프·시각 계산은 전부 이 값이다 */
  openedAt: isoInstant,
  /** sha256(`${channelId} ${openDate.trim()}`) 앞 8자 — 받은 값을 그대로 쓴다 */
  liveHash: z.string().min(1),
  liveId: z.number().optional(),
  /** ★ 웹훅에만 있다. 폴링 응답에는 없다 */
  liveTitle: z.string().optional(),
  categoryValue: z.string().optional(),
  concurrentUserCount: z.number().optional(),
  /** chzzkbot 이 인식한 시각 (ISO-8601 UTC) */
  detectedAt: isoInstant,
});

export type LiveStartedEvent = z.infer<typeof LiveStartedEventSchema>;

/**
 * 거절 사유.
 *
 * ★ `version` 과 `schema` 를 가른다. 둘 다 400 이지만 **사람이 할 일이 다르다** —
 *   `version` 은 "상류가 계약을 올렸으니 우리를 맞춰라"이고 `schema` 는
 *   "본문이 깨졌거나 남이 쏘고 있다"이다. 운영 기록 문구가 이 값으로 갈린다.
 */
export type LiveEventRejectReason = 'body' | 'schema' | 'version';

export type LiveEventParseResult =
  | { ok: true; event: LiveStartedEvent }
  | { ok: false; reason: LiveEventRejectReason; detail: string };

/**
 * 본문 버퍼 → 이벤트.
 *
 * ★ 순서가 중요하다: **JSON 파싱 → 모양 검증 → 버전 검증.**
 *   버전을 먼저 보려면 본문을 먼저 믿어야 하고, 그러면 `{"version":1}` 한 줄이
 *   모양 검증을 건너뛴다. 반대로 모양 검증에 `z.literal(1)` 을 박으면 버전 불일치가
 *   "필드 하나 틀림"으로 뭉개져 **계약 변경을 특정할 수 없다.**
 */
export function parseLiveStartedEvent(raw: unknown): LiveEventParseResult {
  const parsed = LiveStartedEventSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'schema',
      detail: parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join(' / ')
        .slice(0, 300),
    };
  }
  if (parsed.data.version !== LIVE_EVENT_PAYLOAD_VERSION) {
    return {
      ok: false,
      reason: 'version',
      detail:
        `페이로드 version=${String(parsed.data.version)} — 우리가 아는 값은 ` +
        `${String(LIVE_EVENT_PAYLOAD_VERSION)} 입니다. 상류 계약이 바뀌었습니다.`,
    };
  }
  return { ok: true, event: parsed.data };
}

/** 요청 본문(Buffer) 을 JSON 으로 읽고 검증까지 한다 */
export function parseLiveStartedBody(body: Buffer): LiveEventParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(body.toString('utf-8'));
  } catch (e: unknown) {
    return {
      ok: false,
      reason: 'body',
      detail: (e instanceof Error ? e.message : String(e)).slice(0, 300),
    };
  }
  return parseLiveStartedEvent(raw);
}
