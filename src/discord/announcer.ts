import type { OpsAlertService } from '../runtime/alerts/ops-alert-service.js';
import type { Clock } from '../runtime/clock.js';
import {
  toDiscordSendError,
  type AnnouncementEmbed,
  type DiscordGateway,
  type SendPayload,
} from './client.js';

/**
 * 공지 발송기 — 임베드 생성 + 발송 + 지수 백오프 + 최종 실패 기록 (계획 §S3).
 *
 * ★★ **이 모듈은 어떤 경우에도 호출자에게 예외를 전파하지 않는다** (Principle 2:
 *   *"알림은 부가 기능이다. 본체를 죽이지 않는다"*). 웹훅 수신 핸들러는 이미
 *   2xx 를 돌려준 뒤이고, 인증 흐름은 공지와 무관하게 끝나야 한다.
 *   실패는 **결과값**으로 나오고 운영 채널에 한 줄 남는다.
 *
 * ★ 3초 타임아웃 + `AbortController`, `finally` 에서 **반드시 `clearTimeout`**
 *   (§5.6.1). chzzkbot 이 같은 함정을 두 곳에 적어 뒀다 —
 *   *"clearTimeout 을 빠뜨리면 타이머가 이벤트 루프를 붙잡아 종료가 발송마다
 *   최대 timeoutMs 씩 늦어진다."*
 *
 * ★ 재시도 결과를 원장에 쓰는 것은 **호출부**다. 저장소를 여기서 알면
 *   발송기가 DB 를 알게 되고, 그러면 L7(discord)이 L2(store)에 묶여 아웃박스가
 *   이 모듈을 재사용할 수 없다.
 */

/** §5.6.1 표 — 디스코드 발송 회당 3초 */
export const ANNOUNCE_TIMEOUT_MS = 3_000;

/** §5.6.1 표 — 재시도 3회 (그 뒤는 아웃박스가 다음 틱에 다시 집는다) */
export const ANNOUNCE_MAX_ATTEMPTS = 3;

/** 지수 백오프 1s → 2s → 4s. `Retry-After` 가 있으면 그것을 우선한다 */
export const ANNOUNCE_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000];

/**
 * `Retry-After` 를 따르는 상한.
 *
 * ★ 디스코드가 "1시간 뒤에 오라" 고 하면 그 자리에서 자면 안 된다 —
 *   한 건이 아웃박스 한 바퀴를 통째로 붙잡는다(FM5 의 원인과 같은 자리).
 *   상한을 넘으면 지금은 포기하고 **다음 틱의 아웃박스에 넘긴다.**
 */
export const MAX_RETRY_AFTER_MS = 30_000;

export interface AnnounceRequest {
  channelId: string;
  payload: SendPayload;
  /** 로그·경보 문구에 쓰는 사람이 읽는 이름. 예: `live_start df09256e` */
  label: string;
}

export type AnnounceResult =
  | { ok: true; messageId: string; attempts: number }
  | { ok: false; reason: string; attempts: number; permanent: boolean };

export interface AnnounceEvent {
  label: string;
  attempt: number;
  outcome: 'sent' | 'retrying' | 'failed';
  kind?: string;
  reason?: string;
  waitMs?: number;
}

export interface AnnouncerOptions {
  gateway: DiscordGateway;
  /** 최종 실패를 남길 곳 (`discord_send_failed`, AC-19) */
  alerts: OpsAlertService;
  clock: Clock;
  timeoutMs?: number;
  maxAttempts?: number;
  backoffMs?: readonly number[];
  /** 테스트 주입점 — 실제 백오프를 기다리지 않기 위해 */
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (e: AnnounceEvent) => void;
}

export interface Announcer {
  /** **절대 reject 하지 않는다** */
  announce(req: AnnounceRequest): Promise<AnnounceResult>;
}

// ══════════════════════════════════════════════════════════════════
//  임베드
// ══════════════════════════════════════════════════════════════════

export interface EmbedSpec {
  title: string;
  url?: string;
  description?: string;
  /**
   * ISO-8601. 라이브 공지는 **`openedAt`** 을 넣는다 — 우리가 받은 시각이 아니다
   * (계획 §S5 · §2 "임베드 타임스탬프를 `openedAt` 으로").
   */
  timestamp?: string;
  color?: number;
  /**
   * 감지 경로. 푸터에 작게 적는다 — **사람이 눈으로도 웹훅 고장을 알아챈다**
   * (계획 §11). `api-poll` 이 계속 보이면 웹훅이 죽어 있다는 뜻이다.
   */
  detectedVia?: string;
  /**
   * 본문 아래 큰 이미지의 URL.
   *
   * ★ `thumbnail`(우측 상단 작은 정사각)이 아니라 `image`(전체 폭)다. 공지는
   *   타임라인에서 한 번에 눈에 들어와야 하고, 작은 정사각은 그 일을 못 한다.
   *
   * ★★ **디스코드가 이 이미지를 캐시한다.** 임베드를 만든 순간의 그림이 박제되므로,
   *   시간에 따라 변하는 이미지를 넣으면 "지금"이 아니라 "그때"가 남는다.
   *   유튜브 썸네일은 업로드 후 바뀌지 않아 이 성질이 문제가 되지 않는다.
   *
   * ★ 라이브 공지의 방송 썸네일은 실제로 변하는 그림이지만, 박제되는 것이 **맞다** —
   *   공지가 말하는 것은 "방송이 시작된 그 순간"이다. 상류도 방송 인식 시점에 한 번만
   *   훑어 주소를 잡으므로(다시 물어도 갱신되지 않는다) 고쳐 그릴 재료 자체가 없다.
   */
  image?: string;
}

