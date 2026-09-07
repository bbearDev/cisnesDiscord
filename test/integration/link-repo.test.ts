import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { openDb, type Db } from '../../src/store/db.js';
import { migrate } from '../../src/store/migrate.js';
import {
  createLinkRepo,
  OPS_EVENT_DUPLICATE_CHANNEL,
  type LinkRepo,
} from '../../src/store/repos/link-repo.js';
import {
  createVerificationSessionRepo,
  type VerificationSessionRepo,
} from '../../src/store/repos/verification-session-repo.js';

/**
 * ★★ AC-7 / AC-8 / AC-9 — 제약이 판정하고, 거부는 아무것도 바꾸지 않는다.
 *
 *   AC-7  한 치지직 계정 → 디스코드 계정 1개 (UNIQUE (guild_id, chzzk_channel_id))
 *   AC-8  거부 시 **기존 행 무변화** + `ops_events` 1건
 *   AC-9  `/연동해제` 는 **삭제**한다 (soft-delete 금지)
 */

const GUILD = '1111111111';
const CHANNEL = 'c3355ea2b3bea6c646789510796379d6';
const OTHER_CHANNEL = '3594a5258433f765b6247dfe05e5fb33';
const T0 = '2026-09-07T00:00:00.000Z';
const T1 = '2026-09-07T00:05:00.000Z';

let db: Db;
let repo: LinkRepo;

beforeEach(() => {
  db = openDb({ path: ':memory:' });
  migrate(db);
  repo = createLinkRepo(db);
});

afterEach(() => {
  db.close();
});

describe('연동 생성', () => {
  it('처음이면 생성된다', () => {
    const r = repo.link({
      discordUserId: 'A',
      guildId: GUILD,
      chzzkChannelId: CHANNEL,
      chzzkChannelName: '시스네',
      at: T0,
    });
    expect(r).toMatchObject({ ok: true, created: true });
    expect(repo.get(GUILD, 'A')?.chzzkChannelName).toBe('시스네');
  });

  it('★ AC-12(a) — 같은 사람이 다시 하면 오류가 아니라 "이미 연동됨" 이다', () => {
    repo.link({
      discordUserId: 'A',
      guildId: GUILD,
      chzzkChannelId: CHANNEL,
      chzzkChannelName: '시스네',
      at: T0,
    });
    const again = repo.link({
      discordUserId: 'A',
      guildId: GUILD,
      chzzkChannelId: CHANNEL,
      chzzkChannelName: '시스네(변경됨)',
      at: T1,
    });
    expect(again).toMatchObject({ ok: true, created: false });
    // ★ 기존 행을 갱신하지 않는다 — 계정 갈아타기는 /연동해제 를 거치는 운영 동작이다
    expect(repo.get(GUILD, 'A')?.chzzkChannelName).toBe('시스네');
    expect(repo.get(GUILD, 'A')?.linkedAt).toBe(T0);
  });

  it('길드가 다르면 같은 치지직 채널도 각각 연동된다', () => {
    repo.link({
      discordUserId: 'A',
      guildId: GUILD,
      chzzkChannelId: CHANNEL,
      chzzkChannelName: '시스네',
      at: T0,
    });
    const other = repo.link({
      discordUserId: 'B',
      guildId: '2222222222',
      chzzkChannelId: CHANNEL,
      chzzkChannelName: '시스네',
      at: T0,
    });
    expect(other.ok).toBe(true);
  });
});

