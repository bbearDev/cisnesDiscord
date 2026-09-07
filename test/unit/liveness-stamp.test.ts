import { describe, expect, it, vi } from 'vitest';

import {
  LAST_SEEN_KEY,
  LIVENESS_INTERVAL_MS,
  createLivenessStamp,
  readLastSeenAt,
} from '../../src/runtime/liveness-stamp.js';
import type { RuntimeStateStore } from '../../src/runtime/liveness-stamp.js';
import type { Clock, Disposable } from '../../src/runtime/clock.js';

/**
 * DB 생존 표식 (§S7).
 *
 * ★ 하트비트 **파일**과 다른 물건이다 — 파일은 바깥(워치독)이 "지금 살아 있는가"를 묻고,
 *   이 행은 다음 기동의 자신이 "마지막으로 살아 있던 때가 언제인가"를 묻는다.
 */

function memStore(): RuntimeStateStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: (k) => map.get(k),
    set: (k, v) => {
      map.set(k, v);
    },
  };
}

function fakeClock(atMs: number): Clock & { tick: () => void } {
  let fn: (() => void) | undefined;
  return {
    now: () => atMs,
    date: () => new Date(atMs),
    setTimeout: (): Disposable => ({ dispose: () => undefined }),
    setInterval: (f): Disposable => {
      fn = f;
      return {
        dispose: () => {
          fn = undefined;
        },
      };
    },
    tick: () => fn?.(),
  };
}

describe('생존 표식 기록', () => {
  it('ISO-8601 UTC 로 찍는다', () => {
    const store = memStore();
    const at = Date.parse('2026-09-06T19:00:00.000Z');
    createLivenessStamp({ store, clock: fakeClock(at) }).stampNow();
    expect(store.map.get(LAST_SEEN_KEY)).toBe('2026-09-06T19:00:00.000Z');
  });

  it('주기는 하트비트 파일과 같은 30초다', () => {
    expect(LIVENESS_INTERVAL_MS).toBe(30_000);
  });

  it('start 하면 주기적으로 찍고 stop 하면 멈춘다', () => {
    const store = memStore();
    const clock = fakeClock(Date.parse('2026-09-06T19:00:00.000Z'));
    const s = createLivenessStamp({ store, clock });
    s.start();
    clock.tick();
    expect(store.map.has(LAST_SEEN_KEY)).toBe(true);
    store.map.clear();
    s.stop();
    clock.tick();
    expect(store.map.has(LAST_SEEN_KEY)).toBe(false);
  });

  it('start 를 두 번 불러도 타이머가 겹치지 않는다', () => {
    const clock = fakeClock(1);
    const setInterval = vi.spyOn(clock, 'setInterval');
    const s = createLivenessStamp({ store: memStore(), clock });
    s.start();
    s.start();
    expect(setInterval).toHaveBeenCalledTimes(1);
  });

  it('★ 쓰기 실패가 본체를 죽이지 않는다 — 던지지 않고 기록만 한다', () => {
    const onError = vi.fn();
    const broken: RuntimeStateStore = {
      get: () => undefined,
      set: () => {
        throw new Error('DB 잠김');
      },
    };
    const s = createLivenessStamp({ store: broken, clock: fakeClock(1), onError });
    expect(() => {
      s.stampNow();
    }).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('생존 표식 읽기 — 모르는 것은 모른다고 둔다', () => {
  it('정상 값을 epoch ms 로 준다', () => {
    const store = memStore();
    store.map.set(LAST_SEEN_KEY, '2026-09-06T19:00:00.000Z');
    expect(readLastSeenAt(store)).toBe(Date.parse('2026-09-06T19:00:00.000Z'));
  });

  it.each([
    ['키가 없음', undefined],
    ['빈 문자열', ''],
    ['파싱 불가', 'not-a-date'],
  ])('%s 이면 undefined 다 — 0(에포크)으로 접지 않는다', (_label, value) => {
    // ★ 0 으로 접으면 다운타임이 56년으로 계산돼 AC-30 이 항상 발동하고,
    //   "표식이 깨졌다"와 "정말 오래 꺼져 있었다"가 구분되지 않는다.
    const store = memStore();
    if (value !== undefined) store.map.set(LAST_SEEN_KEY, value);
    expect(readLastSeenAt(store)).toBeUndefined();
  });
});
