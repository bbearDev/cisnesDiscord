import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, type Db } from '../../src/store/db.js';
import { migrate } from '../../src/store/migrate.js';
import {
  createAnnouncementLedgerRepo,
  type AnnouncementKind,
  type AnnouncementLedgerRepo,
} from '../../src/store/repos/announcement-ledger-repo.js';
import { createAnnouncer, buildAnnouncementEmbed } from '../../src/discord/announcer.js';
import { createOutbox, type OutboxRow } from '../../src/runtime/outbox.js';
import {
  createOpsAlertService,
  createMemoryAlertState,
} from '../../src/runtime/alerts/ops-alert-service.js';
import { SYSTEM_SCOPE } from '../../src/runtime/alerts/types.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { createFakeDiscord, type FakeDiscord } from './harness/fake-discord.js';

/**
 * 원장 → 발송기 → 아웃박스를 **실 SQLite + 가짜 디스코드**로 이어 붙인다 (계획 §9.3).
 *
 * 판정하는 것:
 *   · 재시작 뒤 미발송 행을 아웃박스가 회수한다
 *   · 회수된 건이 성공하면 원장이 닫히고 다시 나가지 않는다 (AC-17/18)
 *   · 디스코드가 전량 실패해도 **호출자에게 예외가 0건**이고 행이 남는다 (AC-19)
 */

const CHANNEL = '111222333';
const START = Date.parse('2026-09-07T00:00:00.000Z');

let dir: string;
let dbPath: string;
let db: Db;
let repo: AnnouncementLedgerRepo;
let clock: ManualClock;
let gateway: FakeDiscord;
let alertMessages: string[];

/** 원장 + 발송기 + 아웃박스 한 벌. 재기동은 이 함수를 다시 부르는 것이다 */
function boot() {
  db = openDb({ path: dbPath });
  migrate(db);
  repo = createAnnouncementLedgerRepo(db);

  const alerts = createOpsAlertService({
    notifier: {
      send: (m) => {
        alertMessages.push(m);
        return Promise.resolve('sent');
      },
    },
    state: createMemoryAlertState(),
    clock,
    scope: SYSTEM_SCOPE,
    minIntervalMin: 0,
  });

  const announcer = createAnnouncer({
    gateway,
    alerts,
    clock,
    sleep: () => Promise.resolve(),
  });

  /**
   * ★ 아웃박스와 원장을 잇는 배선. 이 자리가 composition-root 의 몫이다 —
   *   `runtime/outbox.ts` 는 L1 이라 store(L2)·discord(L7)를 import 할 수 없다.
   */
  const send = async (row: OutboxRow): Promise<void> => {
    const result = await announcer.announce({
      channelId: CHANNEL,
      label: `${row.kind} ${row.eventKey}`,
      payload: {
        embeds: [buildAnnouncementEmbed({ title: '방송 시작', detectedVia: row.detectedVia })],
      },
    });
    const at = clock.date().toISOString();
    const kind = row.kind as AnnouncementKind;
    if (result.ok) {
      repo.markSent(kind, row.eventKey, result.messageId, at);
    } else {
      // ★ 행을 지우지 않는다 — 지우면 폴백이 재선점해 중복이 난다.
      repo.markFailed(kind, row.eventKey, result.reason, at);
    }
  };

  const outbox = createOutbox({ ledger: repo, send, clock, intervalMs: 60_000 });
  return { outbox, announcer };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cisnes-outbox-'));
  dbPath = join(dir, 'cisnes.db');
  clock = new ManualClock(START);
  gateway = createFakeDiscord({ now: () => clock.now() });
  alertMessages = [];
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('아웃박스 회수 — 재시작 관통', () => {
  it('★ 꺼져 있던 동안 남은 미발송 행을 기동 즉시 회수한다', async () => {
    // ① 첫 프로세스: 선점만 하고 발송 전에 죽었다.
    const first = boot();
    expect(repo.claim('live_start', 'df09256e', clock.date().toISOString(), 'webhook')).toBe(true);
    first.outbox.dispose();
    db.close();

    // ② 재기동.
    const second = boot();
    expect(repo.pendingRetries()).toHaveLength(1);

    await second.outbox.runOnce();

    expect(gateway.sent).toHaveLength(1);
    expect(gateway.sent[0]?.channelId).toBe(CHANNEL);
    expect(repo.get('live_start', 'df09256e')?.messageId).toBe('fake-msg-1');
    // 발송이 끝난 행은 대기열에서 빠진다.
    expect(repo.pendingRetries()).toHaveLength(0);
    second.outbox.dispose();
  });

  it('★★ 회수 뒤에 아웃박스를 몇 번을 더 돌려도 같은 건이 다시 나가지 않는다 (AC-17)', async () => {
    const { outbox } = boot();
    repo.claim('live_start', 'df09256e', clock.date().toISOString(), 'webhook');

    await outbox.runOnce();
    await outbox.runOnce();
    await outbox.runOnce();

    expect(gateway.sent).toHaveLength(1);
    outbox.dispose();
  });

  it('★ 겹친 두 틱이 같은 행을 두 번 보내지 않는다 (FM5 — 실제 배선으로)', async () => {
    const { outbox } = boot();
    repo.claim('live_start', 'df09256e', clock.date().toISOString(), 'webhook');
    // 발송이 오래 걸리는 동안 다음 틱이 온다.
    gateway.setDelayMs(20);

    const [a, b] = await Promise.all([outbox.runOnce(), outbox.runOnce()]);

    expect([a.outcome, b.outcome].sort()).toEqual(['ran', 'skipped']);
    expect(gateway.sent).toHaveLength(1);
    outbox.dispose();
  });
});

describe('아웃박스 회수 — 디스코드 장애', () => {
  it('★ 발송이 전량 실패해도 예외가 새지 않고 행이 남는다 (AC-19)', async () => {
    const { outbox } = boot();
    gateway.failAlways({ kind: 'server', status: 503 });
    repo.claim('live_start', 'df09256e', clock.date().toISOString(), 'webhook');

    // ★ 이 호출이 reject 하면 봇 본체가 죽는다 (Principle 2).
    const tick = await outbox.runOnce();
    expect(tick).toEqual({ outcome: 'ran', processed: 1, errors: 0 });

    const row = repo.get('live_start', 'df09256e');
    expect(row?.announcedAt).toBeUndefined();
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toContain('server');
    // 운영 채널 기록은 한 바퀴에 1건이다 (재시도 3회를 소진한 뒤 한 번).
    expect(alertMessages).toHaveLength(1);

    // ★ 디스코드가 회복하면 다음 바퀴에 나간다 — "늦게 보내기"(§3-a 1위).
    gateway.failAlways(undefined);
    await outbox.runOnce();
    expect(gateway.sent).toHaveLength(1);
    expect(repo.pendingRetries()).toHaveLength(0);
    outbox.dispose();
  });

  it('여러 건이 대기해도 순차로 나가고 순서가 유지된다', async () => {
    const { outbox } = boot();
    repo.claim('live_start', 'first', '2026-09-07T00:00:00.000Z', 'webhook');
    repo.claim('youtube_upload', 'second', '2026-09-07T00:01:00.000Z', 'websub');

    await outbox.runOnce();

    expect(gateway.sent.map((s) => s.messageId)).toEqual(['fake-msg-1', 'fake-msg-2']);
    expect(repo.get('live_start', 'first')?.messageId).toBe('fake-msg-1');
    expect(repo.get('youtube_upload', 'second')?.messageId).toBe('fake-msg-2');
    outbox.dispose();
  });
});
