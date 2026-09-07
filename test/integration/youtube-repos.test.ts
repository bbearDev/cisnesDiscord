import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { openDb, type Db } from '../../src/store/db.js';
import { migrate } from '../../src/store/migrate.js';
import {
  createYoutubeChannelRepo,
  type YoutubeChannelRepo,
} from '../../src/store/repos/youtube-channel-repo.js';
import {
  createWebSubSubRepo,
  MAX_RENEW_ERROR,
  type WebSubSubRepo,
} from '../../src/store/repos/websub-sub-repo.js';
import { createAnnouncementLedgerRepo } from '../../src/store/repos/announcement-ledger-repo.js';

/**
 * 계획 §8 — `youtube_channels` · `websub_subscriptions` (AC-20 · AC-26 · AC-P7).
 *
 * ★★ 이 파일이 지키는 불변식: **`seeded_at` 은 채널당 한 번만 선다.**
 *   두 번 서면 그 사이에 올라온 신규 업로드까지 `seeded=1` 로 덮어 영영
 *   공지되지 않는다 — 누락(§3-a 2위)이다.
 */

const CH = 'UCcisnesTest0000000001';
const NOW = '2026-09-07T00:00:00.000Z';

let db: Db;
let channels: YoutubeChannelRepo;
let subs: WebSubSubRepo;

beforeEach(() => {
  db = openDb({ path: ':memory:' });
  migrate(db);
  channels = createYoutubeChannelRepo(db);
  subs = createWebSubSubRepo(db);
});

afterEach(() => {
  db.close();
});

describe('youtube_channels', () => {
  it('upsert 는 라벨을 갱신한다', () => {
    channels.upsert(CH, '시스네');
    channels.upsert(CH, '시스네 (수정)');
    expect(channels.get(CH)).toMatchObject({ channelId: CH, label: '시스네 (수정)' });
    expect(channels.list()).toHaveLength(1);
  });

  it('★★ upsert 가 seeded_at 을 지우지 않는다 — 라벨만 바꾸고 재기동해도 시딩은 유지된다', () => {
    channels.upsert(CH, '시스네');
    expect(channels.markSeeded(CH, NOW)).toBe(true);
    channels.upsert(CH, '이름 변경');
    expect(channels.get(CH)?.seededAt).toBe(NOW);
  });

  it('★★ markSeeded 는 채널당 정확히 한 번만 true 다 (AC-26)', () => {
    channels.upsert(CH, '시스네');
    const results: boolean[] = [];
    for (let i = 0; i < 50; i++) {
      results.push(channels.markSeeded(CH, `2026-09-07T00:00:${String(i).padStart(2, '0')}.000Z`));
    }
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results[0]).toBe(true);
    // 첫 값이 남는다 — 뒤의 시도가 시각을 덮지 않는다.
    expect(channels.get(CH)?.seededAt).toBe('2026-09-07T00:00:00.000Z');
  });

  it('없는 채널에 markSeeded 하면 false 다', () => {
    expect(channels.markSeeded('UCnope', NOW)).toBe(false);
  });

  it('markPolled 는 마지막 폴 시각만 바꾼다', () => {
    channels.upsert(CH, '시스네');
    channels.markSeeded(CH, NOW);
    channels.markPolled(CH, '2026-09-07T00:01:00.000Z');
    expect(channels.get(CH)).toMatchObject({
      seededAt: NOW,
      lastRssPollAt: '2026-09-07T00:01:00.000Z',
    });
  });

  it('모르는 채널은 undefined 다', () => {
    expect(channels.get('UCnope')).toBeUndefined();
  });
});

