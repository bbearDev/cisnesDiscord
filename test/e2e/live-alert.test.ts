import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLiveApiClient } from '../../src/chzzk/live-api-client.js';
import { buildAnnouncementEmbed, createAnnouncer } from '../../src/discord/announcer.js';
import type { LiveAnnounceJob, LiveSessionStore } from '../../src/live/live-announce.js';
import { createLivePoller, type LivePoller } from '../../src/live/live-poller.js';
import { buildSpecs, createStuckWatch } from '../../src/live/stuck-watch.js';
import { createWebhookSilenceWatch, type WebhookSilenceWatch } from '../../src/live/webhook-silence-watch.js';
import { createMemoryAlertState, createOpsAlertService } from '../../src/runtime/alerts/ops-alert-service.js';
import type { AlertKind } from '../../src/runtime/alerts/types.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { createHttpBudget } from '../../src/runtime/http-budget.js';
import { openDb, type Db } from '../../src/store/db.js';
import { migrate } from '../../src/store/migrate.js';
import {
  createAnnouncementLedgerRepo,
  type AnnouncementLedgerRepo,
} from '../../src/store/repos/announcement-ledger-repo.js';
import { createWebServer, type BoundAddress, type WebServer } from '../../src/web/server.js';
import {
  createChzzkbotWebhookRoute,
  CHZZKBOT_WEBHOOK_PATH,
  type OpsEventRecorder,
} from '../../src/web/routes/chzzkbot-webhook.js';
import {
  createFakeChzzkbot,
  loadJsonFixture,
  MIN_TOKEN_LENGTH,
  type FakeChzzkbot,
  type LiveStartedEvent,
} from './harness/fake-chzzkbot.js';
import { createFakeDiscord, type FakeDiscord } from './harness/fake-discord.js';

/**
 * ★ S5 전 구간 e2e — **두 방향 실제 소켓** (계획 §9.3).
 *
 * ```
 *   chzzkbot → 우리 : POST /hooks/chzzkbot/live   (실제 HTTP 서버)
 *   우리 → chzzkbot : GET  /api/live               (실제 HTTP 클라이언트)
 *   우리 → 디스코드 : 가짜 게이트웨이 (발송 캡처 · 지연 주입)
 * ```
 *
 * 여기서만 판정할 수 있는 것:
 *   · **2xx 응답 시간** — 디스코드가 3초 걸려도 우리는 즉시 답한다
 *   · **AC-P6 양방향** — 폴링이 먼저 찾은 뒤 웹훅이 오는가 / 안 오는가
 *   · **웹훅 · 폴링 두 인입이 같은 원장 문을 지난다**
 */

const OURS = 'c3355ea2b3bea6c646789510796379d6';
const DISCORD_CHANNEL = '111222333';
const WEBHOOK_TOKEN = 'w'.repeat(MIN_TOKEN_LENGTH * 2);
const API_TOKEN = 'a'.repeat(MIN_TOKEN_LENGTH * 2);
const GRACE_MS = 10 * 60_000;
const POLL_MS = 3 * 60_000;

let dir: string;
let dbPath: string;
let db: Db;
let ledger: AnnouncementLedgerRepo;
let clock: ManualClock;
let gateway: FakeDiscord;
let upstream: FakeChzzkbot;
let web: WebServer;
let bound: BoundAddress;
let poller: LivePoller;
let silenceWatch: WebhookSilenceWatch;
let raised: { kind: AlertKind; message: string }[];
let announceCalls: LiveAnnounceJob[];

const webhookUrl = (): string =>
  `http://127.0.0.1:${String(bound.port)}${CHZZKBOT_WEBHOOK_PATH}`;

/** 마이크로태스크 + 매크로태스크 큐를 비운다 (비동기 발송이 끝나기를 기다린다) */
const flush = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 10));

const sessions: LiveSessionStore = { record: () => undefined, closeOpen: () => 0 };
const noopOps: OpsEventRecorder = { record: () => undefined };

