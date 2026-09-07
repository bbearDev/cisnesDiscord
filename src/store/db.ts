// 출처: chzzkbot src/store/db.ts (거의 그대로 — 계획 §14 · Principle 5 "차용은 복사한다")
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * DB 열기 — 계획 §S2.
 *
 * 기동 시 세 가지를 검사하고, 하나라도 실패하면 **기동을 거부한다.**
 *   ① sqlite_version >= 3.35   — RETURNING · DROP COLUMN 등을 쓴다
 *   ② foreign_keys = ON        — 켠 뒤 **실제로 켜졌는지 다시 읽어 확인한다**
 *   ③ integrity_check          — 손상된 DB 위에서 도는 것보다 멈추는 게 낫다
 *
 * "일단 돌려보고 나중에 터지게" 두지 않는 이유: 이 DB 에는 `announcement_ledger`
 * 가 들어 있고, 그 원장이 **중복 0 / 누락 0 의 유일한 근거**다 (계획 Principle 1).
 * 원장이 성립하지 않는 상태로 쓰기를 계속하면 같은 방송이 여러 번 공지된다.
 */

/** EX_SOFTWARE. "데이터가 성립하지 않는다"는 뜻으로 쓴다. */
export const DB_ERROR_EXIT_CODE = 70;

/** RETURNING 절이 3.35.0 부터다. */
export const MIN_SQLITE_VERSION = '3.35.0';

export type DbErrorKind = 'sqlite-version' | 'integrity' | 'open';

export class DbError extends Error {
  readonly kind: DbErrorKind;
  readonly detail: string;

  constructor(kind: DbErrorKind, message: string, detail = '') {
    super(message);
    this.name = 'DbError';
    this.kind = kind;
    this.detail = detail;
  }

  format(): string {
    const bar = '═'.repeat(64);
    return (
      `\n${bar}\n DB 오류 — 봇을 기동할 수 없습니다\n${bar}\n\n` +
      `  원인: ${this.message}\n` +
      (this.detail ? `  상세: ${this.detail}\n` : '') +
      `\n  복구 절차는 docs/runbook-ops.md 를 보십시오.\n${bar}\n`
    );
  }
}

/** "3.49.2" 같은 값을 숫자 배열로. 비교를 문자열로 하면 3.9 > 3.35 가 된다. */
function parseVersion(v: string): number[] {
  return v.split('.').map((p) => Number.parseInt(p, 10) || 0);
}

/** a >= b */
export function versionAtLeast(a: string, b: string): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

export interface OpenOptions {
  /** `:memory:` 도 받는다 (테스트) */
  path: string;
  /** 기본 true. 메모리 DB 는 WAL 을 쓸 수 없으므로 자동으로 건너뛴다 */
  wal?: boolean;
  /** 기본 true. 손상 검사는 큰 DB 에서 느릴 수 있어 테스트에서 끌 수 있게 둔다 */
  integrityCheck?: boolean;
  /**
   * 기본 MIN_SQLITE_VERSION. 테스트가 도달 불가능한 값을 넣어
   * **버전 게이트가 실제로 배선돼 있는지**를 확인하는 데 쓴다.
   * (구버전 SQLite 를 설치해 재현할 수는 없으므로 이 주입점이 유일한 검증 수단이다)
   */
  minVersion?: string;
}

export type Db = Database.Database;

export function openDb(opts: OpenOptions): Db {
  const { path } = opts;
  const memory = path === ':memory:' || path.startsWith('file::memory:');

  if (!memory) mkdirSync(dirname(path), { recursive: true });

  let db: Db;
  try {
    db = new Database(path);
  } catch (e: unknown) {
    throw new DbError(
      'open',
      `DB 파일을 열지 못했습니다: ${path}`,
      e instanceof Error ? e.message : String(e),
    );
  }

  try {
    // ① 버전. 열자마자 본다 — 이후 PRAGMA 가 구버전에서 다르게 동작할 수 있다.
    const min = opts.minVersion ?? MIN_SQLITE_VERSION;
    const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
    if (!versionAtLeast(row.v, min)) {
      throw new DbError(
        'sqlite-version',
        `SQLite ${min} 이상이 필요합니다 (현재 ${row.v})`,
        'better-sqlite3 를 재설치하거나 베이스 이미지를 올리십시오.',
      );
    }

    // ② 저널 모드. WAL 은 읽기와 쓰기가 서로를 막지 않게 한다.
    //    메모리 DB 에는 적용되지 않으므로 시도하지 않는다.
    if ((opts.wal ?? true) && !memory) {
      db.pragma('journal_mode = WAL');
    }

    // ③ 기본 내구성은 NORMAL. WAL 에서 NORMAL 은 체크포인트 시점에만 fsync 한다.
    //    "잃으면 되돌릴 수 없는" 트랜잭션만 FULL 로 올린다 (withFullSync).
    db.pragma('synchronous = NORMAL');

    // ④ FK. 스키마가 ON 을 전제로 짜여 있다 (websub_subscriptions → youtube_channels).
    //    켜기만 하고 확인하지 않으면 CASCADE 가 조용히 죽는다 — 그래서 **되읽어 검증한다.**
    db.pragma('foreign_keys = ON');
    const fk = db.pragma('foreign_keys', { simple: true });
    if (fk !== 1) {
      throw new DbError('open', 'foreign_keys 를 켤 수 없습니다', `현재 값: ${String(fk)}`);
    }

    // ⑤ 손상 검사.
    if (opts.integrityCheck ?? true) {
      const res = db.pragma('integrity_check', { simple: true });
      if (res !== 'ok') {
        throw new DbError('integrity', 'DB 무결성 검사에 실패했습니다', String(res));
      }
    }
  } catch (e: unknown) {
    db.close();
    if (e instanceof DbError) throw e;
    // better-sqlite3 는 **지연 열기**다. new Database() 는 성공하고
    // 첫 문장에서야 "file is not a database" 가 난다. 여기서 감싸지 않으면
    // 운영자가 런북 안내 대신 raw 스택 트레이스를 본다.
    const reason = e instanceof Error ? e.message : String(e);
    const corrupt = /not a database|malformed|encrypted|disk image/i.test(reason);
    throw new DbError(
      corrupt ? 'integrity' : 'open',
      corrupt
        ? 'DB 파일이 SQLite 데이터베이스가 아니거나 손상됐습니다'
        : 'DB 를 준비하지 못했습니다',
      `${path} — ${reason}`,
    );
  }

  return db;
}

/**
 * 이 트랜잭션 동안만 `synchronous = FULL` 로 올린다.
 *
 * 쓰는 곳: **공지 원장의 claim** (계획 Principle 1). claim 이 커밋되지 않은 채
 * 발송이 나가면 재기동 후 같은 이벤트를 다시 claim 해 **중복 공지**가 된다 —
 * 그건 되돌릴 수 없는 종류의 오류(§3-a 3위)라 그 한 트랜잭션에는 fsync 비용을 낸다.
 *
 * finally 로 되돌리는 게 핵심이다 — 예외가 나면 DB 전체가 FULL 로 남아
 * 이후 모든 쓰기가 느려진다.
 */
export function withFullSync<T>(db: Db, fn: () => T): T {
  const before = db.pragma('synchronous', { simple: true });
  db.pragma('synchronous = FULL');
  try {
    return db.transaction(fn)();
  } finally {
    db.pragma(`synchronous = ${String(before)}`);
  }
}
