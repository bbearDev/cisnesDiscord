// 출처: chzzkbot src/web/live-api.ts 의 토큰 검증(헤더 이름 · timingSafeEqual · 길이 선검사)
//       — 상태 코드만 우리 계약(§S5)의 것으로 바꿨다. 계획 §14
import { timingSafeEqual } from 'node:crypto';

import { CHZZKBOT_TOKEN_HEADER } from '../../chzzk/live-api-client.js';
import { parseLiveStartedBody } from '../../chzzk/live-event-schema.js';
import {
  jobFromWebhook,
  liveImageSource,
  type LiveAnnounceFn,
  type LiveImageSource,
  type LiveLedger,
  type LiveSessionStore,
} from '../../live/live-announce.js';
import type { Clock } from '../../runtime/clock.js';
import type { Route, RouteRequest, RouteResponse } from '../server.js';

/**
 * `POST /hooks/chzzkbot/live` — 라이브 시작 웹훅 수신구 (계획 §S5, AC-13/14/17).
 *
 * ★★★ **처리 순서를 못 박는다. 이 순서가 아니면 이벤트가 영구 유실된다.**
 *
 * ```
 * 1. x-chzzkbot-token 검증 (timingSafeEqual)  실패 → 401 + 기록, ★ 본문을 파싱하지 않는다
 * 2. 본문 zod 검증                            실패 → 400 + 기록
 * 3. channelId 가 우리 것인가                 아니면 → 200 (무시하되 기록)
 * 4. ★ announcement_ledger.claim 을 동기 커밋
 * 5. ★ 여기서 2xx 응답 (계약 timeoutMs 5초 — 목표 p99 ≤ 500ms)
 * 6. 디스코드 발송은 비동기. 실패는 아웃박스가 재시도
 * ```
 *
 * ★ **4번이 5번보다 먼저인 이유.** 2xx 를 받은 chzzkbot 은 `markDelivered` 하고
 *   **다시는 보내지 않는다.** 원장 커밋 전에 2xx 를 주고 그 사이에 죽으면
 *   그 방송은 영영 공지되지 않는다. 원장 쓰기가 실패하면 **5xx** 를 줘서
 *   재시도를 유도한다 — 그때는 계약이 준 재시도 창(7분)이 우리 편이다.
 *
 * ★ **디스코드 발송 실패는 2xx 를 되돌리지 않는다.** 발송은 우리 책임이고
 *   재시도 수단(아웃박스)을 이미 갖고 있다. 여기서 5xx 를 주면 chzzkbot 이
 *   재전송하고 우리는 원장에서 다시 거르므로 **아무 이득 없이 재시도만 낭비**된다.
 *
 * ★ 3번이 200 인 이유. 남의 채널은 우리 잘못이 아니라 **정상적인 무시**다.
 *   4xx 를 주면 chzzkbot 이 7분간 무의미한 재시도를 돈다.
 *
 * ★ **`confirmed` 를 검사하지 않는다.** 웹훅은 `onScanAttached`(= `openDate` 확정
 *   시점)에서만 발사되므로 암묵적으로 확정 상태다. `confirmed` 검사는 폴링 경로
 *   전용이다 (계획 §S5).
 */

// ══════════════════════════════════════════════════════════════════
//  운영 기록
// ══════════════════════════════════════════════════════════════════

/**
 * `ops_events.kind` 로 들어가는 값.
 *
 * ★ `alert_state` 와 달리 `ops_events` 에는 CHECK 가 없다(§8). 그래서 CHECK 대신
 *   문자열 유니온이 그 역할을 한다 — 오타가 새 종류를 조용히 만들면
 *   "그동안 한 건도 안 났네" 를 사실로 착각한다.
 */
export const LIVE_WEBHOOK_OPS_KINDS = [
  /** AC-14 — 토큰 없음·틀림. 401 */
  'live_webhook_unauthorized',
  /** 본문이 JSON 이 아니거나 계약 모양이 아니다. 400 */
  'live_webhook_bad_payload',
  /** ★ `version !== 1`. 상류 계약이 바뀌었다. 400 */
  'live_webhook_version_mismatch',
  /** 우리 설정에 없는 채널. 200 으로 무시하되 남긴다 */
  'live_webhook_foreign_channel',
  /** 원장 쓰기 실패. 5xx 를 주고 재시도를 유도했다는 기록 */
  'live_webhook_ledger_failed',
] as const;

export type LiveWebhookOpsKind = (typeof LIVE_WEBHOOK_OPS_KINDS)[number];

export interface OpsEventRecorder {
  /** `ops_events` 한 줄. **던지지 않기로 한다** — 기록이 수신을 죽이면 안 된다 */
  record(kind: LiveWebhookOpsKind, detail: string, at: string): void;
}

/**
 * 지표 배선점 (§9.4).
 *
 * ★ `runtime/metrics.ts` 를 import 하지 않고 포트로 받는다 — 라우트가 필요로
 *   하는 것은 *"응답 시간 한 숫자를 어딘가에 넘긴다"* 뿐이고, 그 이상을 알면
 *   수신 경로가 관측 계층에 묶인다 (`ops` · `silenceWatch` 와 같은 규율).
 */
