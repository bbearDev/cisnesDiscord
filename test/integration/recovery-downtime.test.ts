import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAnnouncementLedgerRepo } from '../../src/store/repos/announcement-ledger-repo.js';
import type { AnnouncementLedgerRepo } from '../../src/store/repos/announcement-ledger-repo.js';
import {
  isStaleUploadResend,
  DEFAULT_DOWNTIME_THRESHOLD_HOURS,
  formatDuration,
  measureDowntime,
  recoverLive,
  recoverYoutube,
} from '../../src/recovery/downtime.js';
import type { RecoverableVideo } from '../../src/recovery/downtime.js';
import type { LiveApiChannel } from '../../src/chzzk/live-api-schema.js';

/**
 * S7 복구 — 계획 §S7 수용 기준.
 *
 * ★ 이 계층에서 가장 중요한 것은 **"진행 중인 방송"과 "지나간 이벤트"를 다르게 다루는가** 다.
 *   AC-30 의 생략은 지나간 유튜브 업로드에만 적용되고, 진행 중인 방송은
 *   다운타임 길이와 무관하게 3상태 판정을 따른다 (§5.1 경계 2).
 */

const SIS = 'c3355ea2b3bea6c646789510796379d6';
const AT = '2026-09-06T19:00:00.000Z';
const HOUR = 60 * 60 * 1_000;

function freshLedger(): { repo: AnnouncementLedgerRepo; db: Database.Database } {
  const db = new Database(':memory:');
  db.exec(readFileSync('src/store/migrations/001_init.sql', 'utf8'));
  return { repo: createAnnouncementLedgerRepo(db), db };
}

function channel(over: Partial<LiveApiChannel> = {}): LiveApiChannel {
  return {
    channelId: SIS,
    channelName: '시스네',
    live: true,
    confirmed: true,
    exact: true,
    status: 'running',
    openDate: '2026-09-07 03:56:39',
    openedAt: '2026-09-06T18:56:39.000Z',
    liveHash: 'df09256e',
    ...over,
  };
}

describe('다운타임 측정 — 경계 6h ± 1s', () => {
  const now = Date.parse(AT);

  it('정확히 6시간은 초과가 아니다 (이하이면 전부 공지)', () => {
    const w = measureDowntime(now - 6 * HOUR, now);
    expect(w.exceeded).toBe(false);
  });

  it('6시간 + 1초는 초과다', () => {
    const w = measureDowntime(now - (6 * HOUR + 1_000), now);
    expect(w.exceeded).toBe(true);
  });

  it('6시간 - 1초는 초과가 아니다', () => {
    expect(measureDowntime(now - (6 * HOUR - 1_000), now).exceeded).toBe(false);
  });

  it('표식이 없으면 durationMs 를 0 으로 접지 않고 undefined 로 둔다', () => {
    // ★ 0 으로 접으면 "표식이 깨졌다"와 "방금 꺼졌다"가 구분되지 않는다.
    //   에포크(0)로 접으면 반대로 56년이 되어 AC-30 이 항상 발동한다.
    const w = measureDowntime(undefined, now);
    expect(w.durationMs).toBeUndefined();
    expect(w.firstBoot).toBe(true);
    expect(w.exceeded).toBe(true); // 보수적: 도배보다 생략 + 기록
  });

  it('시계가 뒤로 갔어도 음수가 되지 않는다', () => {
    const w = measureDowntime(now + HOUR, now);
    expect(w.durationMs).toBe(0);
    expect(w.exceeded).toBe(false);
  });

  it('기본 임계는 6시간이다', () => {
    expect(DEFAULT_DOWNTIME_THRESHOLD_HOURS).toBe(6);
  });

  it('기간 문구를 사람이 읽게 만든다', () => {
    expect(formatDuration(7 * HOUR)).toBe('7시간');
    expect(formatDuration(7 * HOUR + 30 * 60_000)).toBe('7시간 30분');
    expect(formatDuration(45 * 60_000)).toBe('45분');
  });
});

