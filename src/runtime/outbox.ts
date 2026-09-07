// 출처: chzzkbot src/runtime-wiring.ts 의 `retryLiveEvents`
//       (재진입 가드 · finally 해제 · 순차 처리 · disposed 조기 반환을 그대로 승계 — 계획 §14)
import type { Clock, Disposable } from './clock.js';

/**
 * 아웃박스 — 원장의 미발송 행을 기동 시 + 주기적으로 회수한다 (계획 §S3).
 *
 * ★★ **FM5 재진입 가드가 이 모듈의 존재 이유다** (AC-17 이 이것 없이는 깨진다).
 *
 *   원장 `claim` 은 **웹훅 수신 vs 아웃박스** 경합을 막는다 — 같은 키면 한쪽이 진다.
 *   **그러나 아웃박스 타이머 자신의 두 틱이 겹치는 것은 막지 못한다.**
 *   두 틱 모두 같은 `announced_at IS NULL` 행을 읽어 **같은 건을 두 번 발송한다.**
 *   한 바퀴가 `limit × timeoutMs` 까지 걸릴 수 있고 틱은 그보다 자주 올 수 있으므로
 *   이건 이론이 아니라 실제로 겹친다.
 *
 * ★ `finally` 로 푸는 것이 핵심이다. 예외가 났을 때 플래그가 켜진 채로 남으면
 *   아웃박스가 **영구히 잠긴다** — 그러면 이후 모든 미발송 공지가 조용히 사라지고,
 *   침묵이라 지표에도 안 나타난다 (§3-a 2위의 최악 형태).
 *
 * ★ **순차 처리**도 함께 승계한다. 대기열은 이벤트 단위라 길어야 몇 건이고,
 *   동시에 쏘면 디스코드가 막 회복한 순간에 다시 몰아친다.
 *
 * ★ 이 모듈은 L1(runtime) 이라 store(L2)·discord(L7) 를 import 할 수 없다.
 *   원장과 발송기를 **인터페이스로 주입받는다** — composition-root 가 실제 구현을
 *   꽂고 테스트는 메모리 구현을 꽂는다. eslint 레이어 규칙이 이 형태를 강제한다.
 */

/** 원장 행 중 아웃박스가 보는 부분만. `PendingAnnouncement` 가 이 모양을 만족한다 */
export interface OutboxRow {
  kind: string;
  eventKey: string;
  detectedVia: string;
  claimedAt: string;
  attempts: number;
  lastError?: string | undefined;
}

export interface OutboxLedger {
  /** 미발송 행. 오래 기다린 것부터 */
  pendingRetries(limit?: number): OutboxRow[];
}

export type OutboxOutcome =
  /** 한 바퀴를 돌았다 */
  | 'ran'
  /** ★ 앞 바퀴가 아직 돌고 있어 들어가지 않았다 (FM5) */
  | 'skipped'
  /** 종료 중이다 */
  | 'disposed'
  /** 대기열을 읽는 것 자체가 실패했다 */
  | 'failed';

export interface OutboxTick {
  outcome: OutboxOutcome;
  /** 이번 바퀴에서 `send` 를 부른 횟수 */
  processed: number;
  /** `send` 가 던진 횟수 */
  errors: number;
}

export interface OutboxEvent {
  type: 'skipped' | 'send-failed' | 'read-failed' | 'tick';
  row?: OutboxRow;
  reason?: string;
  processed?: number;
}

export interface OutboxOptions {
  ledger: OutboxLedger;
  /**
   * 한 건을 보낸다.
   *
   * ★ 계약상 던지지 않기로 돼 있다(`announcer` 가 그렇게 만들어져 있다).
   *   **그래도 여기서 감싼다** — 계약을 신뢰하면 한 건의 예외가 나머지 대기열을
   *   통째로 날린다.
   */
  send: (row: OutboxRow) => Promise<void>;
  clock: Clock;
  /** 회수 주기. 기본 1분 */
  intervalMs?: number;
  /** 한 바퀴에 회수할 최대 건수 */
  limit?: number;
  onEvent?: (e: OutboxEvent) => void;
}