describe('★★ AC-7 / AC-8 — 중복 채널은 거부하고 기존 행을 건드리지 않는다', () => {
  beforeEach(() => {
    repo.link({
      discordUserId: 'A',
      guildId: GUILD,
      chzzkChannelId: CHANNEL,
      chzzkChannelName: '시스네',
      at: T0,
    });
  });

  it('다른 디스코드 계정이 같은 치지직 채널로 오면 거부된다', () => {
    const r = repo.link({
      discordUserId: 'B',
      guildId: GUILD,
      chzzkChannelId: CHANNEL,
      chzzkChannelName: '시스네',
      at: T1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('duplicate-channel');
      expect(r.existing.discordUserId).toBe('A');
    }
  });

  it('★ 기존 행이 무변화다 — 소유자도 이름도 시각도 그대로다', () => {
    const before = repo.get(GUILD, 'A');
    repo.link({
      discordUserId: 'B',
      guildId: GUILD,
      chzzkChannelId: CHANNEL,
      chzzkChannelName: '탈취시도',
      at: T1,
    });
    expect(repo.get(GUILD, 'A')).toEqual(before);
    expect(repo.getByChannel(GUILD, CHANNEL)?.discordUserId).toBe('A');
    // 거부된 쪽에는 행이 생기지 않았다
    expect(repo.get(GUILD, 'B')).toBeUndefined();
    expect(repo.count(GUILD)).toBe(1);
  });

  it('★ AC-8 — ops_events 에 정확히 1건 남는다', () => {
    repo.link({
      discordUserId: 'B',
      guildId: GUILD,
      chzzkChannelId: CHANNEL,
      chzzkChannelName: '시스네',
      at: T1,
    });
    const events = repo.opsEvents(OPS_EVENT_DUPLICATE_CHANNEL);
    expect(events).toHaveLength(1);
    expect(events[0]?.at).toBe(T1);
    const detail = JSON.parse(events[0]?.detail ?? '{}') as Record<string, unknown>;
    expect(detail).toMatchObject({ attemptedBy: 'B', heldBy: 'A', chzzkChannelId: CHANNEL });
  });

  it('시도가 3회면 기록도 3건이다 — 침묵하지 않는다', () => {
    for (const user of ['B', 'C', 'D']) {
      repo.link({
        discordUserId: user,
        guildId: GUILD,
        chzzkChannelId: CHANNEL,
        chzzkChannelName: '시스네',
        at: T1,
      });
    }
    expect(repo.opsEvents(OPS_EVENT_DUPLICATE_CHANNEL)).toHaveLength(3);
    expect(repo.count(GUILD)).toBe(1);
  });

  it('★ 같은 사람이 다른 채널로 오면 "이미 연동됨" 이지 중복 거부가 아니다', () => {
    const r = repo.link({
      discordUserId: 'A',
      guildId: GUILD,
      chzzkChannelId: OTHER_CHANNEL,
      chzzkChannelName: '아이곰',
      at: T1,
    });
    expect(r).toMatchObject({ ok: true, created: false });
    expect(repo.opsEvents(OPS_EVENT_DUPLICATE_CHANNEL)).toHaveLength(0);
    expect(repo.get(GUILD, 'A')?.chzzkChannelId).toBe(CHANNEL);
  });
});

describe('★ AC-9 — /연동해제 는 행을 삭제한다', () => {
  it('삭제하고 지운 행을 돌려준다', () => {
    repo.link({
      discordUserId: 'A',
      guildId: GUILD,
      chzzkChannelId: CHANNEL,
      chzzkChannelName: '시스네',
      at: T0,
    });
    const removed = repo.unlink(GUILD, 'A');
    expect(removed?.chzzkChannelName).toBe('시스네');
    expect(repo.get(GUILD, 'A')).toBeUndefined();
    expect(repo.count(GUILD)).toBe(0);
  });

  it('★★ 해제 뒤에는 같은 치지직 채널로 다시 연동할 수 있다 (soft-delete 였다면 막힌다)', () => {
    repo.link({
      discordUserId: 'A',
      guildId: GUILD,
      chzzkChannelId: CHANNEL,
      chzzkChannelName: '시스네',
      at: T0,
    });
    repo.unlink(GUILD, 'A');
    const again = repo.link({
      discordUserId: 'B',
      guildId: GUILD,
      chzzkChannelId: CHANNEL,
      chzzkChannelName: '시스네',
      at: T1,
    });
    expect(again).toMatchObject({ ok: true, created: true });
  });

  it('없는 연동을 해제하면 undefined 다 (오류가 아니다)', () => {
    expect(repo.unlink(GUILD, 'nobody')).toBeUndefined();
  });

  it('DB 에 실제로 행이 남지 않는다', () => {
    repo.link({
      discordUserId: 'A',
      guildId: GUILD,
      chzzkChannelId: CHANNEL,
      chzzkChannelName: '시스네',
      at: T0,
    });
    repo.unlink(GUILD, 'A');
    const rows = db.prepare('SELECT COUNT(*) AS n FROM account_links').get() as { n: number };
    expect(rows.n).toBe(0);
  });
});

describe('verification_sessions 저장소 — SQL 구현', () => {
  let sessions: VerificationSessionRepo;

  beforeEach(() => {
    sessions = createVerificationSessionRepo(db);
  });

  function insert(state: string, user: string, created: string, expires: string): void {
    sessions.insert({
      state,
      discordUserId: user,
      nonceHash: 'h'.repeat(64),
      createdAt: created,
      expiresAt: expires,
      result: undefined,
      isFollower: undefined,
    });
  }

  it('★ consume 은 원자적 1회다 — 두 번째 UPDATE 는 0행이다', () => {
    insert('s1', 'A', T0, T1);
    expect(sessions.consume('s1', 'consumed')).toBe(true);
    expect(sessions.consume('s1', 'consumed')).toBe(false);
  });

  it('미소모·미만료만 대기로 센다', () => {
    insert('s1', 'A', T0, T1);
    insert('s2', 'B', T0, T0); // 이미 만료
    insert('s3', 'C', T0, T1);
    sessions.consume('s3', 'consumed');
    expect(sessions.pendingCount(T0)).toBe(1);
  });

  it('오래된 대기부터 버린다', () => {
    insert('s1', 'A', '2026-09-07T00:00:00.000Z', T1);
    insert('s2', 'B', '2026-09-07T00:00:01.000Z', T1);
    insert('s3', 'C', '2026-09-07T00:00:02.000Z', T1);
    expect(sessions.dropOldestPending(T0, 2)).toBe(2);
    expect(sessions.get('s1')).toBeUndefined();
    expect(sessions.get('s2')).toBeUndefined();
    expect(sessions.get('s3')).toBeDefined();
  });

  it('★ is_follower 는 3상태다 — unknown 은 NULL 로 남는다', () => {
    insert('s1', 'A', T0, T1);
    sessions.finish('s1', 'unknown', undefined);
    const raw = db.prepare('SELECT is_follower FROM verification_sessions WHERE state = ?').get('s1') as {
      is_follower: number | null;
    };
    expect(raw.is_follower).toBeNull();
    expect(sessions.get('s1')?.isFollower).toBeUndefined();

    insert('s2', 'B', T0, T1);
    sessions.finish('s2', 'not-follower', false);
    expect(sessions.get('s2')?.isFollower).toBe(false);
  });

  it('만료된 행을 지운다', () => {
    insert('s1', 'A', T0, T0);
    insert('s2', 'B', T0, T1);
    expect(sessions.pruneExpired(T0)).toBe(1);
    expect(sessions.get('s1')).toBeUndefined();
    expect(sessions.get('s2')).toBeDefined();
  });
});