describe('websub_subscriptions', () => {
  beforeEach(() => {
    channels.upsert(CH, '시스네');
  });

  it('★★ ensure 는 기존 시크릿을 바꾸지 않는다 — 매 기동마다 새로 만들면 모든 푸시가 서명 실패한다', () => {
    const first = subs.ensure(CH, 'secret-A');
    const second = subs.ensure(CH, 'secret-B');
    expect(first.secret).toBe('secret-A');
    expect(second.secret).toBe('secret-A');
  });

  it('★ 채널마다 다른 시크릿을 가진다 (AC-P5)', () => {
    channels.upsert('UCsecond000000000000002', '둘째');
    subs.ensure(CH, 'secret-A');
    subs.ensure('UCsecond000000000000002', 'secret-B');
    expect(subs.get(CH)?.secret).not.toBe(subs.get('UCsecond000000000000002')?.secret);
  });

  it('★ 채널 행이 없으면 FK 가 구독 생성을 막는다 (유령 채널 재구독 방지)', () => {
    expect(() => subs.ensure('UCghost00000000000000', 's')).toThrow();
  });

  it('★ 채널을 지우면 구독이 CASCADE 로 사라진다', () => {
    subs.ensure(CH, 's');
    db.prepare('DELETE FROM youtube_channels WHERE channel_id = ?').run(CH);
    expect(subs.get(CH)).toBeUndefined();
  });

  it('★★ recordLease 는 허브가 준 값을 그대로 저장한다', () => {
    subs.ensure(CH, 's');
    subs.recordLease(CH, 432_000, '2026-09-12T00:00:00.000Z');
    expect(subs.get(CH)).toMatchObject({
      leaseSeconds: 432_000,
      expiresAt: '2026-09-12T00:00:00.000Z',
    });
    // 허브가 다른 값을 줘도 그대로다 — 상수 5일을 박지 않는다.
    subs.recordLease(CH, 864_000, '2026-09-17T00:00:00.000Z');
    expect(subs.get(CH)?.leaseSeconds).toBe(864_000);
  });

  it('리스를 모르면 lease_seconds · expires_at 이 둘 다 비어 있다', () => {
    subs.ensure(CH, 's');
    subs.recordLease(CH, undefined, undefined);
    const row = subs.get(CH);
    expect(row?.leaseSeconds).toBeUndefined();
    expect(row?.expiresAt).toBeUndefined();
  });

  it('recordLease 는 마지막 갱신 오류를 지운다 (성공했으니까)', () => {
    subs.ensure(CH, 's');
    subs.setRenewError(CH, '허브 503', NOW);
    expect(subs.get(CH)?.lastRenewError).toContain('허브 503');
    subs.recordLease(CH, 60, '2026-09-07T00:01:00.000Z');
    expect(subs.get(CH)?.lastRenewError).toBeUndefined();
  });

  it('setRenewError 는 시각을 앞에 붙이고 길이를 자른다', () => {
    subs.ensure(CH, 's');
    subs.setRenewError(CH, 'x'.repeat(MAX_RENEW_ERROR * 2), NOW);
    const detail = subs.get(CH)?.lastRenewError ?? '';
    expect(detail.startsWith(NOW)).toBe(true);
    expect(detail.length).toBe(MAX_RENEW_ERROR);
  });

  it('markRequested 는 요청 시각만 남긴다 — 만료를 채우지 않는다', () => {
    subs.ensure(CH, 's');
    subs.markRequested(CH, NOW);
    expect(subs.get(CH)).toMatchObject({ subscribedAt: NOW });
    expect(subs.get(CH)?.expiresAt).toBeUndefined();
  });

  it('remove 는 구독만 지운다 — 채널은 남는다', () => {
    subs.ensure(CH, 's');
    subs.remove(CH);
    expect(subs.get(CH)).toBeUndefined();
    expect(channels.get(CH)).toBeDefined();
  });

  it('list 는 채널 id 순으로 준다', () => {
    channels.upsert('UCaaa0000000000000000a', 'a');
    channels.upsert('UCzzz0000000000000000z', 'z');
    subs.ensure('UCzzz0000000000000000z', 'z');
    subs.ensure('UCaaa0000000000000000a', 'a');
    expect(subs.list().map((s) => s.channelId)).toEqual([
      'UCaaa0000000000000000a',
      'UCzzz0000000000000000z',
    ]);
  });
});

describe('원장과의 접점 (AC-26)', () => {
  it('★ seeded=1 은 kind=youtube_upload 에서만 legal 하다 (스키마 CHECK)', () => {
    const ledger = createAnnouncementLedgerRepo(db);
    expect(ledger.claim('youtube_upload', 'V1', NOW, 'seed', { seeded: true })).toBe(true);
    expect(ledger.get('youtube_upload', 'V1')?.seeded).toBe(true);
    expect(() => ledger.claim('live_start', 'df09256e', NOW, 'seed', { seeded: true })).toThrow();
  });
});