export interface WebhookMetrics {
  /** `live_webhook_ack_ms` — 수신부터 **2xx 반환**까지 */
  ackMs(ms: number): void;
}

// ══════════════════════════════════════════════════════════════════
//  라우트
// ══════════════════════════════════════════════════════════════════

export const CHZZKBOT_WEBHOOK_PATH = '/hooks/chzzkbot/live';

export interface ChzzkbotWebhookDeps {
  /** `.env` 의 `LIVE_EVENT_WEBHOOK_TOKEN` */
  token: string;
  /** `live.channelId` — 단수. 웹훅·폴링 **양쪽**의 필터 기준이다 */
  channelId: string;
  ledger: LiveLedger;
  sessions: LiveSessionStore;
  announce: LiveAnnounceFn;
  ops: OpsEventRecorder;
  clock: Clock;
  /** AC-P6 — 수신 사실을 알린다. **중복 웹훅도 알린다** (도착이 판정 대상이다) */
  silenceWatch?: { noteWebhook(liveHash: string): void };
  /** §9.4 — 없어도 수신은 그대로 동작한다 */
  metrics?: WebhookMetrics;
  onEvent?: (e: LiveWebhookEvent) => void;
}

export interface LiveWebhookEvent {
  type: 'unauthorized' | 'bad-payload' | 'foreign-channel' | 'claimed' | 'duplicate' | 'ledger-failed';
  liveHash?: string;
  channelId?: string;
  reason?: string;
  /**
   * ★ `claimed` 에만 실린다 — 그림 계약이 **실제 방송에서** 어떻게 왔는지 남긴다.
   *   `none`(상류가 안 실었다) 과 `dropped`(실렸는데 우리 검사가 버렸다) 는
   *   고칠 곳이 다르므로, 임베드만 보고는 갈라낼 수 없는 그 차이를 여기서 남긴다.
   */
  image?: LiveImageSource;
}

/**
 * 상수 시간 비교.
 *
 * ★ 길이가 다르면 먼저 false 를 준다. `timingSafeEqual` 은 길이가 다르면 던지고,
 *   길이는 헤더에서 이미 보이는 값이라 여기서 새는 정보가 없다 (상류의 같은 규율).
 */
