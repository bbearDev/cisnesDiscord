import { describe, it, expect } from 'vitest';

import {
  createOutbox,
  OUTBOX_INTERVAL_MS,
  type Outbox,
  type OutboxEvent,
  type OutboxRow,
} from '../../src/runtime/outbox.js';
import { ManualClock } from '../../src/runtime/clock.js';

/**
 * ★ FM5 — 아웃박스 재진입 가드 (계획 §S3. **AC-17 이 이것 없이는 깨진다**).
 *
 * 원장 `claim` 은 웹훅 vs 아웃박스 경합을 막지만 **아웃박스 타이머 자신의 두 틱이
 * 겹치는 것은 막지 못한다.** 여기서 그 겹침을 인위적으로 만들어 같은 행이 두 번
 * 나가지 않는지 판정한다.
 */

const START = Date.parse('2026-09-07T00:00:00.000Z');

function row(eventKey: string, claimedAt = '2026-09-07T00:00:00.000Z'): OutboxRow {
  return { kind: 'live_start', eventKey, detectedVia: 'webhook', claimedAt, attempts: 0 };
}

/** 마이크로태스크 큐를 비운다 — `start()` 가 돌린 바퀴는 프라미스를 돌려주지 않는다 */
function flush(): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, 0);
  });
}

/** 손으로 풀 수 있는 프라미스 — 한 바퀴를 원하는 시점에 멈춰 둔다 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('outbox — 회수', () => {
  it('기동 시 한 번 돌고 그 뒤로는 주기마다 돈다', async () => {
    const clock = new ManualClock(START);
    const sentKeys: string[] = [];
    const outbox = createOutbox({
      ledger: { pendingRetries: () => [row('a')] },
      send: (r) => {
        sentKeys.push(r.eventKey);
        return Promise.resolve();
      },
      clock,
    });

    outbox.start();
    await flush();
    expect(sentKeys).toEqual(['a']); // 꺼져 있던 동안 쌓인 것을 기동 즉시 회수한다

    clock.advance(OUTBOX_INTERVAL_MS);
    await flush();
    expect(sentKeys).toEqual(['a', 'a']);

    outbox.dispose();
    clock.advance(OUTBOX_INTERVAL_MS * 5);
    await flush();
    expect(sentKeys).toHaveLength(2);
    expect(clock.pending).toBe(0); // 타이머를 남기지 않는다
  });

  it('★ 순차로 보낸다 — 동시에 쏘면 막 회복한 디스코드에 다시 몰아친다', async () => {
    const clock = new ManualClock(START);
    let concurrent = 0;
    let peak = 0;
    const order: string[] = [];

    const outbox = createOutbox({
      ledger: { pendingRetries: () => [row('a'), row('b'), row('c')] },
      send: async (r) => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await flush();
        order.push(r.eventKey);
        concurrent -= 1;
      },
      clock,
    });

    const tick = await outbox.runOnce();
    expect(tick).toEqual({ outcome: 'ran', processed: 3, errors: 0 });
    expect(order).toEqual(['a', 'b', 'c']);
    expect(peak).toBe(1);
  });

  it('진단 콜백이 던져도 회수가 계속된다 (Principle 2)', async () => {
    const clock = new ManualClock(START);
    const sentKeys: string[] = [];
    const outbox = createOutbox({
      ledger: { pendingRetries: () => [row('a')] },
      send: (r) => {
        sentKeys.push(r.eventKey);
        return Promise.resolve();
      },
      clock,
      onEvent: () => {
        throw new Error('로그 수집기가 죽었다');
      },
    });

    expect(await outbox.runOnce()).toMatchObject({ outcome: 'ran', processed: 1 });
    expect(sentKeys).toEqual(['a']);
  });

  it('limit 을 그대로 원장에 넘긴다', async () => {
    const clock = new ManualClock(START);
    let seen: number | undefined;
    const outbox = createOutbox({
      ledger: {
        pendingRetries: (limit) => {
          seen = limit;
          return [];
        },
      },
      send: () => Promise.resolve(),
      clock,
      limit: 5,
    });
    await outbox.runOnce();
    expect(seen).toBe(5);
  });
});

describe('outbox — ★ FM5 재진입 가드', () => {
  it('★★ 틱 2개를 인위적으로 겹쳐도 같은 행이 두 번 나가지 않는다 (AC-17)', async () => {
    const clock = new ManualClock(START);
    const gate = deferred();
    const sentKeys: string[] = [];
    let reads = 0;
    const events: OutboxEvent[] = [];

    const outbox = createOutbox({
      ledger: {
        pendingRetries: () => {
          reads += 1;
          return [row('same-hash')];
        },
      },
      send: async (r) => {
        sentKeys.push(r.eventKey);
        await gate.promise; // 첫 바퀴를 여기서 멈춰 둔다
      },
      clock,
      onEvent: (e) => events.push(e),
    });

    // 첫 틱은 send 안에서 멈춰 있다. 그 사이에 두 번째 틱이 온다.
    const first = outbox.runOnce();
    await flush();
    expect(outbox.inFlight).toBe(true);

    const second = await outbox.runOnce();
    expect(second).toEqual({ outcome: 'skipped', processed: 0, errors: 0 });
    // ★ 두 번째 틱은 대기열을 **읽지도 않는다** — 읽는 것 자체가 경합의 시작이다.
    expect(reads).toBe(1);
    expect(events.some((e) => e.type === 'skipped')).toBe(true);

    gate.resolve();
    expect(await first).toMatchObject({ outcome: 'ran', processed: 1 });
    // 가드가 없으면 여기가 ['same-hash', 'same-hash'] 가 된다.
    expect(sentKeys).toEqual(['same-hash']);
  });

  it('★ 주기 타이머가 겹쳐 발화해도 같은 결과다', async () => {
    const clock = new ManualClock(START);
    const gate = deferred();
    const sentKeys: string[] = [];

    const outbox = createOutbox({
      ledger: { pendingRetries: () => [row('same-hash')] },
      send: async (r) => {
        sentKeys.push(r.eventKey);
        await gate.promise;
      },
      clock,
      intervalMs: 1_000,
    });

    outbox.start(); // 기동 1회 — send 안에서 멈춘다
    await flush();
    // 한 바퀴가 아직 안 끝났는데 틱이 다섯 번 더 온다.
    clock.advance(5_000);
    await flush();
    expect(outbox.inFlight).toBe(true);

    gate.resolve();
    await flush();
    expect(sentKeys).toEqual(['same-hash']);
    outbox.dispose();
  });

  it('★ 대기열 읽기가 던져도 다음 틱이 정상 진입한다 (retryInFlight 를 finally 로 푼다)', async () => {
    const clock = new ManualClock(START);
    let boom = true;
    const sentKeys: string[] = [];
    const events: OutboxEvent[] = [];

    const outbox = createOutbox({
      ledger: {
        pendingRetries: () => {
          if (boom) throw new Error('DB 가 순간 잠겼다');
          return [row('a')];
        },
      },
      send: (r) => {
        sentKeys.push(r.eventKey);
        return Promise.resolve();
      },
      clock,
      onEvent: (e) => events.push(e),
    });

    expect(await outbox.runOnce()).toMatchObject({ outcome: 'failed' });
    // 플래그가 켜진 채 남으면 아웃박스가 **영구히 잠긴다** — 그러면 이후 모든
    // 미발송 공지가 조용히 사라지고, 침묵이라 지표에도 안 나타난다.
    expect(outbox.inFlight).toBe(false);
    expect(events.some((e) => e.type === 'read-failed')).toBe(true);

    boom = false;
    expect(await outbox.runOnce()).toMatchObject({ outcome: 'ran', processed: 1 });
    expect(sentKeys).toEqual(['a']);
  });

  it('★ 한 건의 발송 예외가 나머지 대기열을 날리지 않는다', async () => {
    const clock = new ManualClock(START);
    const sentKeys: string[] = [];
    const outbox = createOutbox({
      ledger: { pendingRetries: () => [row('a'), row('b'), row('c')] },
      send: (r) => {
        if (r.eventKey === 'b') return Promise.reject(new Error('발송기가 계약을 어겼다'));
        sentKeys.push(r.eventKey);
        return Promise.resolve();
      },
      clock,
    });

    const tick = await outbox.runOnce();
    expect(tick).toEqual({ outcome: 'ran', processed: 3, errors: 1 });
    expect(sentKeys).toEqual(['a', 'c']);
    expect(outbox.inFlight).toBe(false);
  });
});

describe('outbox — 종료', () => {
  it('★ 종료 중이면 아무것도 하지 않는다 (닫힌 DB 를 건드리지 않는다)', async () => {
    const clock = new ManualClock(START);
    let reads = 0;
    const outbox = createOutbox({
      ledger: {
        pendingRetries: () => {
          reads += 1;
          return [];
        },
      },
      send: () => Promise.resolve(),
      clock,
    });

    outbox.dispose();
    expect(await outbox.runOnce()).toEqual({ outcome: 'disposed', processed: 0, errors: 0 });
    expect(reads).toBe(0);

    // dispose 뒤의 start 도 타이머를 걸지 않는다.
    outbox.start();
    expect(clock.pending).toBe(0);
  });

  it('★ 한 바퀴 도는 중에 종료되면 남은 행을 건너뛴다', async () => {
    const clock = new ManualClock(START);
    const sentKeys: string[] = [];

    const outbox: Outbox = createOutbox({
      ledger: { pendingRetries: () => [row('a'), row('b'), row('c')] },
      send: (r) => {
        sentKeys.push(r.eventKey);
        if (r.eventKey === 'a') outbox.dispose();
        return Promise.resolve();
      },
      clock,
    });

    await outbox.runOnce();
    expect(sentKeys).toEqual(['a']);
  });

  it('start 를 두 번 불러도 타이머는 하나다', () => {
    const clock = new ManualClock(START);
    const outbox = createOutbox({
      ledger: { pendingRetries: () => [] },
      send: () => Promise.resolve(),
      clock,
    });
    outbox.start();
    outbox.start();
    expect(clock.pending).toBe(1);
    outbox.dispose();
  });
});
