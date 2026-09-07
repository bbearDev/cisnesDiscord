/**
 * DB 생존 표식 — `runtime_state.last_seen_at` (계획 §S7, AC-29/30).
 *
 * ★ **하트비트 파일과 별개다.** 둘은 서로 다른 질문에 답한다:
 *   - `heartbeat.ts`(파일 mtime) — *"프로세스가 지금 살아 있는가"* 를 **바깥**(워치독)이 묻는다
 *   - 이 모듈(DB 행) — *"우리가 마지막으로 살아 있던 시각이 언제인가"* 를 **다음 기동의 자신**이 묻는다
 *
 *   파일로 다운타임을 재면 안 되는 이유: 하트비트 파일은 배포·볼륨 정리로 쉽게 사라지고,
 *   사라지면 나이를 잃어 **다운타임이 0 처럼 보인다.** 그러면 밀린 알림 판정(AC-29/30)이
 *   조용히 틀린다. DB 행은 원장과 같은 파일에 살아 함께 백업되고 함께 복원된다.
 *
 * ★ 쓰기 실패가 본체를 죽이지 않는다 (Principle 2). 표식이 낡으면 다음 기동이
 *   다운타임을 **실제보다 길게** 볼 뿐인데, 그 방향은 안전하다 —
 *   길게 보면 AC-30 으로 생략하고 기록을 남긴다(관측 가능). 짧게 보면 조용히 도배한다.
 */

import type { Clock, Disposable } from './clock.js';

/** 갱신 주기. 하트비트 파일과 같은 30초 */
export const LIVENESS_INTERVAL_MS = 30_000;

/** `runtime_state` 의 키 이름 — 저장소 구현과 **한 글자도 다르면 안 된다** */
export const LAST_SEEN_KEY = 'last_seen_at';

/**
 * `runtime_state` 포트.
 *
 * ★ 저장소 구현은 US-007 composition-root 가 꽂는다. 여기서 인터페이스로 두는 이유는
 *   이 모듈이 L1(runtime) 이라 L2(store) 를 직접 알면 계층이 뒤집히기 때문이다.
 */
export interface RuntimeStateStore {
  get(key: string): string | undefined;
  set(key: string, value: string, at: string): void;
}

export interface LivenessStampOptions {
  store: RuntimeStateStore;
  clock: Clock;
  intervalMs?: number;
  /** 쓰기 실패를 남길 곳. **던지지 않는다** */
  onError?: (detail: string) => void;
}

export interface LivenessStamp {
  /** 지금 한 번 찍는다. 기동 직후 1회 + 주기 실행이 부른다 */
  stampNow(): void;
  start(): void;
  stop(): void;
}

export function createLivenessStamp(opts: LivenessStampOptions): LivenessStamp {
  const intervalMs = opts.intervalMs ?? LIVENESS_INTERVAL_MS;
  let timer: Disposable | undefined;

  function stampNow(): void {
    try {
      const iso = opts.clock.date().toISOString();
      opts.store.set(LAST_SEEN_KEY, iso, iso);
    } catch (e: unknown) {
      // ★ 삼킨다. 표식을 못 찍는 것은 알림 기능의 문제이지 봇을 멈출 이유가 아니다.
      opts.onError?.(e instanceof Error ? e.message : String(e));
    }
  }

  return {
    stampNow,
    start(): void {
      if (timer !== undefined) return;
      timer = opts.clock.setInterval(stampNow, intervalMs);
    },
    stop(): void {
      timer?.dispose();
      timer = undefined;
    },
  };
}

/**
 * 마지막 생존 시각을 읽는다. 없거나 파싱 불가면 `undefined`.
 *
 * ★ 파싱 불가를 **0(에포크)으로 접지 않는다.** 접으면 다운타임이 56년으로 계산돼
 *   AC-30 이 항상 발동하고, "표식이 깨졌다"와 "정말 오래 꺼져 있었다"가 구분되지 않는다.
 *   모르는 것은 모른다고 둔다 (Principle 3).
 */
export function readLastSeenAt(store: RuntimeStateStore): number | undefined {
  const raw = store.get(LAST_SEEN_KEY);
  if (raw === undefined || raw === '') return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : ms;
}
