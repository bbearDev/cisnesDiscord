import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { acquireLock, LockHeldError } from '../../src/runtime/single-instance.js';

/**
 * 단일 인스턴스 락 (AC-35).
 *
 * 계획 §S2 수용 기준 2줄을 그대로 판정한다:
 *   - 락 보유 중 재시도 → `LockHeldError`
 *   - 죽은 PID 인수
 */

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cisnes-lock-'));
  lockPath = join(dir, 'nested', 'cisnes.lock');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 확실히 죽은 PID. 자식을 띄웠다 끝내고 그 번호를 쓴다. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  return child.pid;
}

describe('acquireLock', () => {
  it('락 파일이 없으면 잡고, 없던 디렉터리도 만든다', () => {
    const lock = acquireLock(lockPath, 4242);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf-8').trim()).toBe('4242');
    lock.release();
  });

  it('★ 살아 있는 다른 프로세스가 쥐고 있으면 LockHeldError', () => {
    // 이 테스트 프로세스는 확실히 살아 있다.
    acquireLock(lockPath, process.pid);

    expect(() => acquireLock(lockPath, 999_001)).toThrow(LockHeldError);
    try {
      acquireLock(lockPath, 999_001);
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(LockHeldError);
      expect((e as LockHeldError).holderPid).toBe(process.pid);
    }
  });

  it('★ 죽은 PID 의 락은 인수한다 — 크래시 한 번에 사람이 손으로 지워야 하면 안 된다', () => {
    const stale = deadPid();
    acquireLock(lockPath, stale);
    expect(readFileSync(lockPath, 'utf-8').trim()).toBe(String(stale));

    const lock = acquireLock(lockPath, 4243);
    expect(readFileSync(lockPath, 'utf-8').trim()).toBe('4243');
    lock.release();
  });

  it('같은 PID 가 다시 잡는 것은 막지 않는다 (재진입)', () => {
    acquireLock(lockPath, 4244);
    expect(() => acquireLock(lockPath, 4244)).not.toThrow();
  });

  it('release 는 자기 락만 지운다 — 인수당한 뒤 남의 락을 풀지 않는다', () => {
    const mine = acquireLock(lockPath, 4245);
    // 다른 프로세스가 인수한 상황을 만든다
    writeFileSync(lockPath, '4246\n', 'utf-8');
    mine.release();
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf-8').trim()).toBe('4246');
  });

  it('release 는 두 번 불러도 안전하다', () => {
    const lock = acquireLock(lockPath, 4247);
    lock.release();
    expect(() => {
      lock.release();
    }).not.toThrow();
    expect(existsSync(lockPath)).toBe(false);
  });
});
