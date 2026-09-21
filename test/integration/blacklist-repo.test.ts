import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { openDb, type Db } from '../../src/store/db.js';
import { migrate } from '../../src/store/migrate.js';
import {
  createBlacklistRepo,
  OPS_EVENT_BLACKLIST_ADDED,
  OPS_EVENT_BLACKLIST_REMOVED,
  type BlacklistRepo,
} from '../../src/store/repos/blacklist-repo.js';
import { createLinkRepo, type LinkRepo } from '../../src/store/repos/link-repo.js';

/**
 * `blacklist` 저장소 (002).
 *
 * ★ 이 파일이 지키는 문장:
 *   ① `add` 는 던지지 않는다 — 이미 있으면 판정으로 돌려주고 **기존 행 무변화**
 *   ①-b `add` 는 연동 행을 **같은 트랜잭션에서** 읽고·복사하고·지운다
 *   ② `findBlocking` 은 디스코드 계정 **또는** 치지직 채널로 걸린다 — 우회의 두 키
 *   ③ 치지직 채널이 NULL 인 행은 채널 조회에 걸리지 않는다 — 모르는 값을 지어내지 않는다
 *   ④ `remove` 는 행을 지우고 이력은 `ops_events` 에 남는다
 *   ⑤ 길드가 다르면 서로 보이지 않는다
 */

const GUILD = '1111111111';
const OTHER_GUILD = '2222222222';
const CHANNEL = 'c3355ea2b3bea6c646789510796379d6';
const T0 = '2026-09-22T00:00:00.000Z';
const T1 = '2026-09-22T00:05:00.000Z';

/** A 를 CHANNEL 에 연동해 둔다 */
function linkA(): void {
  links.link({ discordUserId: 'A', guildId: GUILD, chzzkChannelId: CHANNEL, chzzkChannelName: '시청자A', at: T0 });
}

let db: Db;
let repo: BlacklistRepo;
let links: LinkRepo;

beforeEach(() => {
  db = openDb({ path: ':memory:' });
  migrate(db);
  repo = createBlacklistRepo(db);
  links = createLinkRepo(db);
});

afterEach(() => {
  db.close();
});

describe('add', () => {
  it('★ ①-b 연동돼 있던 사람 — 치지직 채널을 복사하고 연동 행을 지운다. ops_events 1건', () => {
    linkA();
    const r = repo.add({ guildId: GUILD, discordUserId: 'A', reason: '도배', addedBy: 'admin', addedAt: T0 });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.unlinked).toMatchObject({ discordUserId: 'A', chzzkChannelId: CHANNEL, chzzkChannelName: '시청자A' });
    expect(links.get(GUILD, 'A')).toBeUndefined();
    expect(repo.get(GUILD, 'A')).toEqual({
      guildId: GUILD,
      discordUserId: 'A',
      chzzkChannelId: CHANNEL,
      chzzkChannelName: '시청자A',
      reason: '도배',
      addedBy: 'admin',
      addedAt: T0,
    });
    const events = links.opsEvents(OPS_EVENT_BLACKLIST_ADDED);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]?.detail ?? '{}')).toMatchObject({ discordUserId: 'A', by: 'admin', reason: '도배' });
  });

  it('★ 이미 있으면 already-blacklisted — 기존 행 무변화, ops_events 추가 없음', () => {
    repo.add({ guildId: GUILD, discordUserId: 'A', reason: '첫 사유', addedBy: 'admin', addedAt: T0 });
    const again = repo.add({ guildId: GUILD, discordUserId: 'A', reason: '둘째 사유', addedBy: 'admin2', addedAt: T1 });

    expect(again).toMatchObject({ ok: false, reason: 'already-blacklisted' });
    expect(repo.get(GUILD, 'A')).toMatchObject({ reason: '첫 사유', addedBy: 'admin', addedAt: T0 });
    expect(links.opsEvents(OPS_EVENT_BLACKLIST_ADDED)).toHaveLength(1);
  });

  it('연동이 없던 사람 — 치지직 채널 NULL, unlinked 없음', () => {
    const r = repo.add({ guildId: GUILD, discordUserId: 'A', addedBy: 'admin', addedAt: T0 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.unlinked).toBeUndefined();
    expect(repo.get(GUILD, 'A')).toMatchObject({ chzzkChannelId: undefined, chzzkChannelName: undefined, reason: undefined });
  });

  it('★ 이미 차단된 사람을 다시 추가해도 연동 행은 건드리지 않는다', () => {
    repo.add({ guildId: GUILD, discordUserId: 'A', addedBy: 'admin', addedAt: T0 });
    // (실제로는 차단 중 연동이 생길 수 없지만, "거부는 아무것도 바꾸지 않는다" 를 저장소 수준에서 고정한다)
    linkA();
    const again = repo.add({ guildId: GUILD, discordUserId: 'A', addedBy: 'admin', addedAt: T1 });
    expect(again.ok).toBe(false);
    expect(links.get(GUILD, 'A')).toBeDefined();
  });

  it('★ 해제 뒤 본인이 같은 채널로 다시 연동할 수 있다 — UNIQUE 를 점유하지 않는다', () => {
    linkA();
    repo.add({ guildId: GUILD, discordUserId: 'A', addedBy: 'admin', addedAt: T0 });
    repo.remove(GUILD, 'A', 'admin', T1);
    const relink = links.link({ discordUserId: 'A', guildId: GUILD, chzzkChannelId: CHANNEL, chzzkChannelName: '시청자A', at: T1 });
    expect(relink).toMatchObject({ ok: true, created: true });
  });
});

