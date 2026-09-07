// 출처: chzzkbot src/runtime/clock.ts (그대로 — 계획 §14)
/**
 * 시간 주입.
 *
 * 이 봇은 시간 위에 서 있다 — 웹훅 침묵 유예창(10분) · 폴링 주기(3분) ·
 * `confirmed` 고착 판정(5분) · 팔로워 스냅샷 나이(150분) · 다운타임 기준(6시간).
 * 이걸 전부 Date.now() 로 직접 읽으면 §9 의 경계 테스트가 실제로 150분을 기다려야
 * 하고, 그러면 아무도 그 테스트를 쓰지 않는다.
 *
 * 계획 §9.2 가 요구하는 "149:59 무경보 / 150:00 unknown" 같은 검증은
 * 시간을 주입할 수 있어야만 성립한다.
 */

export interface Clock {
  /** epoch milliseconds */
  now(): number;
  /** 지금 시각. 로그·DB 기록용 */
  date(): Date;
  /** setTimeout 대체. 테스트에서 즉시 실행하거나 수동 진행시킬 수 있다 */
  setTimeout(fn: () => void, ms: number): Disposable;
  /** setInterval 대체 */
  setInterval(fn: () => void, ms: number): Disposable;
}

export interface Disposable {
  dispose(): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  date: () => new Date(),
  setTimeout(fn, ms) {
    const t = setTimeout(fn, ms);
    return {
      dispose: () => {
        clearTimeout(t);
      },
    };
  },
  setInterval(fn, ms) {
    const t = setInterval(fn, ms);
    return {
      dispose: () => {
        clearInterval(t);
      },
    };
  },
};

interface Scheduled {
  fn: () => void;
  dueAt: number;
  intervalMs?: number;
  cancelled: boolean;
}

/**
 * 테스트용 수동 시계.
 *
 * advance(ms) 로 시간을 밀면 그 사이에 걸린 타이머가 순서대로 발화한다.
 * 실시간을 기다리지 않으므로 "6시간 뒤" 같은 검증이 밀리초 안에 끝난다.
 */
export class ManualClock implements Clock {
  private current: number;
  private readonly scheduled = new Set<Scheduled>();

  constructor(startMs = 0) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  date(): Date {
    return new Date(this.current);
  }

  setTimeout(fn: () => void, ms: number): Disposable {
    const item: Scheduled = { fn, dueAt: this.current + ms, cancelled: false };
    this.scheduled.add(item);
    return {
      dispose: () => {
        item.cancelled = true;
        this.scheduled.delete(item);
      },
    };
  }

  setInterval(fn: () => void, ms: number): Disposable {
    const item: Scheduled = {
      fn,
      dueAt: this.current + ms,
      intervalMs: ms,
      cancelled: false,
    };
    this.scheduled.add(item);
    return {
      dispose: () => {
        item.cancelled = true;
        this.scheduled.delete(item);
      },
    };
  }

  /** 시간을 ms 만큼 밀고, 그 사이에 걸린 콜백을 시각 순서대로 실행한다. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = [...this.scheduled]
        .filter((s) => !s.cancelled && s.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt);
      const next = due[0];
      if (!next) break;

      this.current = next.dueAt;
      if (next.intervalMs === undefined) {
        this.scheduled.delete(next);
      } else {
        next.dueAt = this.current + next.intervalMs;
      }
      next.fn();
    }
    this.current = target;
  }

  /** 예약된 타이머 수 — 정리 누락(리크) 검증에 쓴다. */
  get pending(): number {
    return this.scheduled.size;
  }
}
