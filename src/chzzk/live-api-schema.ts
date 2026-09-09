// 출처: chzzkbot src/web/live-api.ts 의 `LiveApiResponse` · `LiveApiChannel`
//       (필드명·선택성을 한 글자도 바꾸지 않았다 — 계획 §14 "계약의 타입 정의 그 자체")
import { z } from 'zod';

/**
 * `GET /api/live` 응답 계약 — **우리가 부르는 유일한 아웃바운드의 응답 모양** (계획 §S5).
 *
 * ★ 왜 클라이언트(`live-api-client.ts`)에서 분리했는가.
 *   3상태 판정기(`live/live-state.ts`, L4)가 이 타입을 필요로 하는데 클라이언트에
 *   두면 판정기가 HTTP 예산 계층까지 딸려 온다. 판정기는 **순수 함수여야** 하고
 *   그래야 `live × confirmed × status` 전수 행렬을 소켓 없이 돌릴 수 있다.
 *
 * ★ `strict()` 를 쓰지 않는다. 상류가 필드를 **더하는** 것은 계약 위반이 아니며
 *   (버전은 그대로다), 여기서 막으면 상류의 무해한 추가 한 번에 폴링이 통째로
 *   `unknown` 으로 접힌다 — 그건 §3-a 2위(누락)를 스스로 만드는 짓이다.
 *   **줄어드는 것**(필수 필드 누락)만 막는다.
 */

/** 상류 `LIVE_EVENT_PAYLOAD_VERSION`. 웹훅과 조회 API 가 이 상수를 공유한다 */
export const LIVE_API_VERSION = 1;

export const LiveApiChannelSchema = z.object({
  channelId: z.string().min(1),
  channelName: z.string().optional(),
  /** 활성 세션이 있고 `status === 'running'` 일 때만 true */
  live: z.boolean(),
  /** `live && openDate` 로 신원(identity) 확보됨 */
  confirmed: z.boolean(),
  /**
   * 치지직 원문 KST, 시간대 표기 **없음**.
   * ★★ `new Date()` 에 넣지 않는다 — 비교·중복 판정 전용이다 (계획 §5.1).
   */
  openDate: z.string().optional(),
  /** ISO-8601 UTC. ★ 시각 계산은 이쪽 */
  openedAt: z.string().optional(),
  liveHash: z.string().optional(),
  liveId: z.number().optional(),
  /** ★ `liveTitle` 칸은 **의도적으로 없다** — 상류가 싣지 않는다 (계획 §5.1 W2 Cons) */
  categoryValue: z.string().optional(),
  /**
   * ★ 웹훅과 **같은 이름·같은 규칙**이다 (`live-event-schema.ts` 의 주석 참조).
   *   없으면 키가 없고, 방송 인식 시점에 없었으면 이후 폴링에서도 영영 오지 않는다.
   *   이미 끝난 방송이면 제목·시청자 수와 함께 빠진다.
   */
  liveImageUrl: z.string().optional(),
  /** 관측 당시의 채널 프로필 이미지. 썸네일이 없을 때의 대체 후보 */
  channelImageUrl: z.string().optional(),
  uptimeMs: z.number().optional(),
  /** === `confirmed` */
  exact: z.boolean(),
  sessionStartedAt: z.string().optional(),
  /** `'running' | 'stopped' | ...` — 문자열을 좁히지 않는다. 새 값이 오면 `unknown` 이 받는다 */
  status: z.string().optional(),
  socketState: z.string().optional(),
});

export const LiveApiResponseSchema = z.object({
  version: z.number(),
  generatedAt: z.string(),
  channels: z.array(LiveApiChannelSchema),
});

export type LiveApiChannel = z.infer<typeof LiveApiChannelSchema>;
export type LiveApiResponse = z.infer<typeof LiveApiResponseSchema>;

/**
 * 조회가 실패한 방식.
 *
 * ★★ **전부 `unknown` 으로 접힌다** (계획 §5.1). 종류를 남기는 이유는 판정이
 *   아니라 **진단** 때문이다 — `timeout` 이 쌓이는 것과 `http`(401)가 쌓이는 것은
 *   사람이 할 일이 다르다. 판정에 쓰면 그 순간 "어떤 실패는 종료로 친다" 가 생긴다.
 *
 * `timeout`/`network`/`budget`/`http`/`bad-body` 는 `runtime/http-budget.ts` 의
 * `OutboundResult` 판별자와 같은 이름이다. `schema` 만 우리가 더한다.
 */
export type LiveApiFailure = 'timeout' | 'network' | 'budget' | 'http' | 'bad-body' | 'schema';