describe('★★ findBlocking — 두 키', () => {
  beforeEach(() => {
    linkA();
    repo.add({ guildId: GUILD, discordUserId: 'A', addedBy: 'admin', addedAt: T0 });
  });

  it('디스코드 계정으로 걸린다 (치지직 채널을 몰라도)', () => {
    expect(repo.findBlocking(GUILD, 'A')?.discordUserId).toBe('A');
  });

  it('★ 다른 디스코드 계정이라도 같은 치지직 채널이면 걸린다 — 우회 차단', () => {
    const hit = repo.findBlocking(GUILD, 'B', CHANNEL);
    expect(hit?.discordUserId).toBe('A');
    expect(hit?.chzzkChannelId).toBe(CHANNEL);
  });

  it('둘 다 아니면 걸리지 않는다', () => {
    expect(repo.findBlocking(GUILD, 'B', 'other-channel')).toBeUndefined();
    expect(repo.findBlocking(GUILD, 'B')).toBeUndefined();
  });

  it('★ 치지직 채널이 NULL 인 차단 행은 채널 조회에 걸리지 않는다', () => {
    repo.add({ guildId: GUILD, discordUserId: 'C', addedBy: 'admin', addedAt: T0 });
    // SQL 에서 NULL = NULL 은 참이 아니다 — 그래도 명시적으로 확인한다.
    expect(repo.findBlocking(GUILD, 'D', 'zzzz')).toBeUndefined();
    expect(repo.findBlocking(GUILD, 'C')?.discordUserId).toBe('C');
  });

  it('⑤ 길드가 다르면 보이지 않는다', () => {
    expect(repo.findBlocking(OTHER_GUILD, 'A', CHANNEL)).toBeUndefined();
    expect(repo.list(OTHER_GUILD)).toEqual([]);
    expect(repo.count(OTHER_GUILD)).toBe(0);
  });
});

describe('remove', () => {
  it('행을 지우고 ops_events 에 남긴다. 지운 행을 돌려준다', () => {
    linkA();
    repo.add({ guildId: GUILD, discordUserId: 'A', addedBy: 'admin', addedAt: T0 });
    const removed = repo.remove(GUILD, 'A', 'admin2', T1);

    expect(removed?.discordUserId).toBe('A');
    expect(repo.get(GUILD, 'A')).toBeUndefined();
    expect(repo.findBlocking(GUILD, 'B', CHANNEL)).toBeUndefined();
    const events = links.opsEvents(OPS_EVENT_BLACKLIST_REMOVED);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]?.detail ?? '{}')).toMatchObject({ discordUserId: 'A', chzzkChannelId: CHANNEL, by: 'admin2' });
  });

  it('없으면 undefined 이고 ops_events 도 없다', () => {
    expect(repo.remove(GUILD, 'nobody', 'admin', T0)).toBeUndefined();
    expect(links.opsEvents(OPS_EVENT_BLACKLIST_REMOVED)).toHaveLength(0);
  });

  it('해제 뒤 다시 추가할 수 있다 — soft-delete 가 아니다', () => {
    repo.add({ guildId: GUILD, discordUserId: 'A', addedBy: 'admin', addedAt: T0 });
    repo.remove(GUILD, 'A', 'admin', T1);
    expect(repo.add({ guildId: GUILD, discordUserId: 'A', addedBy: 'admin', addedAt: T1 }).ok).toBe(true);
  });
});

describe('list', () => {
  it('최근 차단이 앞이다', () => {
    repo.add({ guildId: GUILD, discordUserId: 'A', addedBy: 'admin', addedAt: T0 });
    repo.add({ guildId: GUILD, discordUserId: 'B', addedBy: 'admin', addedAt: T1 });
    expect(repo.list(GUILD).map((e) => e.discordUserId)).toEqual(['B', 'A']);
    expect(repo.count(GUILD)).toBe(2);
  });
});
