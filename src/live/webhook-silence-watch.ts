import type { OpsAlertService } from '../runtime/alerts/ops-alert-service.js';
import type { Clock, Disposable } from '../runtime/clock.js';

/**
 * ★ AC-P6 — 웹훅 침묵 감시 (계획 §S5).
 *
 * **폴링이 방송을 먼저 찾았다면, 웹훅이 왔어야 한다.**
 * `announce` 를 선점(claim)하고 나서 `live.webhookSilenceGraceMin`(기본 10분)이
 * 지나도 같은 `liveHash` 의 웹훅 수신 기록이 없으면 운영 채널에 **1건** 남긴다.
 *
 * ★★ **유예창이 재시도 창(7분)보다 길어야 하는 이유가 이 모듈의 존재 이유다.**
 *   *"우리가 ≤ 7분 다운 → chzzkbot 재시도 큐가 메운다"* 는 **정상 시퀀스**다.
 *   그 사이 폴링이 먼저 방송을 찾고, 그 뒤 재시도된 웹훅이 도착한다.
 *   유예창이 7분보다 짧으면 이 정상 시퀀스가 경보를 내고, **그 오경보가
 *   진짜 신호(웹훅 설정 꺼짐 · 토큰 불일치)를 덮는다.**
 *   설정 스키마 superRefine ②가 이 관계를 기동 시에 강제한다.
 *
 * ★ 감시 대상은 `liveHash` 단위다. 방송 하나에 경보 하나 — 그래서 "1건"이 성립한다.
 *
 * ★ 이 모듈은 `stuck-watch.ts` 를 쓰지 않는다. 저쪽은 *"나쁜 관측이 N회 연속 /
 *   T 시간 지속"* 인데 여기는 *"한 사건에 대해 기한까지 짝이 오는가"* 라 모양이
 *   다르다. 억지로 합치면 관측을 주기적으로 밀어 넣는 가짜 루프가 필요해진다.
 */

export interface WebhookSilenceEvent {
  type: 'armed' | 'matched' | 'silent' | 'late';
  liveHash: string;
  /** `matched` · `late` 일 때 claim 부터 웹훅까지 걸린 시간 (지표 `live_webhook_silence_sec`) */
  waitedMs?: number;
}

export interface WebhookSilenceWatchOptions {
  clock: Clock;
  alerts: OpsAlertService;
  /** `live.webhookSilenceGraceMin` × 60_000 */
  graceMs: number;
  onEvent?: (e: WebhookSilenceEvent) => void;
}

export interface WebhookSilenceWatch {
  /**
   * 폴링이 `announce` 를 **선점했다**. 여기서부터 유예창이 시작된다.
   *
   * ★ 이미 같은 `liveHash` 의 웹훅을 받은 뒤라면 감시를 걸지 않는다 —
   *   웹훅 경로가 스스로 선점한 경우가 그렇고, 그때 경보를 걸면 100% 오경보다.
   */
  noteClaim(liveHash: string): void;
  /** 웹훅을 받았다. **중복이든 아니든 기록한다** — 도착 사실이 판정 대상이다 */
  noteWebhook(liveHash: string): void;
  dispose(): void;
  /** 지금 유예창이 걸려 있는 방송 수 (진단·테스트용) */
  readonly armed: number;
}

/**
 * 웹훅 수신 기록 보존 배수.
 *
 * ★ 무한히 쌓아 두지 않는다. 하루 방송이 0~2건이라 실제로는 몇 개뿐이지만,
 *   상류가 오작동해 같은 이벤트를 쏟아내면 이 맵이 유일한 무한 증가 지점이 된다.
 *   유예창의 4배가 지난 기록은 어떤 판정에도 쓰이지 않는다.
 */
export const RECEIPT_RETENTION_FACTOR = 4;

interface Armed {
  timer: Disposable;
  at: number;
}

