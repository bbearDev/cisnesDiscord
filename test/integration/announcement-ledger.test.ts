import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, type Db } from '../../src/store/db.js';
import { migrate } from '../../src/store/migrate.js';
import {
  createAnnouncementLedgerRepo,
  ANNOUNCEMENT_KINDS,
  DETECTED_VIA,
  MAX_LAST_ERROR,
  type AnnouncementLedgerRepo,
} from '../../src/store/repos/announcement-ledger-repo.js';

/**
 * ★★ 공지 원장 — **중복 0 / 누락 0 의 단일 진실원** (계획 Principle 1 · §9.2).
 *
 * *"중복 0 / 누락 0 은 조건문이 아니라 DB UNIQUE 제약이 지킨다."*
 * 그 문장이 **저장소 API 수준에서도** 참인지 여기서 판정한다.
 */

let dir: string;
let db: Db;
let repo: AnnouncementLedgerRepo;

const NOW = '2026-09-07T00:00:00.000Z';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cisnes-ledger-'));
  db = openDb({ path: ':memory:' });
  migrate(db);
  repo = createAnnouncementLedgerRepo(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('claim — 발송권은 한 명만 집는다', () => {
  it('★★ 같은 키로 100회 선점하면 true 는 정확히 1회다', () => {
    const results: boolean[] = [];
    for (let i = 0; i < 100; i++) {
      // 웹훅·폴링·복구가 같은 방송을 들고 와도 문은 하나다.
      results.push(repo.claim('live_start', 'df09256e', NOW, i % 2 === 0 ? 'webhook' : 'api-poll'));
    }
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results[0]).toBe(true);
  });

  it('처음 집은 쪽의 detected_via 가 남는다 (진 쪽이 덮어쓰지 않는다)', () => {
    expect(repo.claim('live_start', 'df09256e', NOW, 'webhook')).toBe(true);
    expect(repo.claim('live_start', 'df09256e', '2026-09-07T00:05:00.000Z', 'api-poll')).toBe(false);

    const row = repo.get('live_start', 'df09256e');
    expect(row).toMatchObject({ detectedVia: 'webhook', claimedAt: NOW, attempts: 0 });
  });

  it('kind 가 다르면 같은 키라도 별개다', () => {
    expect(repo.claim('live_start', 'same', NOW, 'webhook')).toBe(true);
    expect(repo.claim('youtube_upload', 'same', NOW, 'websub')).toBe(true);
  });

  it('★ seeded=1 은 유튜브 경로에서만 선다 (계획 rev.4 B-1)', () => {
    expect(repo.claim('youtube_upload', 'video-1', NOW, 'seed', { seeded: true })).toBe(true);
    expect(repo.get('youtube_upload', 'video-1')?.seeded).toBe(true);

    // 라이브 경로에 seeded 행을 세우면 이후 announce 의 claim 이 **반드시 실패**해
    // 방송 공지가 영영 나가지 않는다. 주석이 아니라 CHECK 가 막는다.
    expect(() => repo.claim('live_start', 'hash', NOW, 'webhook', { seeded: true })).toThrow(
      /CHECK constraint/i,
    );
  });

  it('상수 목록이 스키마 CHECK 와 어긋나면 INSERT 가 거부된다', () => {
    // ★ 목록이 갈리는 사고는 "공지를 선점하려던 순간"에만 드러난다 —
    //   그래서 여기서 전수로 넣어 본다.
    for (const kind of ANNOUNCEMENT_KINDS) {
      for (const via of DETECTED_VIA) {
        if (kind === 'live_start' && (via === 'websub' || via === 'rss' || via === 'seed')) continue;
        if (kind === 'youtube_upload' && (via === 'webhook' || via === 'api-poll')) continue;
        expect(repo.claim(kind, `${kind}-${via}`, NOW, via)).toBe(true);
      }
    }
  });
});

describe('★ 재시작 관통 (AC-18)', () => {
  it('★★ 프로세스를 내리고 DB 를 새로 열어도 같은 키는 false 다', () => {
    const path = join(dir, 'ledger.db');

    const first = openDb({ path });
    migrate(first);
    expect(createAnnouncementLedgerRepo(first).claim('live_start', 'df09256e', NOW, 'webhook')).toBe(
      true,
    );
    first.close();

    // ★ 여기가 AC-18 의 전부다. 메모리 집합으로 중복을 막았다면 이 줄에서 true 가 되고,
    //   재배포마다 같은 방송이 다시 공지된다.
    const second = openDb({ path });
    migrate(second);
    expect(
      createAnnouncementLedgerRepo(second).claim('live_start', 'df09256e', NOW, 'api-poll'),
    ).toBe(false);
    second.close();
  });
});

