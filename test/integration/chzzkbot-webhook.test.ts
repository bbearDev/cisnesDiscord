import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CHZZKBOT_TOKEN_HEADER } from '../../src/chzzk/live-api-client.js';
import type { LiveAnnounceJob, LiveSessionStore } from '../../src/live/live-announce.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { openDb, type Db } from '../../src/store/db.js';
import { migrate } from '../../src/store/migrate.js';
import {
  createAnnouncementLedgerRepo,
  type AnnouncementLedgerRepo,
} from '../../src/store/repos/announcement-ledger-repo.js';
import type { Route, RouteRequest, RouteResponse } from '../../src/web/server.js';
import {
  createChzzkbotWebhookRoute,
  CHZZKBOT_WEBHOOK_PATH,
  LIVE_WEBHOOK_OPS_KINDS,
  type LiveWebhookEvent,
  type OpsEventRecorder,
} from '../../src/web/routes/chzzkbot-webhook.js';
import { loadJsonFixture, MIN_TOKEN_LENGTH } from '../e2e/harness/fake-chzzkbot.js';

/**
 * `POST /hooks/chzzkbot/live` — **실제 SQLite 원장** 위에서 검증한다 (계획 §S5 · §9.2).
 *
 * ★ 원장을 더블로 바꾸면 이 파일이 판정할 수 있는 게 절반으로 준다.
 *   "중복 0" 은 조건문이 아니라 `PRIMARY KEY (kind, event_key)` 가 지키고,
 *   "재시작을 넘어 유지" 는 DB 파일이 지킨다. 둘 다 진짜 DB 라야 성립한다.
 *
 * ★ 운영 기록도 실제 `ops_events` 테이블에 넣는다 — 우리가 쓰는 `kind` 문자열이
 *   그 테이블에 실제로 들어가는지까지 여기서 확인된다.
 */

const OURS = 'c3355ea2b3bea6c646789510796379d6';
const TOKEN = 'a'.repeat(MIN_TOKEN_LENGTH * 2);
const NOW = 1_800_000_000_000;

let dir: string;
let db: Db;
let ledger: AnnouncementLedgerRepo;
let clock: ManualClock;
let route: Route;
let announced: LiveAnnounceJob[];
let events: LiveWebhookEvent[];
let sessions: LiveSessionStore;
let opsRows: () => { kind: string; detail: string | null }[];

function opsRecorder(database: Db): OpsEventRecorder {
  const insert = database.prepare<{ kind: string; detail: string; at: string }, never>(
    'INSERT INTO ops_events (kind, detail, at) VALUES (@kind, @detail, @at)',
  );
  return {
    record(kind, detail, at) {
      insert.run({ kind, detail, at });
    },
  };
}

function post(body: unknown, opts: { token?: string | null } = {}): Promise<RouteResponse> {
  const headers: Record<string, string> = {};
  const t = opts.token === undefined ? TOKEN : opts.token;
  if (t !== null) headers[CHZZKBOT_TOKEN_HEADER] = t;

  const req: RouteRequest = {
    method: 'POST',
    url: new URL(`http://localhost${CHZZKBOT_WEBHOOK_PATH}`),
    headers,
    body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  };
  return Promise.resolve(route.handle(req));
}