async function boot(opts: { announceTimeoutMs?: number } = {}): Promise<void> {
  db = openDb({ path: dbPath });
  migrate(db);
  ledger = createAnnouncementLedgerRepo(db);

  const alerts = createOpsAlertService({
    notifier: {
      send: () => Promise.resolve('sent'),
    },
    state: createMemoryAlertState(),
    clock,
    scope: OURS,
    minIntervalMin: 0,
    onEvent: () => undefined,
  });
  // 경보 종류·문구를 세기 위한 얇은 래퍼 (디바운스는 위 서비스가 이미 0 이다).
  const counting = {
    ...alerts,
    raise: (kind: AlertKind, message: string) => {
      raised.push({ kind, message });
      return alerts.raise(kind, message);
    },
    forScope: () => counting,
  };

  const announcer = createAnnouncer({
    gateway,
    alerts,
    clock,
    sleep: () => Promise.resolve(),
    ...(opts.announceTimeoutMs === undefined ? {} : { timeoutMs: opts.announceTimeoutMs }),
  });

  /**
   * ★ composition-root 의 몫. `live`(L4) 는 `discord`(L7) 를 모르므로
   *   임베드→발송 배선이 여기서 만들어진다.
   */
  const announce = async (job: LiveAnnounceJob): Promise<void> => {
    announceCalls.push(job);
    const result = await announcer.announce({
      channelId: DISCORD_CHANNEL,
      label: job.label,
      payload: { embeds: [buildAnnouncementEmbed(job.embed)] },
    });
    const at = clock.date().toISOString();
    if (result.ok) ledger.markSent('live_start', job.liveHash, result.messageId, at);
    else ledger.markFailed('live_start', job.liveHash, result.reason, at);
  };

  silenceWatch = createWebhookSilenceWatch({
    clock,
    alerts: counting,
    graceMs: GRACE_MS,
  });

  poller = createLivePoller({
    client: createLiveApiClient({
      baseUrl: upstream.baseUrl,
      token: API_TOKEN,
      channelId: OURS,
      http: createHttpBudget(),
    }),
    channelId: OURS,
    ledger,
    sessions,
    announce,
    stuckWatch: createStuckWatch({
      specs: buildSpecs({
        confirmedStuckMs: 5 * 60_000,
        pollFailCount: 5,
        rssFailCount: 5,
        renewFailCount: 3,
        followerStaleCount: 3,
      }),
    }),
    alerts: counting,
    clock,
    intervalMs: POLL_MS,
    silenceWatch,
  });

  web = createWebServer({
    routes: [
      createChzzkbotWebhookRoute({
        token: WEBHOOK_TOKEN,
        channelId: OURS,
        ledger,
        sessions,
        announce,
        ops: noopOps,
        clock,
        silenceWatch,
      }),
    ],
  });
  bound = await web.listen(0, '127.0.0.1');
}

async function shutdown(): Promise<void> {
  poller.dispose();
  silenceWatch.dispose();
  await web.close();
  db.close();
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cisnes-live-e2e-'));
  dbPath = join(dir, 'bot.db');
  clock = new ManualClock(Date.parse('2026-09-07T00:00:00.000Z'));
  gateway = createFakeDiscord();
  raised = [];
  announceCalls = [];
  upstream = createFakeChzzkbot({ token: API_TOKEN });
  await upstream.start();
  await boot();
});

afterEach(async () => {
  await shutdown();
  await upstream.close();
  rmSync(dir, { recursive: true, force: true });
});

function webhookEvent(over: Partial<LiveStartedEvent> = {}): LiveStartedEvent {
  return { ...(loadJsonFixture('chzzkbot/webhook-live-started.json') as LiveStartedEvent), ...over };
}

// ══════════════════════════════════════════════════════════════════
//  웹훅 주경로
// ══════════════════════════════════════════════════════════════════

