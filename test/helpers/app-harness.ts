/**
 * 앱 조립 하니스 — `bootstrap()` 을 실제 소켓·실제 SQLite 로 띄운다.
 *
 * ★ `main-wiring` 과 US-008 의 두 파일이 **같은 하니스를 공유한다.**
 *   각자 복사하면 하니스가 갈리는 날 **한쪽 테스트만 조용히 다른 앱을 검사한다** —
 *   계획이 되풀이해 경고한 "정의 복제" 의 테스트판이다.
 *
 * ★ 시간은 주입한다(`ManualClock`) — 주기 폴러가 스스로 돌면 "복구가 센 값" 과
 *   "폴러가 센 값" 을 가를 수 없다. `bootstrap()` 은 복구까지만 하고
 *   폴러는 `app.start()` 가 켠다.
 */
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import { afterEach } from 'vitest';

import { bootstrap, type App, type BootstrapOptions } from '../../src/main.js';
import { ManualClock } from '../../src/runtime/clock.js';
import type { AlertEvent } from '../../src/runtime/alerts/ops-alert-service.js';
import type { Notifier, WebhookSendResult } from '../../src/runtime/alerts/discord-webhook.js';
import { openDb, type Db } from '../../src/store/db.js';
import { migrate } from '../../src/store/migrate.js';
import { createGuildConfigRepo } from '../../src/store/repos/guild-config-repo.js';
import { createFakeChzzkbot, type FakeChzzkbot } from '../e2e/harness/fake-chzzkbot.js';
import { createFakeDiscord, type FakeDiscord } from '../e2e/harness/fake-discord.js';

export const SIS = 'c3355ea2b3bea6c646789510796379d6';
export const AIGOM = '3594a5258433f765b6247dfe05e5fb33';
export const GUILD = '111111111111111111';
export const LIVE_CHANNEL = '222222222222222222';
export const UPLOAD_CHANNEL = '333333333333333333';
export const VERIFIED_ROLE = '444444444444444444';
export const GATE_CHANNEL = '555555555555555555';
export const YT_CHANNEL = `UC${'a'.repeat(22)}`;

/** 조립에 필요한 것은 '비어 있지 않은 값' 뿐이다. 실제 모양을 흉내 낼 이유가 없다 */
export const BOT_TOKEN = ['test', 'bot', 'token'].join('-');
export const API_TOKEN = 'a'.repeat(48);
export const WEBHOOK_TOKEN = 'b'.repeat(48);

export const ENV: NodeJS.ProcessEnv = {
  // ★ 봇 토큰 **모양**을 소스에 적지 않는다 — `scripts/secrets-scan.mjs` 가 그 모양을
  //   잡도록 만들어져 있고, 픽스처라는 이유로 예외를 두면 그 그물이 헐거워진다.
  DISCORD_BOT_TOKEN: BOT_TOKEN,
  LIVE_EVENT_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
  LIVE_API_TOKEN: API_TOKEN,
  CHZZK_CLIENT_ID: 'cisnes-viewer-client',
  CHZZK_CLIENT_SECRET: 'cisnes-viewer-secret',
};

export const ATOM_FEED = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">',
  `  <yt:channelId>${YT_CHANNEL}</yt:channelId>`,
  '  <entry>',
  '    <yt:videoId>vid-0001</yt:videoId>',
  `    <yt:channelId>${YT_CHANNEL}</yt:channelId>`,
  '    <title>테스트 업로드</title>',
  '    <published>2026-09-01T00:00:00+00:00</published>',
  '    <updated>2026-09-01T00:00:00+00:00</updated>',
  '  </entry>',
  '</feed>',
].join('\n');

// ══════════════════════════════════════════════════════════════════
//  하니스
// ══════════════════════════════════════════════════════════════════