function build(): void {
  ledger = createAnnouncementLedgerRepo(db);
  announced = [];
  events = [];
  sessions = {
    record: () => undefined,
    closeOpen: () => 0,
  };
  route = createChzzkbotWebhookRoute({
    token: TOKEN,
    channelId: OURS,
    ledger,
    sessions,
    announce: (job) => {
      announced.push(job);
      return Promise.resolve();
    },
    ops: opsRecorder(db),
    clock,
    onEvent: (e) => {
      events.push(e);
    },
  });
  const select = db.prepare<Record<string, never>, { kind: string; detail: string | null }>(
    'SELECT kind, detail FROM ops_events ORDER BY id',
  );
  opsRows = () => select.all({});
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cisnes-webhook-'));
  db = openDb({ path: join(dir, 'bot.db') });
  migrate(db);
  clock = new ManualClock(NOW);
  build();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════
//  1. 토큰 (AC-14)
// ══════════════════════════════════════════════════════════════════

describe('★★ 1단계 — 토큰 검증', () => {
  it('토큰이 없으면 401 + 운영 기록 1건, 공지 0건', async () => {
    const res = await post(loadJsonFixture('chzzkbot/webhook-live-started.json'), { token: null });
    expect(res.status).toBe(401);
    expect(announced).toHaveLength(0);
    expect(opsRows()).toHaveLength(1);
    expect(opsRows()[0]?.kind).toBe('live_webhook_unauthorized');
  });

  it('토큰이 틀리면 401 + 운영 기록 1건, 공지 0건', async () => {
    const res = await post(loadJsonFixture('chzzkbot/webhook-live-started.json'), {
      token: 'b'.repeat(MIN_TOKEN_LENGTH * 2),
    });
    expect(res.status).toBe(401);
    expect(announced).toHaveLength(0);
    expect(opsRows()[0]?.detail).toContain('불일치');
  });

  it('길이가 다른 토큰에서도 던지지 않는다 (timingSafeEqual 은 길이가 다르면 throw 한다)', async () => {
    for (const t of ['', 'short', `${TOKEN}x`]) {
      const res = await post(loadJsonFixture('chzzkbot/webhook-live-started.json'), { token: t });
      expect(res.status).toBe(401);
    }
  });

  it('★ 인증 실패 시 본문을 파싱하지 않는다 — 깨진 본문이어도 401 이다 (400 아님)', async () => {
    const res = await post('this is not json at all', { token: null });
    expect(res.status).toBe(401);
    expect(opsRows()[0]?.kind).toBe('live_webhook_unauthorized');
  });

  it('★ 토큰 값 자체를 운영 기록에 남기지 않는다', async () => {
    await post(loadJsonFixture('chzzkbot/webhook-live-started.json'), { token: 'super-secret-xyz' });
    for (const row of opsRows()) {
      expect(row.detail ?? '').not.toContain('super-secret-xyz');
    }
  });

  it('원장에도 아무 행이 생기지 않는다', async () => {
    await post(loadJsonFixture('chzzkbot/webhook-live-started.json'), { token: null });
    expect(ledger.get('live_start', 'df09256e')).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════
//  2. 본문 (계약 변경 감지)
// ══════════════════════════════════════════════════════════════════

describe('★★ 2단계 — 본문 검증', () => {
  it('version: 2 → 400 + 운영 기록 1건, 공지 0건', async () => {
    const res = await post(loadJsonFixture('chzzkbot/webhook-version2.json'));
    expect(res.status).toBe(400);
    expect(announced).toHaveLength(0);
    expect(opsRows()).toHaveLength(1);
    expect(opsRows()[0]?.kind).toBe('live_webhook_version_mismatch');
    // 사람이 무엇이 바뀌었는지 읽을 수 있어야 한다.
    expect(opsRows()[0]?.detail).toContain('version=2');
  });

  it('JSON 이 아니면 400 + bad_payload 기록', async () => {
    const res = await post('<html>nope</html>');
    expect(res.status).toBe(400);
    expect(opsRows()[0]?.kind).toBe('live_webhook_bad_payload');
  });

  it('필수 필드가 빠지면 400', async () => {
    const base = loadJsonFixture('chzzkbot/webhook-live-started.json') as Record<string, unknown>;
    delete base.liveHash;
    const res = await post(base);
    expect(res.status).toBe(400);
    expect(opsRows()[0]?.kind).toBe('live_webhook_bad_payload');
  });

  it('우리가 쓰는 ops kind 는 전부 ops_events 에 들어간다', () => {
    const rec = opsRecorder(db);
    for (const kind of LIVE_WEBHOOK_OPS_KINDS) {
      expect(() => {
        rec.record(kind, 'probe', new Date(NOW).toISOString());
      }).not.toThrow();
    }
    expect(opsRows()).toHaveLength(LIVE_WEBHOOK_OPS_KINDS.length);
  });
});

// ══════════════════════════════════════════════════════════════════
//  3. 채널 필터
// ══════════════════════════════════════════════════════════════════

describe('★★ 3단계 — 채널 필터', () => {
  it('남의 채널 웹훅 → 200 + 기록, 공지 0건', async () => {
    const res = await post(loadJsonFixture('chzzkbot/webhook-foreign-channel.json'));
    // ★ 200 이다. 4xx 를 주면 chzzkbot 이 7분간 무의미한 재시도를 돈다.
    expect(res.status).toBe(200);
    expect(announced).toHaveLength(0);
    expect(opsRows()).toHaveLength(1);
    expect(opsRows()[0]?.kind).toBe('live_webhook_foreign_channel');
    expect(opsRows()[0]?.detail).toContain('3594a5258433f765b6247dfe05e5fb33');
  });

  it('★ 남의 채널은 원장을 점유하지 않는다', async () => {
    await post(loadJsonFixture('chzzkbot/webhook-foreign-channel.json'));
    expect(ledger.get('live_start', '421655d8')).toBeUndefined();
  });

  it('남의 채널 웹훅을 10회 받아도 공지 0건', async () => {
    for (let i = 0; i < 10; i++) {
      await post(loadJsonFixture('chzzkbot/webhook-foreign-channel.json'));
    }
    expect(announced).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  4~5. 원장 선점 → 2xx
// ══════════════════════════════════════════════════════════════════

describe('★★ 4·5단계 — 원장 선점이 2xx 보다 먼저다', () => {
  it('정상 웹훅 → 2xx, 원장 1행, 공지 1건', async () => {
    const res = await post(loadJsonFixture('chzzkbot/webhook-live-started.json'));
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    const row = ledger.get('live_start', 'df09256e');
    expect(row).toMatchObject({ detectedVia: 'webhook', seeded: false });
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({ liveHash: 'df09256e', detectedVia: 'webhook' });
    expect(announced[0]!.embed.title).toBe('오늘은 잡담방송');
  });

  it('★ 방송 썸네일이 임베드까지 실려 가고, 어디서 왔는지가 수신 로그에 남는다', async () => {
    await post(loadJsonFixture('chzzkbot/webhook-live-started.json'));
    expect(announced[0]!.embed.image).toBe(
      'https://video-phinf.pstatic.net/live/df09256e/thumbnail_720.jpg',
    );
    // ★ `none`(상류가 안 실었다) 과 `dropped`(우리가 버렸다) 를 가르는 칸이다.
    expect(events.find((e) => e.type === 'claimed')?.image).toBe('live');
  });

  it('★ 상류가 그림을 안 실어도 공지는 그대로 나간다 — 로그에 none 이 남는다', async () => {
    const base = loadJsonFixture('chzzkbot/webhook-live-started.json') as Record<string, unknown>;
    delete base['liveImageUrl'];
    delete base['channelImageUrl'];
    const res = await post(base);
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    expect(announced).toHaveLength(1);
    expect(announced[0]!.embed.image).toBeUndefined();
    const claimed = events.find((e) => e.type === 'claimed');
    expect(claimed?.image).toBe('none');
    // ★ 버린 것이 없다 = 상류가 안 보냈다. 이 조합이라야 우리 쪽을 안 뒤져도 된다.
    expect(claimed?.imageDropped).toBeUndefined();
  });

  it('★★ 그림 주소가 깨져 있어도 공지는 나간다 — 그림만 빠지고 버린 칸이 로그에 남는다', async () => {
    const base = loadJsonFixture('chzzkbot/webhook-live-started.json') as Record<string, unknown>;
    const res = await post({ ...base, liveImageUrl: '깨진 주소', channelImageUrl: '깨진 주소' });
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    expect(announced).toHaveLength(1);
    expect(announced[0]!.embed.image).toBeUndefined();
    const claimed = events.find((e) => e.type === 'claimed');
    // ★ `none` 이지만 buried 가 아니다 — 버린 칸이 함께 남아 "상류가 안 보냄"과 갈린다.
    expect(claimed?.image).toBe('none');
    expect(claimed?.imageDropped).toEqual(['liveImageUrl', 'channelImageUrl']);
  });

  it('★★ 썸네일만 깨졌을 때 — 프로필이 받아 주지만 버린 칸은 반드시 남는다', async () => {
    // 우리 검사가 실제로 발동하는 가장 흔한 모양이다. `image` 만 보면 정상과 구분되지 않아
    // 아무도 안 보게 된다 — 이 케이스가 조용해지는 것이 관측 설계의 실패다.
    const base = loadJsonFixture('chzzkbot/webhook-live-started.json') as Record<string, unknown>;
    const res = await post({ ...base, liveImageUrl: '/relative/thumb.jpg' });
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    // 공지도 그림도 멀쩡하다 — 그래서 더더욱 로그가 말해 줘야 한다.
    expect(announced[0]!.embed.image).toBe(
      'https://nng-phinf.pstatic.net/profile/c3355ea2/profile.jpg',
    );
    const claimed = events.find((e) => e.type === 'claimed');
    expect(claimed?.image).toBe('channel');
    expect(claimed?.imageDropped).toEqual(['liveImageUrl']);
  });

  it('★★ 2xx 를 돌려줄 때 원장 행이 **이미** 커밋돼 있다', async () => {
    // 응답을 받은 시점에 다른 저장소 인스턴스가 그 행을 볼 수 있어야 한다.
    // 못 보면 2xx 를 받은 chzzkbot 이 markDelivered 한 뒤 우리가 죽었을 때
    // 그 방송이 영영 사라진다.
    await post(loadJsonFixture('chzzkbot/webhook-live-started.json'));
    const other = createAnnouncementLedgerRepo(db);
    expect(other.get('live_start', 'df09256e')).toBeDefined();
  });

  it('★ 같은 liveHash 웹훅 10회 → 공지 정확히 1건 (AC-16 · AC-17)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      statuses.push((await post(loadJsonFixture('chzzkbot/webhook-live-started.json'))).status);
    }
    // 전부 2xx 다 — 중복은 오류가 아니라 정상적인 재전송이다.
    expect(statuses.every((s) => s >= 200 && s < 300)).toBe(true);
    expect(announced).toHaveLength(1);
  });

  it('★★ 재시작 후 같은 웹훅을 다시 넣어도 공지 0건 (AC-18)', async () => {
    await post(loadJsonFixture('chzzkbot/webhook-live-started.json'));
    expect(announced).toHaveLength(1);

    // 프로세스 재시작 — DB 파일만 남고 메모리는 전부 사라진다.
    const path = join(dir, 'bot.db');
    db.close();
    db = openDb({ path });
    migrate(db);
    build();

    await post(loadJsonFixture('chzzkbot/webhook-live-started.json'));
    expect(announced).toHaveLength(0);
  });

  it('★★ 원장 쓰기를 실패로 고정하면 5xx 를 준다 (chzzkbot 재시도 유도)', async () => {
    route = createChzzkbotWebhookRoute({
      token: TOKEN,
      channelId: OURS,
      ledger: {
        claim: () => {
          throw new Error('database is locked');
        },
      },
      sessions,
      announce: (job) => {
        announced.push(job);
        return Promise.resolve();
      },
      ops: opsRecorder(db),
      clock,
    });

    const res = await post(loadJsonFixture('chzzkbot/webhook-live-started.json'));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(announced).toHaveLength(0);
    expect(opsRows().at(-1)?.kind).toBe('live_webhook_ledger_failed');
  });

  it('★ 디스코드 발송이 실패해도 2xx 를 되돌리지 않는다', async () => {
    route = createChzzkbotWebhookRoute({
      token: TOKEN,
      channelId: OURS,
      ledger,
      sessions,
      announce: () => Promise.reject(new Error('discord down')),
      ops: opsRecorder(db),
      clock,
    });

    const res = await post(loadJsonFixture('chzzkbot/webhook-live-started.json'));
    expect(res.status).toBeLessThan(300);
    // 원장 행은 남아 있다 — 아웃박스가 다시 집는다.
    expect(ledger.get('live_start', 'df09256e')?.announcedAt).toBeUndefined();
  });

  it('★ seeded 를 세우지 않는다 (스키마 CHECK 가 거부하는 값이다)', async () => {
    await post(loadJsonFixture('chzzkbot/webhook-live-started.json'));
    expect(ledger.get('live_start', 'df09256e')?.seeded).toBe(false);
  });

  it('세션 저장이 실패해도 2xx 와 공지는 그대로다', async () => {
    route = createChzzkbotWebhookRoute({
      token: TOKEN,
      channelId: OURS,
      ledger,
      sessions: {
        record: () => {
          throw new Error('disk full');
        },
        closeOpen: () => 0,
      },
      announce: (job) => {
        announced.push(job);
        return Promise.resolve();
      },
      ops: opsRecorder(db),
      clock,
    });
    const res = await post(loadJsonFixture('chzzkbot/webhook-live-started.json'));
    expect(res.status).toBeLessThan(300);
    expect(announced).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════
//  AC-P6 배선
// ══════════════════════════════════════════════════════════════════

describe('AC-P6 — 수신 사실을 감시자에게 알린다', () => {
  it('★ 중복 웹훅도 수신으로 친다 (판정 대상은 "도착했는가" 다)', async () => {
    const receipts: string[] = [];
    route = createChzzkbotWebhookRoute({
      token: TOKEN,
      channelId: OURS,
      ledger,
      sessions,
      announce: () => Promise.resolve(),
      ops: opsRecorder(db),
      clock,
      silenceWatch: { noteWebhook: (h) => receipts.push(h) },
    });

    await post(loadJsonFixture('chzzkbot/webhook-live-started.json'));
    await post(loadJsonFixture('chzzkbot/webhook-live-started.json'));
    expect(receipts).toEqual(['df09256e', 'df09256e']);
  });

  it('남의 채널 웹훅은 수신으로 치지 않는다', async () => {
    const receipts: string[] = [];
    route = createChzzkbotWebhookRoute({
      token: TOKEN,
      channelId: OURS,
      ledger,
      sessions,
      announce: () => Promise.resolve(),
      ops: opsRecorder(db),
      clock,
      silenceWatch: { noteWebhook: (h) => receipts.push(h) },
    });
    await post(loadJsonFixture('chzzkbot/webhook-foreign-channel.json'));
    expect(receipts).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  웹훅 ↔ 폴링 상호 배제
// ══════════════════════════════════════════════════════════════════

describe('두 인입이 같은 문을 지난다', () => {
  it('★ 웹훅으로 공지한 방송을 폴링이 다시 발견해도 공지 0건', async () => {
    await post(loadJsonFixture('chzzkbot/webhook-live-started.json'));
    expect(announced).toHaveLength(1);

    // 폴링 경로가 같은 키로 선점을 시도한다.
    const again = ledger.claim('live_start', 'df09256e', new Date(NOW).toISOString(), 'api-poll');
    expect(again).toBe(false);
    // 먼저 집은 쪽의 detected_via 가 남는다.
    expect(ledger.get('live_start', 'df09256e')?.detectedVia).toBe('webhook');
  });

  it('★ 폴링이 먼저 집었으면 웹훅은 중복으로 2xx 만 준다', async () => {
    ledger.claim('live_start', 'df09256e', new Date(NOW).toISOString(), 'api-poll');
    const res = await post(loadJsonFixture('chzzkbot/webhook-live-started.json'));
    expect(res.status).toBeLessThan(300);
    expect(announced).toHaveLength(0);
    expect(ledger.get('live_start', 'df09256e')?.detectedVia).toBe('api-poll');
  });
});
