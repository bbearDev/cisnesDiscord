import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ManualClock, systemClock, type Disposable } from '../../src/runtime/clock.js';
import { startHeartbeat, HEARTBEAT_INTERVAL_MS } from '../../src/runtime/heartbeat.js';
import { ShutdownManager } from '../../src/runtime/shutdown.js';

/** 기동·종료 주변 설비 — 계획 Principle 2 ("부가 기능이 본체를 죽이지 않는다"). */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cisnes-runtime-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ManualClock', () => {
  it('advance 로 밀면 걸린 타이머가 시각 순서대로 발화한다', () => {
    const clock = new ManualClock(0);
    const seen: string[] = [];
    clock.setTimeout(() => seen.push('늦게'), 200);
    clock.setTimeout(() => seen.push('먼저'), 100);
    clock.advance(300);
    expect(seen).toEqual(['먼저', '늦게']);
    expect(clock.now()).toBe(300);
  });

  it('setInterval 은 반복하고 dispose 로 멈춘다 (리크 검증에 쓰는 pending)', () => {
    const clock = new ManualClock(0);
    let n = 0;
    const h = clock.setInterval(() => n++, 100);
    clock.advance(350);
    expect(n).toBe(3);
    h.dispose();
    expect(clock.pending).toBe(0);
    clock.advance(1_000);
    expect(n).toBe(3);
  });

  it('systemClock 도 같은 계약을 만족한다', () => {
    const h = systemClock.setTimeout(() => undefined, 10_000);
    expect(systemClock.now()).toBeGreaterThan(0);
    expect(systemClock.date()).toBeInstanceOf(Date);
    h.dispose();
  });
});

describe('heartbeat', () => {
  it('기동 즉시 한 번 쓰고 주기마다 갱신한다', () => {
    const clock = new ManualClock(Date.parse('2026-09-07T00:00:00.000Z'));
    const path = join(dir, 'nested', 'heartbeat');
    const h = startHeartbeat({ path, clock });

    expect(readFileSync(path, 'utf-8').trim()).toBe('2026-09-07T00:00:00.000Z');
    expect(statSync(path).isFile()).toBe(true);

    clock.advance(HEARTBEAT_INTERVAL_MS);
    expect(readFileSync(path, 'utf-8').trim()).toBe('2026-09-07T00:00:30.000Z');
    h.dispose();
  });

  it('★ 쓰기 실패가 본체를 죽이지 않는다 — 알리기만 한다', () => {
    const clock = new ManualClock(0);
    const errors: unknown[] = [];

    // 평범한 파일을 만들어 두고 그 **아래**를 하트비트 경로로 준다.
    // mkdir 이 ENOTDIR 로 실패하므로 mkdir 을 try 밖에 뒀다면 여기서 던진다 —
    // 그것이 "부가 기능이 본체를 죽이는" 형태다 (계획 Principle 2).
    writeFileSync(join(dir, 'occupied'), 'x', 'utf-8');
    const blocked = join(dir, 'occupied', 'nested', 'beat');

    let h: Disposable | undefined;
    expect(() => {
      h = startHeartbeat({ path: blocked, clock, onError: (e) => errors.push(e) });
    }).not.toThrow();
    expect(errors).toHaveLength(1);
    h?.dispose();
  });
});

describe('ShutdownManager', () => {
  it('등록의 역순으로 정리한다 — 나중에 연 것을 먼저 닫는다', async () => {
    const order: string[] = [];
    const codes: number[] = [];
    const m = new ShutdownManager({
      exit: (c) => {
        codes.push(c);
      },
    });
    m.register('DB', () => {
      order.push('DB');
    });
    m.register('락', () => {
      order.push('락');
    });

    await m.shutdown('SIGTERM');
    expect(order).toEqual(['락', 'DB']);
    expect(codes).toEqual([0]);
  });

  it('하나가 실패해도 나머지 정리를 계속한다', async () => {
    const order: string[] = [];
    const failures: string[] = [];
    const m = new ShutdownManager({
      exit: () => undefined,
      onError: (label) => {
        failures.push(label);
      },
    });
    m.register('DB', () => {
      order.push('DB');
    });
    m.register('터짐', () => {
      throw new Error('정리 실패');
    });

    await m.shutdown('SIGINT');
    expect(failures).toEqual(['터짐']);
    expect(order).toEqual(['DB']);
  });

  it('시그널이 두 번 와도 한 번만 돈다', async () => {
    let runs = 0;
    const m = new ShutdownManager({ exit: () => undefined });
    m.register('한 번만', () => {
      runs++;
    });
    await m.shutdown('SIGTERM');
    await m.shutdown('SIGTERM');
    expect(runs).toBe(1);
  });

  it('★ 타임아웃을 넘겨도 종료한다 (정리가 끝나지 않는 경우)', async () => {
    const codes: number[] = [];
    const m = new ShutdownManager({
      timeoutMs: 5,
      exit: (c) => {
        codes.push(c);
      },
    });
    m.register('영원히', () => new Promise<void>(() => undefined));
    await m.shutdown('SIGTERM', 70);
    expect(codes).toEqual([70]);
  });

  it('install 은 핸들러를 붙였다 뗄 수 있다', () => {
    const m = new ShutdownManager({ exit: () => undefined });
    const before = process.listenerCount('SIGTERM');
    const off = m.install();
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    off();
    expect(process.listenerCount('SIGTERM')).toBe(before);
    expect(m.size).toBe(0);
  });
});