export function buildAnnouncementEmbed(spec: EmbedSpec): AnnouncementEmbed {
  return {
    title: spec.title,
    ...(spec.url === undefined ? {} : { url: spec.url }),
    ...(spec.description === undefined ? {} : { description: spec.description }),
    ...(spec.timestamp === undefined ? {} : { timestamp: spec.timestamp }),
    ...(spec.color === undefined ? {} : { color: spec.color }),
    ...(spec.detectedVia === undefined ? {} : { footer: { text: `감지: ${spec.detectedVia}` } }),
    ...(spec.image === undefined ? {} : { image: { url: spec.image } }),
  };
}

// ══════════════════════════════════════════════════════════════════
//  발송
// ══════════════════════════════════════════════════════════════════

export function createAnnouncer(opts: AnnouncerOptions): Announcer {
  const timeoutMs = opts.timeoutMs ?? ANNOUNCE_TIMEOUT_MS;
  const maxAttempts = opts.maxAttempts ?? ANNOUNCE_MAX_ATTEMPTS;
  const backoff = opts.backoffMs ?? ANNOUNCE_BACKOFF_MS;
  const sleep =
    opts.sleep ??
    ((ms: number): Promise<void> =>
      new Promise((r) => {
        // ★ unref. 종료 중에 남은 백오프 타이머가 프로세스를 붙잡으면
        //   정상 종료가 그만큼 늦어진다.
        setTimeout(r, ms).unref();
      }));

  const emit = (e: AnnounceEvent): void => {
    try {
      opts.onEvent?.(e);
    } catch {
      /* 진단 로그가 발송을 죽이면 안 된다 */
    }
  };

  /** 한 번 보낸다. 타임아웃을 걸고 `finally` 에서 타이머를 반드시 걷는다 */
  async function sendOnce(req: AnnounceRequest): Promise<string> {
    const ac = new AbortController();
    const timer = setTimeout(() => {
      ac.abort();
    }, timeoutMs);
    try {
      const msg = await opts.gateway.send(req.channelId, req.payload, { signal: ac.signal });
      return msg.id;
    } finally {
      // ★ 이 한 줄이 없으면 발송마다 최대 timeoutMs 만큼 종료가 늦어진다.
      clearTimeout(timer);
    }
  }

  return {
    async announce(req): Promise<AnnounceResult> {
      let lastReason = '알 수 없는 실패';
      let permanent = false;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const messageId = await sendOnce(req);
          emit({ label: req.label, attempt, outcome: 'sent' });
          return { ok: true, messageId, attempts: attempt };
        } catch (e: unknown) {
          const err = toDiscordSendError(e);
          lastReason = `${err.kind}: ${err.message}`;

          // ★ 403 은 재시도하지 않는다. 권한은 4초 안에 생기지 않고,
          //   재시도해 봐야 레이트리밋 예산만 태운 뒤 같은 자리에서 실패한다.
          if (err.kind === 'forbidden') {
            permanent = true;
            emit({ label: req.label, attempt, outcome: 'failed', kind: err.kind, reason: err.message });
            await recordFailure(req, lastReason, attempt, true);
            return { ok: false, reason: lastReason, attempts: attempt, permanent: true };
          }

          if (attempt >= maxAttempts) {
            emit({ label: req.label, attempt, outcome: 'failed', kind: err.kind, reason: err.message });
            break;
          }

          // ★ 429 는 서버가 말한 시각을 **백오프보다 우선**한다 (§5.6.1).
          const step = backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 1_000;
          const advised = err.kind === 'rate-limited' ? err.retryAfterMs : undefined;
          const waitMs = advised ?? step;

          if (waitMs > MAX_RETRY_AFTER_MS) {
            // 지금 자면 아웃박스 한 바퀴가 통째로 멈춘다. 다음 틱에 넘긴다.
            lastReason = `${err.kind}: Retry-After ${String(Math.round(waitMs / 1000))}초 — 다음 회수 주기로 미룹니다`;
            emit({ label: req.label, attempt, outcome: 'failed', kind: err.kind, reason: lastReason });
            break;
          }

          emit({ label: req.label, attempt, outcome: 'retrying', kind: err.kind, reason: err.message, waitMs });
          await sleep(waitMs);
        }
      }

      await recordFailure(req, lastReason, maxAttempts, false);
      return { ok: false, reason: lastReason, attempts: maxAttempts, permanent };
    },
  };

  /**
   * 최종 실패를 운영 채널에 남긴다 (AC-19).
   *
   * ★ 경보 발송이 실패해도 여기서 던지지 않는다. `OpsAlertService` 는 이미
   *   reject 하지 않기로 돼 있지만 **계약을 신뢰하지 않는다** — 여기서 새면
   *   "공지 실패를 알리려다 본체가 죽는" 정확히 그 형태가 된다.
   */
  async function recordFailure(
    req: AnnounceRequest,
    reason: string,
    attempts: number,
    permanent: boolean,
  ): Promise<void> {
    try {
      await opts.alerts.raise(
        'discord_send_failed',
        `공지 발송 실패 — ${req.label}\n` +
          `시각: ${opts.clock.date().toISOString()}\n` +
          `채널: ${req.channelId}\n` +
          `시도: ${String(attempts)}회${permanent ? ' (권한 문제로 재시도 중단)' : ''}\n` +
          `사유: ${reason}\n` +
          '원장에 행이 남아 있으므로 아웃박스가 다시 시도합니다.',
      );
    } catch {
      /* Principle 2 — 경보 실패가 발송기를 죽이지 않는다 */
    }
  }
}
