// 출처: chzzkbot src/runtime/single-instance.ts (그대로 — 계획 §14)
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 단일 인스턴스 강제 — data/cisnes.lock (AC-35).
 *
 * 왜 필요한가: 중복 0 을 지키는 것은 `announcement_ledger` 의 PK 이고,
 * 그 원장은 **하나의 SQLite 파일**이다. 두 프로세스가 같은 파일을 열면
 * 원장 자체는 버티지만(PK 가 막는다) 폴링·아웃박스·WebSub 갱신이 2배로 돌고,
 * `verification_sessions` 의 동시 상한(§5.6.2)과 디스코드 게이트웨이 세션이
 * 서로를 밀어낸다. 계획 §5.4 가 D1(단일 프로세스)을 고른 이유가 이것이다.
 *
 * flock 은 Node 표준에 없으므로 PID + 생존 확인 방식을 쓴다.
 * 크래시로 남은 락은 그 PID 가 죽어 있으면 인수한다 — 안 그러면 크래시 한 번에
 * 사람이 손으로 락 파일을 지워야 봇이 다시 뜬다.
 *
 * ★ 락이 유일한 방어는 아니다. 계획 rev.3 ⑩ 은 **포트 바인드(8081)를 락
 *   프로토콜의 1차 프리미티브**로 삼았다 — EADDRINUSE 가 파일 락보다 먼저,
 *   그리고 더 확실하게 두 번째 인스턴스를 막는다. 이 파일은 그 뒤를 받는다.
 */

export class LockHeldError extends Error {
  readonly holderPid: number;
  constructor(path: string, holderPid: number) {
    super(
      `다른 인스턴스가 이미 실행 중입니다 (pid ${String(holderPid)}). 락: ${path}\n` +
        '두 프로세스가 같은 원장·같은 게이트웨이 세션을 쓰면 폴링과 발송이 겹칩니다.',
    );
    this.name = 'LockHeldError';
    this.holderPid = holderPid;
  }
}

export interface InstanceLock {
  readonly path: string;
  release(): void;
}

/** 그 PID 가 살아 있는가. 시그널 0 은 실제로 보내지 않고 존재만 확인한다. */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    // EPERM = 살아 있지만 다른 사용자 소유 → 살아 있는 것으로 본다
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function acquireLock(path: string, pid = process.pid): InstanceLock {
  mkdirSync(dirname(path), { recursive: true });

  let existing: number | undefined;
  try {
    const raw = readFileSync(path, 'utf-8').trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) existing = parsed;
  } catch {
    // 락 파일이 없으면 그냥 잡는다.
  }

  if (existing !== undefined && existing !== pid && isAlive(existing)) {
    throw new LockHeldError(path, existing);
  }

  // 죽은 PID 의 락이거나 락이 없으면 인수한다.
  writeFileSync(path, `${String(pid)}\n`, 'utf-8');

  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      try {
        // 내 락일 때만 지운다 — 인수당한 뒤 지우면 남의 락을 푼다.
        const raw = readFileSync(path, 'utf-8').trim();
        if (Number.parseInt(raw, 10) === pid) unlinkSync(path);
      } catch {
        // 이미 사라졌으면 할 일 없다.
      }
    },
  };
}