/** 비어 있는 포트 하나. 가짜 chzzkbot 을 먼저 띄운 뒤 부르므로 그 포트와 겹치지 않는다 */
export async function freePort(): Promise<number> {
  const s: Server = createServer();
  await new Promise<void>((resolve) => {
    s.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const addr = s.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  await new Promise<void>((resolve) => {
    s.close(() => {
      resolve();
    });
  });
  return port;
}

interface Fixture {
  dir: string;
  configPath: string;
  dbPath: string;
  port: number;
}

export function writeConfig(opts: {
  dir: string;
  port: number;
  upstreamBaseUrl: string;
  maxPending?: number;
  youtube?: boolean;
}): Fixture {
  const dbPath = join(opts.dir, 'cisnes.db');
  const configPath = join(opts.dir, 'config.yaml');
  const channels = opts.youtube === true ? `\n    - channelId: ${YT_CHANNEL}\n      label: 테스트` : ' []';
  writeFileSync(
    configPath,
    [
      'logLevel: error',
      'logRetentionDays: 14',
      'paths:',
      `  db: ${dbPath}`,
      `  logs: ${join(opts.dir, 'logs')}`,
      `  lock: ${join(opts.dir, 'cisnes.lock')}`,
      `  heartbeat: ${join(opts.dir, 'heartbeat')}`,
      'startup:',
      '  bindRetrySec: 30',
      'web:',
      `  port: ${String(opts.port)}`,
      '  bindAddress: 127.0.0.1',
      '  publicBaseUrl: https://cisnes.example',
      'chzzkbot:',
      `  baseUrl: ${opts.upstreamBaseUrl}`,
      'live:',
      `  channelId: ${SIS}`,
      '  webhookSilenceGraceMin: 10',
      '  apiPollIntervalMin: 3',
      '  confirmedStuckMin: 5',
      '  pollFailThresholdCount: 5',
      'follower:',
      '  staleAfterMin: 150',
      'http:',
      '  maxConcurrent: 8',
      'auth:',
      '  maxConcurrentFlows: 8',
      '  commandCooldownSec: 30',
      '  sessionTtlMin: 10',
      `  maxPending: ${String(opts.maxPending ?? 512)}`,
      'youtube:',
      `  channels:${channels}`,
      '  rssPollSec: 60',
      '  rssFailThresholdCount: 5',
      '  renewFailThresholdCount: 3',
      '  leaseWarnRatio: 0.2',
      'recovery:',
      '  downtimeThresholdHours: 6',
      'alerts:',
      '  enabled: true',
      '  minIntervalMin: 30',
      '',
    ].join('\n'),
    'utf-8',
  );
  return { dir: opts.dir, configPath, dbPath, port: opts.port };
}

/**
 * 마이그레이션을 실제로 돌린 뒤 `guild_config` 를 심는다.
 *
 * ★ SQL 파일을 직접 exec 하지 않는다. 그러면 `schema_migrations` 에 001 이 남지 않아
 *   봇이 같은 마이그레이션을 다시 적용하려다 죽는다 — 배선 테스트가 아니라
 *   테스트 하니스의 결함으로 실패하게 된다.
 */
export function seedDb(dbPath: string, guild = true, seed?: (db: Db) => void): void {
  const db = openDb({ path: dbPath });
  migrate(db);
  seed?.(db);
  if (guild) {
    createGuildConfigRepo(db).upsert(
      {
        guildId: GUILD,
        verifiedRoleId: VERIFIED_ROLE,
        gateChannelId: GATE_CHANNEL,
        liveChannelId: LIVE_CHANNEL,
        uploadChannelId: UPLOAD_CHANNEL,
      },
      new Date().toISOString(),
    );
  }
  db.close();
}

/** 아직 날아가고 있는 fire-and-forget(경보 발송 등)이 끝나게 한다 */
export function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

export interface Harness {
  app: App;
  fake: FakeDiscord;
  upstream: FakeChzzkbot;
  clock: ManualClock;
  alertEvents: AlertEvent[];
  sent: string[];
}

export const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

export async function boot(
  setup: (upstream: FakeChzzkbot) => void = () => undefined,
  extra: Partial<BootstrapOptions> & {
    maxPending?: number;
    youtube?: boolean;
    seed?: (db: Db) => void;
  } = {},
): Promise<Harness> {
  const upstream = createFakeChzzkbot({ token: API_TOKEN });
  await upstream.start();
  cleanups.push(() => upstream.close());
  setup(upstream);

  const dir = mkdtempSync(join(tmpdir(), 'cisnes-main-'));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
    return Promise.resolve();
  });

  const port = await freePort();
  const fixture = writeConfig({
    dir,
    port,
    upstreamBaseUrl: upstream.baseUrl,
    ...(extra.maxPending === undefined ? {} : { maxPending: extra.maxPending }),
    ...(extra.youtube === undefined ? {} : { youtube: extra.youtube }),
  });
  seedDb(fixture.dbPath, true, extra.seed);

  const clock = new ManualClock(Date.now());
  const fake = createFakeDiscord({ now: () => clock.now() });
  const alertEvents: AlertEvent[] = [];
  const sent: string[] = [];
  const notifier: Notifier = {
    send: (message: string): Promise<WebhookSendResult> => {
      sent.push(message);
      return Promise.resolve('sent');
    },
  };

  const app = await bootstrap({
    configPath: fixture.configPath,
    env: ENV,
    clock,
    logger: pino({ level: 'silent' }),
    gateway: fake,
    notifier,
    onAlertEvent: (e) => alertEvents.push(e),
    configErrorGraceMs: 0,
    ...(extra.fetchImpl === undefined ? {} : { fetchImpl: extra.fetchImpl }),
  });
  cleanups.push(() => app.stop('test'));

  return { app, fake, upstream, clock, alertEvents, sent };
}
