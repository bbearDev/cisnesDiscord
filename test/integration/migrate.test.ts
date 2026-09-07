import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, DbError, versionAtLeast, withFullSync, type Db } from '../../src/store/db.js';
import {
  migrate,
  loadMigrations,
  currentVersion,
  defaultMigrationsDir,
} from '../../src/store/migrate.js';

/**
 * 마이그레이션 러너 — 실 SQLite (계획 §S2 수용 기준).
 *
 *   - `migrate()` 2회 연속 후 스키마 덤프 동일 (멱등)
 *   - 중복 버전 파일 → throw
 *   - 중간 실패 시 `schema_migrations` 에 미기록
 */

let tmp: string;
let db: Db;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cisnes-migrate-'));
  db = openDb({ path: ':memory:' });
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** 스키마의 완전한 지문. 테이블·인덱스의 DDL 원문까지 비교한다. */
function schemaDump(d: Db): string {
  const rows = d
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all();
  return JSON.stringify(rows, null, 2);
}

function writeMigrations(files: Record<string, string>): string {
  const dir = join(tmp, 'migrations');
  mkdirSync(dir, { recursive: true });
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(dir, name), sql, 'utf-8');
  }
  return dir;
}

describe('openDb — 기동 게이트', () => {
  it('★ foreign_keys 가 실제로 켜졌는지 되읽어 확인한다', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('★ sqlite 버전 게이트가 배선돼 있다', () => {
    // 구버전 SQLite 를 설치해 재현할 수 없으므로 도달 불가능한 값을 주입해 확인한다.
    expect(() => openDb({ path: ':memory:', minVersion: '99.0.0' })).toThrow(DbError);
  });

  it('버전 비교를 문자열로 하지 않는다 (3.9 > 3.35 함정)', () => {
    expect(versionAtLeast('3.9.0', '3.35.0')).toBe(false);
    expect(versionAtLeast('3.49.2', '3.35.0')).toBe(true);
    expect(versionAtLeast('3.35.0', '3.35.0')).toBe(true);
  });

  it('SQLite 데이터베이스가 아닌 파일은 integrity 로 거부한다', () => {
    const bogus = join(tmp, 'bogus.db');
    writeFileSync(bogus, '이건 DB 가 아닙니다', 'utf-8');
    let err: DbError | undefined;
    try {
      openDb({ path: bogus });
    } catch (e: unknown) {
      err = e as DbError;
    }
    expect(err).toBeInstanceOf(DbError);
    expect(err?.kind).toBe('integrity');
    expect(err?.format()).toContain('DB 오류');
  });

  it('withFullSync 는 예외가 나도 synchronous 를 되돌린다', () => {
    const before = db.pragma('synchronous', { simple: true });
    expect(() =>
      withFullSync(db, () => {
        throw new Error('트랜잭션 안에서 터짐');
      }),
    ).toThrow();
    expect(db.pragma('synchronous', { simple: true })).toBe(before);
  });
});

describe('migrate — 멱등', () => {
  it('★ 001_init 을 2회 연속 적용해도 스키마 덤프가 동일하다', () => {
    const first = migrate(db);
    const dumpAfterFirst = schemaDump(db);

    const second = migrate(db);
    const dumpAfterSecond = schemaDump(db);

    expect(first.applied).toEqual([1]);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual([1]);
    expect(dumpAfterSecond).toBe(dumpAfterFirst);
    expect(currentVersion(db)).toBe(1);
  });

  it('001_init.sql 에 PRAGMA · BEGIN 이 없다 (러너가 트랜잭션을 소유한다)', () => {
    const [init] = loadMigrations(defaultMigrationsDir());
    expect(init).toBeDefined();
    // 트랜잭션 안의 PRAGMA foreign_keys 는 SQLite 가 조용히 무시하고,
    // db.transaction() 안에서는 exec 로 BEGIN 을 다시 열 수 없다.
    expect(/^\s*PRAGMA\b/im.test(init?.sql ?? '')).toBe(false);
    expect(/^\s*(BEGIN|COMMIT|ROLLBACK)\b/im.test(init?.sql ?? '')).toBe(false);
  });

  it('★ schema_migrations 는 러너가 소유한다 — 001 없이도 돈다', () => {
    const dir = writeMigrations({ '007_only.sql': 'CREATE TABLE only_me (x TEXT);' });
    expect(() => migrate(db, dir)).not.toThrow();
    expect(currentVersion(db)).toBe(7);
  });

  it('빈 디렉터리에서도 죽지 않는다', () => {
    const dir = writeMigrations({});
    expect(migrate(db, dir)).toEqual({ applied: [], skipped: [] });
    expect(currentVersion(db)).toBe(0);
  });
});

describe('migrate — 거부 조건', () => {
  it('★ 버전 번호가 중복되면 throw', () => {
    const dir = writeMigrations({
      '001_alpha.sql': 'CREATE TABLE a (x TEXT);',
      '001_beta.sql': 'CREATE TABLE b (x TEXT);',
    });
    expect(() => migrate(db, dir)).toThrow(/중복/);
  });

  it('파일명이 규칙에 안 맞는 .sql 은 조용히 무시하지 않는다', () => {
    const dir = writeMigrations({ 'init.sql': 'CREATE TABLE a (x TEXT);' });
    expect(() => migrate(db, dir)).toThrow(/파일명/);
  });

  it('.sql 이 아닌 파일은 그냥 건너뛴다', () => {
    const dir = writeMigrations({
      '001_ok.sql': 'CREATE TABLE a (x TEXT);',
      'README.md': '설명',
    });
    expect(migrate(db, dir).applied).toEqual([1]);
  });
});

describe('migrate — 중간 실패', () => {
  it('★★ 실패한 마이그레이션은 schema_migrations 에 남지 않고 부분 적용도 없다', () => {
    const dir = writeMigrations({
      '001_ok.sql': 'CREATE TABLE good (x TEXT);',
      '002_bad.sql': 'CREATE TABLE half (x TEXT);\nTHIS IS NOT SQL;',
    });

    expect(() => migrate(db, dir)).toThrow(/002_bad\.sql/);

    // 001 은 남고 002 는 통째로 되돌아간다.
    expect(currentVersion(db)).toBe(1);
    const applied = db.prepare('SELECT version FROM schema_migrations').all() as {
      version: number;
    }[];
    expect(applied.map((r) => r.version)).toEqual([1]);

    // ★ "절반만 적용된 스키마" 가 남지 않는 것이 러너의 존재 이유다.
    const half = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='half'")
      .get();
    expect(half).toBeUndefined();
  });

  it('실패 뒤 고쳐서 다시 돌리면 이어서 적용된다', () => {
    const dir = writeMigrations({
      '001_ok.sql': 'CREATE TABLE good (x TEXT);',
      '002_bad.sql': 'THIS IS NOT SQL;',
    });
    expect(() => migrate(db, dir)).toThrow();

    writeFileSync(join(dir, '002_bad.sql'), 'CREATE TABLE later (x TEXT);', 'utf-8');
    expect(migrate(db, dir).applied).toEqual([2]);
    expect(currentVersion(db)).toBe(2);
  });
});