export function createWebhookSilenceWatch(
  opts: WebhookSilenceWatchOptions,
): WebhookSilenceWatch {
  const { clock, alerts, graceMs } = opts;
  /** liveHash → 웹훅을 받은 시각 */
  const received = new Map<string, number>();
  /** liveHash → 유예창 */
  const armed = new Map<string, Armed>();
  /**
   * liveHash → 경보를 낸 시각.
   *
   * ★ 늦게라도 웹훅이 오면 그 사실을 지표로 남긴다(`late`). 경보를 취소하지는
   *   않는다 — 이미 나간 경보를 되돌릴 수 없고, 되돌릴 수 있어도 "10분 넘게
   *   늦었다"는 사실 자체가 진단이다.
   */
  const fired = new Map<string, number>();
  let disposed = false;

  const emit = (e: WebhookSilenceEvent): void => {
    try {
      opts.onEvent?.(e);
    } catch {
      /* 진단 로그가 감시를 죽이면 안 된다 (Principle 2) */
    }
  };

  function prune(now: number): void {
    const cutoff = now - graceMs * RECEIPT_RETENTION_FACTOR;
    for (const [hash, at] of received) {
      if (at < cutoff) received.delete(hash);
    }
    for (const [hash, at] of fired) {
      if (at < cutoff) fired.delete(hash);
    }
  }

  function fire(liveHash: string): void {
    armed.delete(liveHash);
    fired.set(liveHash, clock.now());
    emit({ type: 'silent', liveHash, waitedMs: graceMs });
    void alerts
      .raise(
        'webhook_silence',
        `웹훅 침묵 — ${liveHash}\n` +
          `폴링(GET /api/live)이 방송을 먼저 찾아 공지를 선점했고, ` +
          `${String(Math.round(graceMs / 60_000))}분이 지나도 같은 liveHash 의 웹훅이 오지 않았습니다.\n` +
          '확인 순서:\n' +
          '  1) chzzkbot 의 live-event 웹훅 설정이 켜져 있는지\n' +
          '  2) LIVE_EVENT_WEBHOOK_TOKEN 이 양쪽에서 같은지 (틀리면 우리가 401 을 준다)\n' +
          '  3) chzzkbot 로그에 배달 실패가 쌓였는지\n' +
          '공지는 이미 나갔습니다 — 이 경보는 감지 경로 하나가 죽었다는 뜻입니다.',
      )
      .catch(() => {
        /* 경보 실패가 감시를 죽이지 않는다 */
      });
  }

  return {
    get armed() {
      return armed.size;
    },

    noteClaim(liveHash): void {
      if (disposed || armed.has(liveHash)) return;
      const now = clock.now();
      prune(now);

      // ★ 웹훅이 이미 왔으면 감시하지 않는다. 웹훅 경로가 스스로 선점한 경우가
      //   여기다 — 그때 걸면 방송마다 오경보가 난다.
      const seen = received.get(liveHash);
      if (seen !== undefined) {
        emit({ type: 'matched', liveHash, waitedMs: 0 });
        return;
      }

      const timer = clock.setTimeout(() => {
        fire(liveHash);
      }, graceMs);
      armed.set(liveHash, { timer, at: now });
      emit({ type: 'armed', liveHash });
    },

    noteWebhook(liveHash): void {
      if (disposed) return;
      const now = clock.now();
      received.set(liveHash, now);
      prune(now);

      const pending = armed.get(liveHash);
      if (pending === undefined) {
        const firedAt = fired.get(liveHash);
        if (firedAt !== undefined) {
          fired.delete(liveHash);
          emit({ type: 'late', liveHash, waitedMs: now - firedAt + graceMs });
        }
        return;
      }
      // ★ 유예창 **안**에 도착했다 → 경보 없음. 이것이 "다운 ≤ 7분" 정상 시퀀스다.
      pending.timer.dispose();
      armed.delete(liveHash);
      emit({ type: 'matched', liveHash, waitedMs: now - pending.at });
    },

    dispose(): void {
      disposed = true;
      for (const a of armed.values()) a.timer.dispose();
      armed.clear();
      received.clear();
      fired.clear();
    },
  };
}
