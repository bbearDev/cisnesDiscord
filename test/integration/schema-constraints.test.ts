import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { openDb, type Db } from '../../src/store/db.js';
import { migrate } from '../../src/store/migrate.js';
import { ALERT_KINDS } from '../../src/runtime/alerts/types.js';

/**
 * 001_init 의 제약이 **실제로 강제되는지** 실 SQLite 에서 확인한다 (계획 §8 · §9.2).
 *
 * 계획 Principle 1: *"중복 0 / 누락 0 은 조건문이 아니라 DB UNIQUE 제약이 지킨다."*
 * 그 문장이 참인지 여기서 판정한다.
 */

let db: Db;

beforeEach(() => {
  db = openDb({ path: ':memory:' });
  migrate(db);
});

afterEach(() => {
  db.close();
});

const NOW = '2026-09-07T00:00:00.000Z';

describe('announcement_ledger — 중복 방지의 단일 진실원', () => {
  function claim(kind: string, eventKey: string, via = 'webhook'): number {
    return db
      .prepare(
        `INSERT INTO announcement_ledger (kind, event_key, detected_via, claimed_at)
         VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(kind, eventKey, via, NOW).changes;
  }

  it('★ 같은 (kind, event_key) 는 한 번만 선점된다 — changes === 1 인 쪽만 발송한다', () => {
    expect(claim('live_start', 'hash-abc')).toBe(1);
    // 웹훅과 폴링이 같은 방송을 동시에 들고 와도 두 번째는 0 이다.
    expect(claim('live_start', 'hash-abc', 'api-poll')).toBe(0);
  });

  it('kind 가 다르면 같은 키라도 별개다', () => {
    expect(claim('live_start', 'same-key')).toBe(1);
    expect(claim('youtube_upload', 'same-key', 'websub')).toBe(1);
  });

  it('★★ kind=live_start 인데 seeded=1 이면 CHECK 가 거부한다 (계획 rev.4 B-1)', () => {
    // 라이브 경로에 seeded 행을 미리 세우면 이후 announce 의 claim 이 반드시 실패해
    // **방송 공지가 영영 나가지 않는다.** 주석이 아니라 제약이 막는다.
    expect(() =>
      db
        .prepare(
          `INSERT INTO announcement_ledger (kind, event_key, detected_via, claimed_at, seeded)
           VALUES ('live_start', 'hash-xyz', 'webhook', ?, 1)`,
        )
        .run(NOW),
    ).toThrow(/CHECK constraint/i);
  });

  it('kind=youtube_upload 에서는 seeded=1 이 허용된다 (AC-26 최초 기동 시딩)', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO announcement_ledger (kind, event_key, detected_via, claimed_at, seeded)
           VALUES ('youtube_upload', 'video-1', 'seed', ?, 1)`,
        )
        .run(NOW),
    ).not.toThrow();
  });

  it('알 수 없는 kind · detected_via 는 거부한다', () => {
    expect(() => claim('twitch_start', 'k')).toThrow(/CHECK constraint/i);
    expect(() => claim('live_start', 'k2', 'telepathy')).toThrow(/CHECK constraint/i);
  });

  it('미발송 행만 부분 인덱스에 남는다 (아웃박스 회수 대상)', () => {
    claim('live_start', 'pending-1');
    claim('youtube_upload', 'sent-1', 'websub');
    db.prepare(
      `UPDATE announcement_ledger SET announced_at = ?, message_id = 'm1'
       WHERE kind='youtube_upload' AND event_key='sent-1'`,
    ).run(NOW);

    const pending = db
      .prepare('SELECT event_key FROM announcement_ledger WHERE announced_at IS NULL')
      .all() as { event_key: string }[];
    expect(pending.map((r) => r.event_key)).toEqual(['pending-1']);
  });
});

describe('account_links — AC-7', () => {
  function link(userId: string, guildId: string, chzzkId: string): void {
    db.prepare(
      `INSERT INTO account_links
         (discord_user_id, guild_id, chzzk_channel_id, chzzk_channel_name, linked_at)
       VALUES (?, ?, ?, '시스네', ?)`,
    ).run(userId, guildId, chzzkId, NOW);
  }

  it('★ 한 길드에서 같은 치지직 채널을 두 디스코드 계정이 연동할 수 없다', () => {
    link('discord-1', 'guild-1', 'chzzk-A');
    expect(() => {
      link('discord-2', 'guild-1', 'chzzk-A');
    }).toThrow(/UNIQUE constraint/i);
  });

  it('길드가 다르면 같은 치지직 채널을 연동할 수 있다', () => {
    link('discord-1', 'guild-1', 'chzzk-A');
    expect(() => {
      link('discord-1', 'guild-2', 'chzzk-A');
    }).not.toThrow();
  });

  it('같은 사람이 같은 길드에서 두 번 연동할 수 없다 (PK)', () => {
    link('discord-1', 'guild-1', 'chzzk-A');
    expect(() => {
      link('discord-1', 'guild-1', 'chzzk-B');
    }).toThrow(/UNIQUE constraint/i);
  });
});