function tokenMatches(expected: string, got: string | undefined): boolean {
  if (got === undefined) return false;
  const a = Buffer.from(expected, 'utf-8');
  const b = Buffer.from(got, 'utf-8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 헤더가 중복되면 node 가 배열로 준다. **첫 값만 본다** — 합치면 덧붙인 값이 섞인다 */
function headerToken(req: RouteRequest): string | undefined {
  const raw = req.headers[CHZZKBOT_TOKEN_HEADER];
  return Array.isArray(raw) ? raw[0] : raw;
}

function json(status: number, body: Record<string, unknown>): RouteResponse {
  return { status, body: JSON.stringify(body) };
}

export function createChzzkbotWebhookRoute(deps: ChzzkbotWebhookDeps): Route {
  const emit = (e: LiveWebhookEvent): void => {
    try {
      deps.onEvent?.(e);
    } catch {
      /* 진단 로그가 수신을 죽이면 안 된다 (Principle 2) */
    }
  };

  const record = (kind: LiveWebhookOpsKind, detail: string, at: string): void => {
    try {
      deps.ops.record(kind, detail, at);
    } catch {
      /* 기록 실패가 수신 판정을 바꾸지 않는다 */
    }
  };

  return {
    method: 'POST',
    path: CHZZKBOT_WEBHOOK_PATH,

    handle(req: RouteRequest): RouteResponse {
      // ★★ 두 지표의 **시작점**이다. 핸들러 첫 줄이어야 한다 — 토큰 검증·본문
      //    파싱 뒤에서 재면 그 구간이 응답 시간에서 빠져, 계약 `timeoutMs`(5초)
      //    대비 여유를 실제보다 넉넉하게 읽는다.
      const receivedAtMs = deps.clock.now();
      const at = deps.clock.date().toISOString();

      /**
       * `live_webhook_ack_ms` — **2xx 일 때만** 잰다.
       *
       * ★ §9.4 가 재려는 것은 *"계약이 기다려 주는 5초 안에 2xx 를 돌려줬는가"*
       *   다. 401·400 은 chzzkbot 이 재시도하지 않고 버리는 응답이라 그 시간이
       *   여유 계산에 들어가면 분포가 짧은 쪽으로 왜곡된다.
       *
       * ★ 모든 반환을 이 함수로 감싼다. 2xx 경로만 골라 감싸면 **새 2xx 갈래가
       *   생긴 날 조용히 빠진다** — 여기서 상태 코드를 보고 거르는 편이 안전하다.
       */
      const ack = (res: RouteResponse): RouteResponse => {
        if (res.status >= 200 && res.status < 300) {
          try {
            deps.metrics?.ackMs(deps.clock.now() - receivedAtMs);
          } catch {
            /* 지표가 수신을 죽이면 안 된다 (Principle 2) */
          }
        }
        return res;
      };

      // ── 1. 토큰 ────────────────────────────────────────────────
      // ★ 본문을 **파싱하지 않는다.** 인증 전에 본문을 해석하면 미인증 요청이
      //   우리 파서를 태우고, 그게 곧 공격 표면이다.
      if (!tokenMatches(deps.token, headerToken(req))) {
        emit({ type: 'unauthorized' });
        // ★ 토큰 값을 기록하지 않는다. 있었는지 없었는지만 남긴다.
        record(
          'live_webhook_unauthorized',
          `x-chzzkbot-token ${headerToken(req) === undefined ? '없음' : '불일치'} — 본문 미파싱, 401 응답`,
          at,
        );
        return ack(json(401, { error: 'unauthorized' }));
      }

      // ── 2. 본문 ────────────────────────────────────────────────
      const parsed = parseLiveStartedBody(req.body);
      if (!parsed.ok) {
        emit({ type: 'bad-payload', reason: parsed.reason });
        record(
          parsed.reason === 'version'
            ? 'live_webhook_version_mismatch'
            : 'live_webhook_bad_payload',
          `${parsed.reason}: ${parsed.detail}`,
          at,
        );
        return ack(json(400, { error: 'bad_request', reason: parsed.reason }));
      }
      const event = parsed.event;

      // ── 3. 채널 필터 (R5) ───────────────────────────────────────
      // ★ 검사하지 않으면 남의 방송이 시스네 서버에 공지된다. 시청자가 즉시
      //   알아보는 오알림이고 §3-a 3위(가장 나쁨)다.
      if (event.channelId !== deps.channelId) {
        emit({ type: 'foreign-channel', channelId: event.channelId, liveHash: event.liveHash });
        record(
          'live_webhook_foreign_channel',
          `우리 채널(${deps.channelId})이 아닌 ${event.channelId} 의 방송 — 무시하고 200 응답`,
          at,
        );
        // 200 이다. 4xx 를 주면 chzzkbot 이 7분간 무의미한 재시도를 돈다.
        return ack(json(200, { ok: true, ignored: 'foreign_channel' }));
      }

      // ★ AC-P6 — 수신 사실을 먼저 남긴다. **중복 웹훅도 남긴다.**
      //   판정 대상은 "도착했는가" 이지 "새 건인가" 가 아니다.
      deps.silenceWatch?.noteWebhook(event.liveHash);

      // ── 4. 원장 선점 (동기 커밋) ────────────────────────────────
      let claimed: boolean;
      try {
        // ★ eventKey 는 **받은 liveHash 그대로**. 우리가 계산하지 않는다.
        // ★ seeded 를 세우지 않는다 — 세우면 이후 claim 이 반드시 실패한다(rev.4 B-1).
        claimed = deps.ledger.claim('live_start', event.liveHash, at, 'webhook');
      } catch (e: unknown) {
        const reason = e instanceof Error ? e.message : String(e);
        emit({ type: 'ledger-failed', liveHash: event.liveHash, reason });
        record('live_webhook_ledger_failed', `${event.liveHash}: ${reason}`, at);
        // ★★ 5xx 를 줘야 chzzkbot 이 재시도한다. 2xx 를 주면 그 방송은 영영 사라진다.
        return ack(json(503, { error: 'ledger_unavailable' }));
      }

      if (!claimed) {
        // 이미 누가 집었다 (재전송 · 폴링 · 복구). 공지하지 않고 2xx.
        emit({ type: 'duplicate', liveHash: event.liveHash });
        return ack(json(200, { ok: true, duplicate: true }));
      }

      // 세션 행은 공지의 전제가 아니다. 실패해도 2xx 는 그대로다.
      try {
        deps.sessions.record(
          {
            liveHash: event.liveHash,
            // ★ openDate 는 신원·비교 전용으로만 저장한다. 시각 계산에 쓰지 않는다.
            openDate: event.openDate,
            openedAt: event.openedAt,
            ...(event.liveTitle === undefined ? {} : { liveTitle: event.liveTitle }),
            ...(event.liveId === undefined ? {} : { liveId: String(event.liveId) }),
            ...(event.categoryValue === undefined ? {} : { categoryValue: event.categoryValue }),
            status: 'live',
          },
          at,
        );
      } catch {
        /* 세션 기록 실패가 공지를 막지 않는다 */
      }

      // ── 6. 발송은 비동기 ────────────────────────────────────────
      // ★ await 하지 않는다. 여기서 기다리면 2xx 가 디스코드 왕복만큼 늦어지고,
      //   계약 timeoutMs(5초)를 넘기면 chzzkbot 이 실패로 보고 재전송한다.
      void deps.announce(jobFromWebhook(event, receivedAtMs)).catch(() => {
        /* 발송기는 던지지 않기로 돼 있다. 새더라도 2xx 를 되돌리지 않는다 */
      });

      emit({ type: 'claimed', liveHash: event.liveHash, image: liveImageSource(event) });
      // ── 5. 2xx ─────────────────────────────────────────────────
      return ack(json(202, { ok: true, liveHash: event.liveHash }));
    },
  };
}