describe('markSent / markFailed', () => {
  beforeEach(() => {
    repo.claim('live_start', 'df09256e', NOW, 'webhook');
  });

  it('★ 성공에서는 attempts 를 올리지 않는다 (chzzkbot 의 규칙을 승계)', () => {
    repo.markSent('live_start', 'df09256e', 'msg-1', '2026-09-07T00:00:01.000Z');
    const row = repo.get('live_start', 'df09256e');

    // attempts=1 로 남으면 한 번에 나간 건이 "한 번 실패했다 성공" 으로 읽힌다.
    expect(row).toMatchObject({ attempts: 0, messageId: 'msg-1' });
    expect(row?.announcedAt).toBe('2026-09-07T00:00:01.000Z');
    expect(row?.lastError).toBeUndefined();
  });

  it('실패는 횟수를 올리고 올린 값을 돌려준다', () => {
    expect(repo.markFailed('live_start', 'df09256e', '503', NOW)).toBe(1);
    expect(repo.markFailed('live_start', 'df09256e', '503', NOW)).toBe(2);
    expect(repo.get('live_start', 'df09256e')?.attempts).toBe(2);
  });

  it('선점하지 않은 키의 실패는 0 이다 (고칠 행이 없다)', () => {
    expect(repo.markFailed('live_start', '없는키', 'boom', NOW)).toBe(0);
  });

  it('실패 사유에 시각을 싣고 길이를 자른다', () => {
    repo.markFailed('live_start', 'df09256e', 'x'.repeat(5_000), NOW);
    const err = repo.get('live_start', 'df09256e')?.lastError ?? '';
    // 디스코드가 HTML 오류 페이지를 통째로 돌려줘도 한 행이 수십 KB 가 되지 않는다.
    expect(err.length).toBe(MAX_LAST_ERROR);
    expect(err.startsWith(NOW)).toBe(true);
  });

  it('실패 뒤 성공하면 사유가 지워진다', () => {
    repo.markFailed('live_start', 'df09256e', '503', NOW);
    repo.markSent('live_start', 'df09256e', 'msg-9', NOW);
    expect(repo.get('live_start', 'df09256e')?.lastError).toBeUndefined();
  });

  it('★ 발송 실패에 행을 지우지 않는다 — 지우면 폴백이 재선점해 중복이 난다', () => {
    repo.markFailed('live_start', 'df09256e', '503', NOW);
    expect(repo.claim('live_start', 'df09256e', NOW, 'api-poll')).toBe(false);
  });
});

describe('pendingRetries — 아웃박스가 회수할 행', () => {
  it('미발송 행만, 오래 기다린 것부터 준다', () => {
    repo.claim('live_start', 'old', '2026-09-07T00:00:00.000Z', 'webhook');
    repo.claim('youtube_upload', 'mid', '2026-09-07T00:05:00.000Z', 'websub');
    repo.claim('live_start', 'sent', '2026-09-07T00:01:00.000Z', 'api-poll');
    repo.markSent('live_start', 'sent', 'msg-1', NOW);

    expect(repo.pendingRetries().map((r) => r.eventKey)).toEqual(['old', 'mid']);
  });

  it('limit 을 넘기지 않는다', () => {
    for (let i = 0; i < 5; i++) {
      repo.claim('live_start', `k${String(i)}`, `2026-09-07T00:0${String(i)}:00.000Z`, 'webhook');
    }
    expect(repo.pendingRetries(2)).toHaveLength(2);
  });

  it('★ attempts 상한을 걸지 않는다 — 상한을 걸면 오래 죽어 있던 방송이 영영 안 나간다', () => {
    repo.claim('live_start', 'df09256e', NOW, 'webhook');
    for (let i = 0; i < 50; i++) repo.markFailed('live_start', 'df09256e', '503', NOW);

    // §3-a: 늦게 보내기(1위) > 안 보내기(2위). 최악이 "늦게 나간다" 로 남는다.
    const pending = repo.pendingRetries();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ eventKey: 'df09256e', attempts: 50 });
    expect(pending[0]?.lastError).toContain('503');
  });

  it('없는 행 조회는 undefined 다', () => {
    expect(repo.get('live_start', '없다')).toBeUndefined();
  });
});