describe('★ 웹훅 → 디스코드', () => {
  it('정상 웹훅 1건이 임베드 1건으로 나간다 (제목 · openedAt 그대로)', async () => {
    const res = await upstream.postLiveStarted(webhookUrl(), webhookEvent(), {
      token: WEBHOOK_TOKEN,
    });
    expect(res.status).toBeLessThan(300);

    await flush();
    expect(gateway.sent).toHaveLength(1);
    const embed = gateway.sent[0]!.payload.embeds?.[0];
    expect(embed).toMatchObject({
      title: '오늘은 잡담방송',
      timestamp: '2026-09-06T18:56:39.000Z',
      footer: { text: '감지: webhook' },
    });
    expect(ledger.get('live_start', 'df09256e')?.announcedAt).toBeDefined();
  });

  it('★ 같은 웹훅 10회 → 디스코드 발송 정확히 1건', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await upstream.postLiveStarted(webhookUrl(), webhookEvent(), {
        token: WEBHOOK_TOKEN,
      });
      expect(res.status).toBeLessThan(300);
      await flush();
    }
    expect(gateway.sent).toHaveLength(1);
  });

  it('★★ 재시작 후 같은 웹훅을 재주입해도 발송 0건 (AC-18)', async () => {
    await upstream.postLiveStarted(webhookUrl(), webhookEvent(), { token: WEBHOOK_TOKEN });
    await flush();
    expect(gateway.sent).toHaveLength(1);

    await shutdown();
    gateway.reset();
    await boot();

    await upstream.postLiveStarted(webhookUrl(), webhookEvent(), { token: WEBHOOK_TOKEN });
    await flush();
    expect(gateway.sent).toHaveLength(0);
  });

  it('토큰 없이 오면 401, 발송 0건', async () => {
    const res = await upstream.postLiveStarted(webhookUrl(), webhookEvent(), { token: null });
    expect(res.status).toBe(401);
    await flush();
    expect(gateway.sent).toHaveLength(0);
  });

  it('version: 2 → 400, 발송 0건', async () => {
    const res = await upstream.postRaw(
      webhookUrl(),
      JSON.stringify(loadJsonFixture('chzzkbot/webhook-version2.json')),
      { token: WEBHOOK_TOKEN },
    );
    expect(res.status).toBe(400);
    await flush();
    expect(gateway.sent).toHaveLength(0);
  });

  it('★ 남의 채널 웹훅 → 200, 발송 0건', async () => {
    const res = await upstream.postRaw(
      webhookUrl(),
      JSON.stringify(loadJsonFixture('chzzkbot/webhook-foreign-channel.json')),
      { token: WEBHOOK_TOKEN },
    );
    expect(res.status).toBe(200);
    await flush();
    expect(gateway.sent).toHaveLength(0);
  });
});

describe('★★ 2xx 응답 시간 — 발송이 늦어도 우리는 기다리지 않는다', () => {
  it('디스코드가 3초 걸려도 2xx 는 500ms 안에 돌아온다', async () => {
    await shutdown();
    gateway = createFakeDiscord({ delayMs: 3_000 });
    // 3초 지연을 발송기가 타임아웃으로 끊지 않게 넉넉히 잡는다 —
    // 여기서 재는 것은 발송 성패가 아니라 **응답 시각**이다.
    await boot({ announceTimeoutMs: 10_000 });

    const started = Date.now();
    const res = await upstream.postLiveStarted(webhookUrl(), webhookEvent(), {
      token: WEBHOOK_TOKEN,
    });
    const elapsed = Date.now() - started;

    expect(res.status).toBeLessThan(300);
    // 계약 timeoutMs 는 5초. 목표는 그 10% 안쪽이다.
    expect(elapsed).toBeLessThan(500);
    // 아직 발송은 진행 중이다 — 2xx 가 발송을 기다리지 않았다는 증거.
    expect(gateway.sent).toHaveLength(0);

    await new Promise<void>((r) => setTimeout(r, 3_300));
    expect(gateway.sent).toHaveLength(1);
  });

  it('디스코드가 영영 응답하지 않아도 2xx 는 즉시 나가고 원장 행이 남는다', async () => {
    gateway.failAlways({ kind: 'hang' });

    const started = Date.now();
    const res = await upstream.postLiveStarted(webhookUrl(), webhookEvent(), {
      token: WEBHOOK_TOKEN,
    });
    expect(res.status).toBeLessThan(300);
    expect(Date.now() - started).toBeLessThan(500);

    // 행은 미발송으로 남아 아웃박스가 다시 집는다 (지우지 않는다).
    expect(ledger.get('live_start', 'df09256e')?.announcedAt).toBeUndefined();
    gateway.failAlways(undefined);
  });
});

// ══════════════════════════════════════════════════════════════════
//  폴링 백스톱 + AC-P6
// ══════════════════════════════════════════════════════════════════