/**
 * 기본 회수 주기 1분.
 *
 * 디스코드 장애는 보통 분 단위로 회복하고, 대기열은 하루 수 건이다.
 * 더 자주 돌 이유가 없고 — 자주 돌수록 재진입 가드가 하는 일만 늘어난다.
 */
export const OUTBOX_INTERVAL_MS = 60_000;

export interface Outbox {
  /** 기동 시 1회 + 주기 타이머. 두 번 불러도 타이머는 하나다 */
  start(): void;
  /** 한 바퀴. 테스트가 틱을 인위적으로 겹치는 데 쓴다 */
  runOnce(): Promise<OutboxTick>;
  dispose(): void;
  /** 진단·테스트용 — 지금 한 바퀴가 돌고 있는가 */
  readonly inFlight: boolean;
}

export function createOutbox(opts: OutboxOptions): Outbox {
  const intervalMs = opts.intervalMs ?? OUTBOX_INTERVAL_MS;

  /** ★ 재진입 가드 (FM5). chzzkbot `retryLiveEvents` 의 `retryInFlight` 와 같다 */
  let retryInFlight = false;
  let disposed = false;
  let timer: Disposable | undefined;

  /**
   * ★ 함수로 읽는다. `disposed` 를 직접 보면 타입 좁히기가 "위에서 false 였으니
   *   루프 안에서도 false" 라고 단정한다 — 그러나 `send` 안에서 종료가 시작될 수
   *   있고, 그 경우를 잡는 것이 아래 루프의 조기 탈출이다.
   */
  const isDisposed = (): boolean => disposed;

  const emit = (e: OutboxEvent): void => {
    try {
      opts.onEvent?.(e);
    } catch {
      /* 진단 로그가 회수를 죽이면 안 된다 */
    }
  };

  async function runOnce(): Promise<OutboxTick> {
    // 종료 중이면 아무것도 하지 않는다 — **닫힌 DB 를 건드리지 않기 위해서다**
    // (chzzkbot 의 `if (disposed) return;` 과 같은 이유).
    if (isDisposed()) return { outcome: 'disposed', processed: 0, errors: 0 };

    // ★ 한 바퀴가 아직 돌고 있으면 새로 시작하지 않는다.
    if (retryInFlight) {
      emit({ type: 'skipped' });
      return { outcome: 'skipped', processed: 0, errors: 0 };
    }
    retryInFlight = true;

    let processed = 0;
    let errors = 0;
    try {
      const rows = opts.ledger.pendingRetries(opts.limit);
      // ★ 순차로 보낸다. 동시에 쏘면 디스코드가 막 회복한 순간에 다시 몰아친다.
      for (const row of rows) {
        if (isDisposed()) break;
        processed += 1;
        try {
          await opts.send(row);
        } catch (e: unknown) {
          errors += 1;
          emit({
            type: 'send-failed',
            row,
            reason: e instanceof Error ? e.message : String(e),
          });
        }
      }
      emit({ type: 'tick', processed });
      return { outcome: 'ran', processed, errors };
    } catch (e: unknown) {
      // 대기열을 읽는 것 자체가 실패했다 (DB 가 닫혔거나 손상됐다).
      emit({ type: 'read-failed', reason: e instanceof Error ? e.message : String(e) });
      return { outcome: 'failed', processed, errors };
    } finally {
      // ★★ finally 여야 한다 — 예외 시 영구 잠김 방지 (계획 §S3 FM5).
      retryInFlight = false;
    }
  }

  return {
    get inFlight() {
      return retryInFlight;
    },

    start(): void {
      if (isDisposed() || timer !== undefined) return;
      // 기동 직후 한 번 — 꺼져 있던 동안 쌓인 미발송 행을 회수한다 (AC-18 계열).
      void runOnce();
      timer = opts.clock.setInterval(() => {
        void runOnce();
      }, intervalMs);
    },

    runOnce,

    dispose(): void {
      disposed = true;
      timer?.dispose();
      timer = undefined;
    },
  };
}