describe('라이브 복구 — 다운타임 길이를 보지 않는다 (§5.1 경계 2)', () => {
  let ledger: AnnouncementLedgerRepo;
  let announce: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ledger = freshLedger().repo;
    announce = vi.fn(() => Promise.resolve());
  });

  it('3시간 + live:true,confirmed:true + 미공지 → 공지 1건 (AC-29)', async () => {
    const r = await recoverLive({
      input: { kind: 'channel', channel: channel() },
      ledger,
      announce,
      at: AT,
    });
    expect(r.kind).toBe('announced');
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('★ 7시간(기준 초과) + live:true,confirmed:true + 미공지 → 그래도 공지 1건', async () => {
    // ★★ 이것이 §5.1 경계 2 다. 진행 중인 방송은 **현재 사실**이라 AC-30 의
    //    생략 대상이 아니다. 6시간 넘게 진행 중인 방송을 알리지 않는 것은
    //    AC-29 의 취지에 어긋나고, liveHash 원장이 중복을 막으므로 위험이 없다.
    const r = await recoverLive({
      input: { kind: 'channel', channel: channel() },
      ledger,
      announce,
      at: AT,
    });
    expect(r.kind).toBe('announced');
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('live:false + status:running → ended, 공지 0건 (AC-31)', async () => {
    const closeOpen = vi.fn();
    const r = await recoverLive({
      input: { kind: 'channel', channel: channel({ live: false, confirmed: false }) },
      ledger,
      announce,
      at: AT,
      closeOpenSessions: closeOpen,
    });
    expect(r.kind).toBe('ended');
    expect(announce).not.toHaveBeenCalled();
    expect(closeOpen).toHaveBeenCalledWith(AT);
  });

  it('live:true, confirmed:false → unknown, 공지 0건', async () => {
    const r = await recoverLive({
      input: { kind: 'channel', channel: channel({ confirmed: false, liveHash: undefined }) },
      ledger,
      announce,
      at: AT,
    });
    expect(r.kind).toBe('unknown');
    expect(announce).not.toHaveBeenCalled();
  });

  it('조회 API 5xx → unknown, 공지 0건 (기록은 호출부가 남긴다)', async () => {
    const r = await recoverLive({
      input: { kind: 'failure', failure: 'http', detail: '500' },
      ledger,
      announce,
      at: AT,
    });
    expect(r.kind).toBe('unknown');
    expect(announce).not.toHaveBeenCalled();
  });

  it('이미 공지한 방송은 원장이 막는다 — 재기동해도 중복 0', async () => {
    await recoverLive({ input: { kind: 'channel', channel: channel() }, ledger, announce, at: AT });
    announce.mockClear();
    const again = await recoverLive({
      input: { kind: 'channel', channel: channel() },
      ledger,
      announce,
      at: AT,
    });
    expect(again.kind).toBe('already-announced');
    expect(announce).not.toHaveBeenCalled();
  });

  it('공지 경로가 detected_via=recovery 로 남는다', async () => {
    const { repo, db } = freshLedger();
    await recoverLive({
      input: { kind: 'channel', channel: channel() },
      ledger: repo,
      announce,
      at: AT,
    });
    const row = db
      .prepare("SELECT detected_via FROM announcement_ledger WHERE kind='live_start'")
      .get() as { detected_via: string };
    expect(row.detected_via).toBe('recovery');
  });
});

describe('★★ B-1 — 라이브 경로에 seeded 선점을 하지 않는다', () => {
  it('7시간 복구를 돌려도 live_start 행에 seeded=1 이 없다', async () => {
    const { repo, db } = freshLedger();
    const window = measureDowntime(Date.parse(AT) - 7 * HOUR, Date.parse(AT));
    expect(window.exceeded).toBe(true);

    // 유튜브 쪽은 생략 + seeded 선점을 한다
    await recoverYoutube({
      window,
      videos: [{ videoId: 'SEEDVIDEO01', channelId: 'UC1', publishedAt: '2026-09-01T00:00:00Z' }],
      ledger: repo,
      announce: () => Promise.resolve(),
      at: AT,
    });
    // 라이브 쪽은 그와 무관하게 announce 한다
    await recoverLive({
      input: { kind: 'channel', channel: channel() },
      ledger: repo,
      announce: () => Promise.resolve(),
      at: AT,
    });

    const bad = db
      .prepare("SELECT COUNT(*) AS n FROM announcement_ledger WHERE kind='live_start' AND seeded=1")
      .get() as { n: number };
    expect(bad.n).toBe(0);
  });

  it('스키마 CHECK 가 live_start + seeded=1 INSERT 자체를 거부한다', () => {
    const { db } = freshLedger();
    expect(() =>
      db
        .prepare(
          `INSERT INTO announcement_ledger(kind, event_key, detected_via, claimed_at, seeded)
           VALUES('live_start','df09256e','recovery',?,1)`,
        )
        .run(AT),
    ).toThrow();
  });

  it('seeded 를 세우지 않았으므로 이어지는 claim 이 성공한다 — 수용 기준이 통과 가능하다', () => {
    // ★ 이것이 B-1 이 막으려던 실패다. seeded 를 세웠다면 이 claim 이 반드시 실패해
    //   "7시간 + announce → 1건" 이 **구조적으로 통과 불가**가 된다.
    const { repo } = freshLedger();
    expect(repo.claim('live_start', 'df09256e', AT, 'recovery')).toBe(true);
  });
});

describe('유튜브 복구 — 지나간 이벤트라 생략 대상이다', () => {
  const videos: RecoverableVideo[] = [
    { videoId: 'V3', channelId: 'UC1', publishedAt: '2026-09-06T12:00:00Z' },
    { videoId: 'V1', channelId: 'UC1', publishedAt: '2026-09-06T10:00:00Z' },
    { videoId: 'V2', channelId: 'UC1', publishedAt: '2026-09-06T11:00:00Z' },
  ];

  it('5시간 다운 + 밀린 3건 → publishedAt 오름차순으로 전부 공지 (AC-29)', async () => {
    const { repo } = freshLedger();
    const order: string[] = [];
    const r = await recoverYoutube({
      window: measureDowntime(Date.parse(AT) - 5 * HOUR, Date.parse(AT)),
      videos,
      ledger: repo,
      announce: (v) => {
        order.push(v.videoId);
        return Promise.resolve();
      },
      at: AT,
    });
    expect(r.kind).toBe('backfilled');
    // ★ 피드는 최신순으로 오므로 그대로 보내면 시간이 거꾸로 흐른다
    expect(order).toEqual(['V1', 'V2', 'V3']);
  });

  it('7시간 다운 → 공지 0건 + 기간이 적힌 기록 1건 + 현재 피드 seeded 선점 (AC-30)', async () => {
    const { repo, db } = freshLedger();
    const announce = vi.fn(() => Promise.resolve());
    const recordSkip = vi.fn();
    const r = await recoverYoutube({
      window: measureDowntime(Date.parse(AT) - 7 * HOUR, Date.parse(AT)),
      videos,
      ledger: repo,
      announce,
      at: AT,
      recordSkip,
    });

    expect(r.kind).toBe('skipped');
    expect(announce).not.toHaveBeenCalled();
    expect(recordSkip).toHaveBeenCalledTimes(1);
    expect(recordSkip.mock.calls[0]?.[0]).toContain('7시간');
    expect(recordSkip.mock.calls[0]?.[0]).toContain('3건 생략');

    const seeded = db
      .prepare(
        "SELECT COUNT(*) AS n FROM announcement_ledger WHERE kind='youtube_upload' AND seeded=1",
      )
      .get() as { n: number };
    expect(seeded.n).toBe(3);
  });

  it('생략한 영상은 이후에도 공지되지 않는다 — 선점이 그 자리를 막는다', async () => {
    const { repo } = freshLedger();
    await recoverYoutube({
      window: measureDowntime(Date.parse(AT) - 7 * HOUR, Date.parse(AT)),
      videos,
      ledger: repo,
      announce: () => Promise.resolve(),
      at: AT,
    });
    // 나중에 RSS 폴러가 같은 영상을 발견해도 선점에 실패한다
    expect(repo.claim('youtube_upload', 'V1', AT, 'rss')).toBe(false);
  });

  it('이미 공지한 영상은 백필에서 건너뛴다 (AC-24)', async () => {
    const { repo } = freshLedger();
    repo.claim('youtube_upload', 'V2', AT, 'websub');
    const announced: string[] = [];
    const r = await recoverYoutube({
      window: measureDowntime(Date.parse(AT) - 5 * HOUR, Date.parse(AT)),
      videos,
      ledger: repo,
      announce: (v) => {
        announced.push(v.videoId);
        return Promise.resolve();
      },
      at: AT,
    });
    expect(announced).toEqual(['V1', 'V3']);
    expect(r.kind === 'backfilled' && r.skipped).toEqual(['V2']);
  });

  it('★ 피드 상한에 닿으면 그 너머를 못 봤다고 기록한다 — 누락이 스스로를 숨기지 않게', async () => {
    const { repo } = freshLedger();
    const many = Array.from({ length: 15 }, (_, i) => ({
      videoId: `V${String(i)}`,
      channelId: 'UC1',
      publishedAt: `2026-09-06T${String(i).padStart(2, '0')}:00:00Z`,
    }));
    const recordSkip = vi.fn();
    await recoverYoutube({
      window: measureDowntime(Date.parse(AT) - 5 * HOUR, Date.parse(AT)),
      videos: many,
      ledger: repo,
      announce: () => Promise.resolve(),
      at: AT,
      recordSkip,
    });
    expect(recordSkip).toHaveBeenCalledTimes(1);
    expect(recordSkip.mock.calls[0]?.[0]).toContain('상한');
  });

  it('표식이 없는 첫 기동은 생략 쪽으로 간다 — 과거 영상을 도배하지 않는다', async () => {
    const { repo } = freshLedger();
    const announce = vi.fn(() => Promise.resolve());
    const r = await recoverYoutube({
      window: measureDowntime(undefined, Date.parse(AT)),
      videos,
      ledger: repo,
      announce,
      at: AT,
    });
    expect(r.kind).toBe('skipped');
    expect(announce).not.toHaveBeenCalled();
    expect(r.kind === 'skipped' && r.durationText).toContain('불명');
  });
});

describe('★★ 너무 늦은 업로드 재발송은 보내지 않는다 (AC-30 과 같은 임계)', () => {
  const NOW = Date.parse('2026-09-10T12:00:00.000Z');
  const H = 60 * 60 * 1_000;

  it('기준(6시간)을 넘기면 보내지 않는다', () => {
    expect(isStaleUploadResend(NOW - 7 * H, NOW)).toBe(true);
    expect(isStaleUploadResend(Date.parse('2026-09-08T11:11:01.023Z'), NOW)).toBe(true);
  });

  it('★ 경계는 measureDowntime 과 같다 — 정확히 6시간이면 보내는 쪽이다', () => {
    expect(isStaleUploadResend(NOW - 6 * H, NOW)).toBe(false);
    expect(isStaleUploadResend(NOW - 6 * H - 1, NOW)).toBe(true);
  });

  it('갓 감지한 건은 당연히 보낸다', () => {
    expect(isStaleUploadResend(NOW - 60_000, NOW)).toBe(false);
  });

  it('★★ 시각을 못 읽으면 보낸다 — 파싱 실패가 누락 사유가 되면 안 된다', () => {
    expect(isStaleUploadResend(undefined, NOW)).toBe(false);
    expect(isStaleUploadResend(Number.NaN, NOW)).toBe(false);
  });

  it('★ 시계가 뒤로 가도 억제하지 않는다', () => {
    expect(isStaleUploadResend(NOW + 10 * H, NOW)).toBe(false);
  });

  it('임계값은 설정에서 온다 — 6시간이 박혀 있지 않다', () => {
    expect(isStaleUploadResend(NOW - 2 * H, NOW, 1)).toBe(true);
    expect(isStaleUploadResend(NOW - 2 * H, NOW, 24)).toBe(false);
  });
});