describe('★ 폴링 백스톱', () => {
  it('웹훅이 오지 않은 방송을 폴링이 찾아 공지한다 (detected_via=api-poll, 제목 없음)', async () => {
    upstream.loadLiveFixture('chzzkbot/api-live-announce.json');
    await poller.poll();
    await flush();

    expect(gateway.sent).toHaveLength(1);
    expect(gateway.sent[0]!.payload.embeds?.[0]).toMatchObject({
      title: '시스네 방송이 시작되었습니다',
      timestamp: '2026-09-06T18:56:39.000Z',
      footer: { text: '감지: api-poll' },
    });
    expect(ledger.get('live_start', 'df09256e')?.detectedVia).toBe('api-poll');
  });

  it('★ 웹훅으로 공지한 방송을 폴링이 다시 발견해도 발송 0건 추가', async () => {
    await upstream.postLiveStarted(webhookUrl(), webhookEvent(), { token: WEBHOOK_TOKEN });
    await flush();
    expect(gateway.sent).toHaveLength(1);

    upstream.loadLiveFixture('chzzkbot/api-live-announce.json');
    for (let i = 0; i < 5; i++) {
      await poller.poll();
      await flush();
    }
    expect(gateway.sent).toHaveLength(1);
  });

  it('★★ DD-2 — live:true, confirmed:false 응답을 5회 폴링해도 발송 0건', async () => {
    upstream.loadLiveFixture('chzzkbot/api-live-unconfirmed.json');
    for (let i = 0; i < 5; i++) {
      await poller.poll();
      await flush();
      clock.advance(POLL_MS);
    }
    expect(gateway.sent).toHaveLength(0);
    expect(announceCalls).toHaveLength(0);
  });

  it('상류가 죽어 있어도 발송 0건이고 이벤트 루프가 살아 있다 (웹훅은 계속 받는다)', async () => {
    await upstream.close();
    await poller.poll();
    expect(gateway.sent).toHaveLength(0);

    // 폴링이 죽어도 웹훅 수신구는 그대로 답한다.
    const res = await fetch(webhookUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-chzzkbot-token': WEBHOOK_TOKEN },
      body: JSON.stringify(webhookEvent()),
    });
    expect(res.status).toBeLessThan(300);
    await flush();
    expect(gateway.sent).toHaveLength(1);
  });
});

describe('★★ AC-P6 — 웹훅 침묵 유예창 (양방향)', () => {
  it('폴링이 먼저 찾고 10분이 지나도 웹훅이 없으면 경보 1건', async () => {
    upstream.loadLiveFixture('chzzkbot/api-live-announce.json');
    await poller.poll();
    await flush();
    expect(gateway.sent).toHaveLength(1);

    clock.advance(GRACE_MS);
    expect(raised.filter((r) => r.kind === 'webhook_silence')).toHaveLength(1);
  });

  it('★ 유예창 안(재시도 창 7분)에 웹훅이 도착하면 경보 0건 — 정상 시퀀스다', async () => {
    upstream.loadLiveFixture('chzzkbot/api-live-announce.json');
    await poller.poll();
    await flush();

    // chzzkbot 재시도 큐가 7분 안에 배달한다 — 이건 정상 동작이다.
    clock.advance(7 * 60_000);
    const res = await upstream.postLiveStarted(webhookUrl(), webhookEvent(), {
      token: WEBHOOK_TOKEN,
    });
    expect(res.status).toBeLessThan(300);
    await flush();

    clock.advance(GRACE_MS * 2);
    expect(raised.filter((r) => r.kind === 'webhook_silence')).toHaveLength(0);
    // 재시도로 도착한 웹훅은 중복이므로 발송은 여전히 1건이다.
    expect(gateway.sent).toHaveLength(1);
  });

  it('★ 웹훅이 먼저 온 방송에는 유예창이 걸리지 않는다', async () => {
    await upstream.postLiveStarted(webhookUrl(), webhookEvent(), { token: WEBHOOK_TOKEN });
    await flush();

    upstream.loadLiveFixture('chzzkbot/api-live-announce.json');
    await poller.poll();
    await flush();

    clock.advance(GRACE_MS * 3);
    expect(raised.filter((r) => r.kind === 'webhook_silence')).toHaveLength(0);
  });
});
