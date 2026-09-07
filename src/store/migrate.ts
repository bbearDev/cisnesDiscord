// 출처: chzzkbot src/store/migrate.ts (거의 그대로 — 계획 §14)
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Db } from './db.js';

/**
 * 마이그레이션 러너 — 계획 §S2.
 *
 * 규칙은 셋뿐이다:
 *   ① 파일명이 `NNN_이름.sql` 이고 NNN 이 곧 버전이다
 *   ② 적용된 버전은 `schema_migrations` 에 남는다
 *   ③ **재실행이 멱등이다** — 이미 적용된 버전은 건드리지 않는다
 *
 * 각 마이그레이션은 **하나의 트랜잭션**으로 돈다. 중간에 실패하면 통째로 되돌아가고
 * `schema_migrations` 에도 남지 않는다. "절반만 적용된 스키마"는 손으로 고쳐야 하고,
 * 그 상태를 만들지 않는 것이 러너의 존재 이유다.
 */

const MIGRATION_FILE = /^(\d{3})_[a-z0-9_]+\.sql$/;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** 이 파일 기준의 migrations 디렉터리. 빌드 후에도 dist 안의 같은 위치를 가리킨다. */
export function defaultMigrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'migrations');
}

export function loadMigrations(dir: string = defaultMigrationsDir()): Migration[] {
  const found: Migration[] = [];
  const seen = new Map<number, string>();

  for (const file of readdirSync(dir).sort()) {
    const m = MIGRATION_FILE.exec(file);
    if (!m) {
      // 조용히 무시하면 오타 난 파일이 영원히 적용되지 않는다. .sql 이면 알린다.
      if (file.endsWith('.sql')) {
        throw new Error(
          `마이그레이션 파일명이 규칙에 맞지 않습니다: ${file}\n` +
            '  형식: NNN_이름.sql  (예: 001_init.sql)',
        );
      }
      continue;
    }
    const version = Number.parseInt(m[1] ?? '', 10);
    const prev = seen.get(version);
    if (prev !== undefined) {
      throw new Error(`마이그레이션 버전이 중복됩니다: ${String(version)} — ${prev} / ${file}`);
    }
    seen.set(version, file);
    found.push({ version, name: file, sql: readFileSync(join(dir, file), 'utf-8') });
  }

  found.sort((a, b) => a.version - b.version);
  return found;
}

/**
 * 장부 테이블은 **러너가 소유한다.**
 *
 * 001_init.sql 이 만들게 두면 러너가 "어느 마이그레이션이 우연히 만들어주는 테이블"에
 * 의존하게 된다. 001 을 쓰지 않는 DB(테스트·부분 복구)에서 러너가 통째로 죽는다 —
 * chzzkbot 에서 실제로 통합 테스트가 이 결함을 잡았다.
 * 장부는 마이그레이션의 산출물이 아니라 러너의 전제다.
 */
function ensureLedger(db: Db): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
}

function appliedVersions(db: Db): Set<number> {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get();
  if (!exists) return new Set();
  const rows = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[];
  return new Set(rows.map((r) => r.version));
}

export interface MigrateResult {
  applied: number[];
  skipped: number[];
}

export function migrate(db: Db, dir: string = defaultMigrationsDir()): MigrateResult {
  const migrations = loadMigrations(dir);
  ensureLedger(db);
  const already = appliedVersions(db);
  const result: MigrateResult = { applied: [], skipped: [] };

  for (const m of migrations) {
    if (already.has(m.version)) {
      result.skipped.push(m.version);
      continue;
    }

    // exec 는 여러 문장을 실행하지만 그 자체가 트랜잭션은 아니다.
    // 감싸지 않으면 중간 실패 시 절반만 적용된 스키마가 남는다.
    //
    // ★ better-sqlite3 의 db.transaction() 안에서는 exec 로 BEGIN 을 또 열 수 없으므로
    //   SQL 파일에 트랜잭션 문장을 넣지 않는다는 것이 마이그레이션 작성 규칙이다.
    //   같은 이유로 PRAGMA 도 쓰지 않는다 — 트랜잭션 안의 PRAGMA foreign_keys 는
    //   SQLite 가 **조용히 무시한다.** FK 는 db.ts 의 openDb 가 켜고 되읽어 확인한다.
    const run = db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        m.version,
        new Date().toISOString(),
      );
    });

    try {
      run();
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(`마이그레이션 ${m.name} 적용에 실패했습니다: ${reason}`);
    }
    result.applied.push(m.version);
  }

  return result;
}

/**
 * 적용된 최신 버전. 아직 아무것도 적용되지 않았으면 0.
 * `GET /healthz` 가 DB 버전을 싣는 데 쓴다 (계획 §S3).
 */
export function currentVersion(db: Db): number {
  const v = appliedVersions(db);
  return v.size === 0 ? 0 : Math.max(...v);
}