describe('alert_state — ★ CHECK 목록과 ALERT_KINDS 대조', () => {
  /**
   * chzzkbot 이 실제로 겪은 사고: CHECK 목록에 없는 종류로 INSERT 하면
   * **경보를 보내려던 그 순간** CHECK 위반이 나고, 아무도 모르게 경보가 사라진다.
   *
   * (US-008 이 두 목록의 집합 동일성까지 정면으로 대조한다. 여기서는
   *  양방향 배선 — 상수의 모든 값이 통과하고 그 밖은 거부되는 것 — 을 고정한다.)
   */
  it('ALERT_KINDS 의 모든 종류가 INSERT 된다', () => {
    for (const kind of ALERT_KINDS) {
      expect(() =>
        db
          .prepare(
            'INSERT INTO alert_state (scope, alert_kind, last_sent_at) VALUES (?, ?, ?)',
          )
          .run('__system__', kind, NOW),
      ).not.toThrow();
    }
    const n = db.prepare('SELECT COUNT(*) AS c FROM alert_state').get() as { c: number };
    expect(n.c).toBe(ALERT_KINDS.length);
  });

  it('목록에 없는 종류는 거부한다', () => {
    expect(() =>
      db
        .prepare('INSERT INTO alert_state (scope, alert_kind) VALUES (?, ?)')
        .run('__system__', 'needs_reauth'),
    ).toThrow(/CHECK constraint/i);
  });

  it('★ (scope, alert_kind) 가 PK — 다른 scope 는 별개 행이다', () => {
    const ins = db.prepare('INSERT INTO alert_state (scope, alert_kind) VALUES (?, ?)');
    ins.run('UCchannelA', 'rss_fail');
    expect(() => {
      ins.run('UCchannelB', 'rss_fail');
    }).not.toThrow();
    expect(() => {
      ins.run('UCchannelA', 'rss_fail');
    }).toThrow(/UNIQUE constraint|PRIMARY KEY/i);
  });
});

describe('websub_subscriptions — FK 가 실제로 강제된다', () => {
  it('★ 없는 채널의 구독은 거부한다 (foreign_keys=ON 배선 확인)', () => {
    expect(() =>
      db
        .prepare('INSERT INTO websub_subscriptions (channel_id, secret) VALUES (?, ?)')
        .run('UCghost', 's'),
    ).toThrow(/FOREIGN KEY constraint/i);
  });

  it('채널을 지우면 구독도 함께 사라진다 (CASCADE)', () => {
    db.prepare('INSERT INTO youtube_channels (channel_id, label) VALUES (?, ?)').run(
      'UCreal',
      '시스네',
    );
    db.prepare('INSERT INTO websub_subscriptions (channel_id, secret) VALUES (?, ?)').run(
      'UCreal',
      's',
    );
    db.prepare('DELETE FROM youtube_channels WHERE channel_id = ?').run('UCreal');
    const left = db.prepare('SELECT COUNT(*) AS c FROM websub_subscriptions').get() as {
      c: number;
    };
    expect(left.c).toBe(0);
  });
});

describe('verification_sessions · live_sessions', () => {
  it('★ is_follower 는 3상태다 — NULL 이 unknown 이다', () => {
    const ins = db.prepare(
      `INSERT INTO verification_sessions
         (state, discord_user_id, nonce_hash, created_at, expires_at, is_follower)
       VALUES (?, 'u1', 'h', ?, ?, ?)`,
    );
    expect(() => {
      ins.run('s-null', NOW, NOW, null);
    }).not.toThrow();
    expect(() => {
      ins.run('s-yes', NOW, NOW, 1);
    }).not.toThrow();
    expect(() => {
      ins.run('s-no', NOW, NOW, 0);
    }).not.toThrow();
    // 2 는 "약간 팔로워" 가 아니다.
    expect(() => {
      ins.run('s-bad', NOW, NOW, 2);
    }).toThrow(/CHECK constraint/i);
  });

  it('★ live_sessions 는 open_date(원문)와 opened_at(UTC)를 둘 다 요구한다', () => {
    const ins = db.prepare(
      `INSERT INTO live_sessions (live_hash, open_date, opened_at, status, first_seen_at)
       VALUES (?, ?, ?, 'OPEN', ?)`,
    );
    expect(() => {
      ins.run('h1', '2026-09-07 09:00:00', '2026-09-07T00:00:00.000Z', NOW);
    }).not.toThrow();
    // 하나만 저장하면 신원(비교·키)이나 시각 계산 중 하나를 잃는다.
    expect(() =>
      db
        .prepare(
          `INSERT INTO live_sessions (live_hash, open_date, status, first_seen_at)
           VALUES ('h2', '2026-09-07 09:00:00', 'OPEN', ?)`,
        )
        .run(NOW),
    ).toThrow(/NOT NULL constraint/i);
  });
});

describe('★ 팔로워 테이블은 만들지 않는다 (계획 §8 · Pre-mortem 3)', () => {
  it('followers 라는 이름의 테이블이 없다', () => {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%follower%'")
      .all();
    expect(rows).toEqual([]);
  });
});
