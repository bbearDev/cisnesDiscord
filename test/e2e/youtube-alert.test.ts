import { describe, it, expect, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ManualClock } from '../../src/runtime/clock.js';
import { createHttpBudget } from '../../src/runtime/http-budget.js';
import { createMemoryAlertState, createOpsAlertService } from '../../src/runtime/alerts/ops-alert-service.js';
import { SYSTEM_SCOPE } from '../../src/runtime/alerts/types.js';
import type { Notifier } from '../../src/runtime/alerts/discord-webhook.js';
import { buildSpecs, createStuckWatch, type StuckAlert } from '../../src/live/stuck-watch.js';
import { openDb, type Db } from '../../src/store/db.js';
import { migrate } from '../../src/store/migrate.js';
import {
  createAnnouncementLedgerRepo,
  type AnnouncementLedgerRepo,
} from '../../src/store/repos/announcement-ledger-repo.js';
import { createYoutubeChannelRepo } from '../../src/store/repos/youtube-channel-repo.js';
import { createWebSubSubRepo, type WebSubSubRepo } from '../../src/store/repos/websub-sub-repo.js';
import { createAnnouncer } from '../../src/discord/announcer.js';
import { buildUploadPayload, uploadLabel } from '../../src/discord/upload-embed.js';
import { createTextClient } from '../../src/youtube/http-text.js';
import { parseFeed } from '../../src/youtube/feed-parse.js';
import { createUploadFlow, type UploadFlow } from '../../src/youtube/upload-flow.js';
import {
  RESUBSCRIBE_COOLDOWN_MS,
  createWebSubClient,
  type LeaseWarning,
  type WebSubClient,
} from '../../src/youtube/websub-client.js';
import { createRssPoller, type RssPoller } from '../../src/youtube/rss-poller.js';
import {
  SIGNATURE_HEADER,
  createSignatureFailureCounter,
  createWebSubRoutes,
} from '../../src/web/routes/websub.js';
import type { Route, RouteResponse } from '../../src/web/server.js';
import { createFakeDiscord, type FakeDiscord } from './harness/fake-discord.js';

/**
 * 계획 §S6 수용 기준 — `youtube-alert` 전 구간 (AC-20~26 · AC-P4 · AC-P5 · AC-P7).
 *
 * ★★ 이 파일이 판정하는 문장들:
 *   AC-22  종류를 판별하지 않는다 → 섞인 피드 4건이 **전부** 공지된다
 *   AC-23  키는 `videoId` 단독 → 제목 수정 재푸시 3회에도 공지는 1건
 *   AC-24  재기동 후 재푸시 → 0건 (원장이 SQLite 에 있다)
 *   AC-25  RSS 발견분도 같은 `claim` → `detected_via='rss'`
 *   AC-26  빈 DB + 15영상 → 공지 0건, 원장 15행 `seeded=1`
 *   AC-P4  RSS 5연속 실패 → 경보 1건 / 4회 → 0건 / 1회 성공이 리셋
 *   AC-P5  틀린 서명 → 202 + 공지 0 + `websub_signature_failures` +1
 *   AC-P7  리스 잔여 15% → 1건 / 25% → 0건, 갱신 3연속 실패 → 1건 / 2회 → 0건
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/youtube');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

const CH = 'UCcisnesTest0000000001';
const LABEL = '시스네 테스트 채널';
const HUB = 'https://hub.test/subscribe';
const CALLBACK = 'https://bot.test/websub';
const UPLOAD_CHANNEL = 'discord-upload-channel';
const T0 = Date.parse('2026-09-07T00:00:00.000Z');

/** 엔트리가 없는 정상 피드 — AC-26 시딩을 "공지 0건" 으로 통과시키는 데 쓴다 */
const EMPTY_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
  <yt:channelId>${CH}</yt:channelId>
  <title>${LABEL}</title>
</feed>`;

// ══════════════════════════════════════════════════════════════════
//  하니스
// ══════════════════════════════════════════════════════════════════

interface FakeNet {
  /** 채널별 피드 본문. `undefined` 면 폴이 네트워크 오류로 실패한다 */
  feeds: Map<string, string | undefined>;
  feedStatus: Map<string, number>;
  hubRequests: { mode: string; topic: string; callback: string; secret: string }[];
  /** 허브가 구독 요청을 받아 주는가 */
  hubAccepts: boolean;
  /** 허브가 검증 GET 을 곧바로 보내는가 */
  autoVerify: boolean;
  /** 허브가 검증에 실어 보내는 `hub.lease_seconds`. undefined 면 싣지 않는다 */
  leaseSeconds: number | undefined;
}

interface Harness {
  clock: ManualClock;
  db: Db;
  ledger: AnnouncementLedgerRepo;
  subs: WebSubSubRepo;
  discord: FakeDiscord;
  flow: UploadFlow;
  websub: WebSubClient;
  poller: RssPoller;
  net: FakeNet;
  counter: ReturnType<typeof createSignatureFailureCounter>;
  alerts: StuckAlert[];
  leaseWarnings: LeaseWarning[];
  get: Route;
  post: Route;
  /** 서명된 푸시 1건. `secret` 을 주면 그것으로 서명한다 (AC-P5) */
  push(xml: string, secret?: string): Promise<RouteResponse>;
  /** AC-26 시딩만 마쳐 둔다 — 이후 폴·푸시가 통상 경로를 타게 한다 */
  seed(): Promise<void>;
  close(): void;
}

interface BuildOptions {
  dbPath?: string;
  leaseSeconds?: number | undefined;
  autoVerify?: boolean;
}

function build(opts: BuildOptions = {}): Harness {
  const clock = new ManualClock(T0);
  const db = openDb({ path: opts.dbPath ?? ':memory:' });
  migrate(db);

  const ledger = createAnnouncementLedgerRepo(db);
  const channels = createYoutubeChannelRepo(db);
  const subs = createWebSubSubRepo(db);

  const net: FakeNet = {
    feeds: new Map([[CH, EMPTY_FEED]]),
    feedStatus: new Map(),
    hubRequests: [],
    hubAccepts: true,
    autoVerify: opts.autoVerify ?? true,
    leaseSeconds: 'leaseSeconds' in opts ? opts.leaseSeconds : 4_000,
  };

  // ★ 라우트는 fetch 대역보다 나중에 만들어진다 (허브가 우리 콜백을 되부르므로
  //   순환 참조다). 가변 홀더로 끊는다.
  const routeRef: { get?: Route } = {};
  let challengeSeq = 0;

  /** 허브가 우리 콜백으로 검증 GET 을 보낸다 */
  async function deliverVerification(callback: string, mode: string, topic: string): Promise<void> {
    const u = new URL(callback);
    u.searchParams.set('hub.mode', mode);
    u.searchParams.set('hub.topic', topic);
    challengeSeq += 1;
    u.searchParams.set('hub.challenge', `challenge-${String(challengeSeq)}`);
    if (net.leaseSeconds !== undefined) {
      u.searchParams.set('hub.lease_seconds', String(net.leaseSeconds));
    }
    await routeRef.get?.handle({ method: 'GET', url: u, headers: {}, body: Buffer.alloc(0) });
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const href =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);

    if (href.startsWith(HUB)) {
      const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
      net.hubRequests.push({
        mode: form.get('hub.mode') ?? '',
        topic: form.get('hub.topic') ?? '',
        callback: form.get('hub.callback') ?? '',
        secret: form.get('hub.secret') ?? '',
      });
      if (!net.hubAccepts) {
        return new Response('허브가 거절했습니다', {
          status: 503,
          headers: { 'content-type': 'text/plain' },
        });
      }
      if (net.autoVerify) {
        await deliverVerification(
          form.get('hub.callback') ?? '',
          form.get('hub.mode') ?? '',
          form.get('hub.topic') ?? '',
        );
      }
      return new Response(null, { status: 202 });
    }

    const channelId = url.searchParams.get('channel_id') ?? '';
    const body = net.feeds.get(channelId);
    if (body === undefined) throw new Error(`ENOTFOUND ${url.host}`);
    return new Response(body, {
      status: net.feedStatus.get(channelId) ?? 200,
      headers: { 'content-type': 'application/atom+xml; charset=utf-8' },
    });
  };

  const budget = createHttpBudget({
    // ★★ 이 한 줄이 composition-root 배선 요구다 (`http-text.ts` 머리말).
    fetchImpl,
    now: () => clock.now(),
    sleep: () => Promise.resolve(),
  });
  const http = createTextClient(budget);

  const discord = createFakeDiscord({ now: () => clock.now() });
  const notifier: Notifier = { send: () => Promise.resolve('sent') };
  const opsAlerts = createOpsAlertService({
    notifier,
    state: createMemoryAlertState(),
    clock,
    scope: SYSTEM_SCOPE,
    minIntervalMin: 0,
  });
  const announcer = createAnnouncer({
    gateway: discord,
    alerts: opsAlerts,
    clock,
    sleep: () => Promise.resolve(),
  });

  const flow = createUploadFlow({
    ledger,
    channels,
    clock,
    // ★ composition-root 배선: `youtube`(L5)는 임베드를 모른다. 여기서 꽂는다.
    send: async (entry, detectedVia) => {
      const r = await announcer.announce({
        channelId: UPLOAD_CHANNEL,
        payload: buildUploadPayload(entry, detectedVia),
        label: uploadLabel(entry),
      });
      return r.ok ? { ok: true, messageId: r.messageId } : { ok: false, reason: r.reason };
    },
  });

  const stuck = createStuckWatch({
    specs: buildSpecs({
      confirmedStuckMs: 5 * 60_000,
      pollFailCount: 5,
      rssFailCount: 5,
      renewFailCount: 3,
      followerStaleCount: 3,
    }),
  });

  const alerts: StuckAlert[] = [];
  const leaseWarnings: LeaseWarning[] = [];
  const configured = [{ channelId: CH, label: LABEL }];

  let secretSeq = 0;
  const websub = createWebSubClient({
    http,
    subs,
    channels,
    configured,
    callbackUrl: CALLBACK,
    clock,
    stuck,
    leaseWarnRatio: 0.2,
    hubUrl: HUB,
    secretFactory: () => {
      secretSeq += 1;
      return `secret-${String(secretSeq)}`;
    },
    onAlert: (a) => {
      alerts.push(a);
    },
    onLeaseWarning: (w) => {
      leaseWarnings.push(w);
    },
  });

  const counter = createSignatureFailureCounter();
  const routes = createWebSubRoutes({
    secretFor: (c) => websub.secretFor(c),
    verify: (input) => websub.verify(input),
    async onPush(channelId, xml) {
      const parsed = parseFeed(xml);
      if (!parsed.ok) return;
      await flow.handle(channelId, parsed.entries, 'websub');
    },
    onSignatureFailure: (channel, reason) => {
      counter.record(channel, reason);
    },
  });
  const getRoute = routes.find((r) => r.method === 'GET');
  const postRoute = routes.find((r) => r.method === 'POST');
  if (getRoute === undefined || postRoute === undefined) throw new Error('라우트가 없습니다');
  routeRef.get = getRoute;

  const poller = createRssPoller({
    http,
    flow,
    channels,
    configured,
    clock,
    stuck,
    pollSec: 60,
    onAlert: (a) => {
      alerts.push(a);
    },
  });

  return {
    clock,
    db,
    ledger,
    subs,
    discord,
    flow,
    websub,
    poller,
    net,
    counter,
    alerts,
    leaseWarnings,
    get: getRoute,
    post: postRoute,

    async push(xml, secret): Promise<RouteResponse> {
      const key = secret ?? websub.secretFor(CH) ?? '';
      const body = Buffer.from(xml, 'utf8');
      const sig = `sha1=${createHmac('sha1', key).update(body).digest('hex')}`;
      return await postRoute.handle({
        method: 'POST',
        url: new URL(`${CALLBACK}?channel=${CH}`),
        headers: { [SIGNATURE_HEADER]: sig },
        body,
      });
    },

    async seed(): Promise<void> {
      net.feeds.set(CH, EMPTY_FEED);
      await poller.pollOnce(CH);
    },

    close(): void {
      poller.stop();
      websub.stop();
      db.close();
    },
  };
}

const open: Harness[] = [];
function harness(opts?: BuildOptions): Harness {
  const h = build(opts);
  open.push(h);
  return h;
}

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

/** 발송된 임베드 제목 목록 */
function titles(h: Harness): string[] {
  return h.discord.sent.map((s) => s.payload.embeds?.[0]?.title ?? '');
}

// ══════════════════════════════════════════════════════════════════
//  AC-26 — 최초 시딩
// ══════════════════════════════════════════════════════════════════

describe('AC-26 — 빈 DB 로 처음 기동하면 소급 공지하지 않는다', () => {
  it('★★ 15영상 → 공지 0건, 원장 15행이 seeded=1 이다', async () => {
    const h = harness();
    h.net.feeds.set(CH, fixture('feed-15-seed.xml'));

    const out = await h.poller.pollOnce(CH);

    expect(h.discord.sent).toHaveLength(0);
    expect(out.ok && out.flow.seeded).toBe(15);
    expect(out.ok && out.flow.announced).toBe(0);

    const rows = h.db
      .prepare(
        `SELECT event_key, seeded, detected_via, announced_at
           FROM announcement_ledger WHERE kind = 'youtube_upload'`,
      )
      .all() as { event_key: string; seeded: number; detected_via: string; announced_at: string | null }[];
    expect(rows).toHaveLength(15);
    expect(rows.every((r) => r.seeded === 1)).toBe(true);
    expect(rows.every((r) => r.detected_via === 'seed')).toBe(true);
    // 선점만 했으므로 발송 시각은 비어 있다.
    expect(rows.every((r) => r.announced_at === null)).toBe(true);
  });

  it('★★ 시딩은 채널당 한 번뿐 — 두 번째 폴부터는 신규가 공지된다', async () => {
    const h = harness();
    h.net.feeds.set(CH, fixture('feed-15-seed.xml'));
    await h.poller.pollOnce(CH);
    expect(h.discord.sent).toHaveLength(0);

    // 같은 피드에 신규 1건이 얹힌다.
    h.net.feeds.set(CH, fixture('push-single.xml'));
    await h.poller.pollOnce(CH);

    expect(h.discord.sent).toHaveLength(1);
    expect(titles(h)).toEqual(['푸시로 도착한 신규 업로드']);
  });

  it('시딩한 15건은 이후 폴에서 다시 공지되지 않는다', async () => {
    const h = harness();
    h.net.feeds.set(CH, fixture('feed-15-seed.xml'));
    await h.poller.pollOnce(CH);
    await h.poller.pollOnce(CH);
    await h.poller.pollOnce(CH);
    expect(h.discord.sent).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  AC-22 — 영상 종류를 판별하지 않는다
// ══════════════════════════════════════════════════════════════════

describe('AC-22 — 섞인 피드 4건이 전부 공지된다', () => {
  it('★★ 롱폼·쇼츠·예약공개·라이브다시보기 → 공지 4건, 누락 0', async () => {
    const h = harness();
    await h.seed();

    h.net.feeds.set(CH, fixture('feed-mixed.xml'));
    const out = await h.poller.pollOnce(CH);

    expect(out.ok && out.flow.announced).toBe(4);
    expect(h.discord.sent).toHaveLength(4);
    expect(titles(h)).toEqual([
      '롱폼 영상 — 40분짜리 합방 다시보기',
      '쇼츠 — 30초 클립',
      '예약공개 — 신곡 커버 프리미어',
      '라이브 다시보기 — 9월 5일 방송',
    ]);

    for (const id of ['LONGFORM001', 'SHORTS00002', 'PREMIERE0003', 'LIVEVOD00004']) {
      const row = h.ledger.get('youtube_upload', id);
      expect(row?.announcedAt).toBeDefined();
      expect(row?.seeded).toBe(false);
    }
  });

  it('임베드가 종류와 무관하게 같은 모양이다 (색·URL·타임스탬프)', async () => {
    const h = harness();
    await h.seed();
    h.net.feeds.set(CH, fixture('feed-mixed.xml'));
    await h.poller.pollOnce(CH);

    const embeds = h.discord.sent.map((s) => s.payload.embeds?.[0]);
    expect(new Set(embeds.map((e) => e?.color)).size).toBe(1);
    expect(embeds.map((e) => e?.url)).toEqual([
      'https://www.youtube.com/watch?v=LONGFORM001',
      'https://www.youtube.com/watch?v=SHORTS00002',
      'https://www.youtube.com/watch?v=PREMIERE0003',
      'https://www.youtube.com/watch?v=LIVEVOD00004',
    ]);
    // ★ 타임스탬프는 publishedAt 이다 — updatedAt 이 아니다.
    expect(embeds[0]?.timestamp).toBe('2026-09-06T10:00:00+00:00');
  });

  it('★★ 종류를 판별하는 코드가 소스에 없다 (회귀 방어)', () => {
    // AC-22 는 "지금 4건이 나간다" 만으로는 지켜지지 않는다. 누군가 "쇼츠는 빼자"
    // 를 넣는 순간 다시 깨지고, 그 변경은 **분기를 추가하는 모양**으로 온다.
    const files = [
      ...readdirSync(join(FIXTURES, '../../../src/youtube')).map((f) =>
        join(FIXTURES, '../../../src/youtube', f),
      ),
      join(FIXTURES, '../../../src/discord/upload-embed.ts'),
    ].filter((f) => f.endsWith('.ts'));

    const banned = /liveStreamingDetails|contentDetails|\bisShort\b|\bshorts\b|videoDuration/i;
    for (const f of files) {
      // 주석은 뺀다 — 머리말은 "왜 이 분기가 없는가" 를 설명하느라 그 이름들을
      // 일부러 적고 있다. 우리가 막으려는 것은 **실행되는 분기**다.
      const code = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('//'))
        .join('\n');
      expect({ file: f, hit: banned.test(code) }).toEqual({ file: f, hit: false });
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  AC-23 / AC-24 — 멱등 키는 videoId 단독, 재기동해도 유지
// ══════════════════════════════════════════════════════════════════

describe('AC-23 — 제목 수정 재푸시', () => {
  it('★★ 첫 푸시 1건 + 제목 수정 재푸시 3회 → 공지 정확히 1건', async () => {
    const h = harness();
    await h.seed();
    await h.websub.subscribe(CH);

    expect((await h.push(fixture('push-single.xml'))).status).toBe(202);
    expect(h.discord.sent).toHaveLength(1);

    for (let i = 0; i < 3; i++) {
      const res = await h.push(fixture('push-title-edited.xml'));
      expect(res.status).toBe(202);
    }

    expect(h.discord.sent).toHaveLength(1);
    expect(titles(h)).toEqual(['푸시로 도착한 신규 업로드']);
  });

  it('원장에는 첫 감지 경로가 남는다 (진 쪽이 덮지 않는다)', async () => {
    const h = harness();
    await h.seed();
    await h.websub.subscribe(CH);
    await h.push(fixture('push-single.xml'));

    // 같은 영상을 RSS 폴백이 다시 발견해도 중복 흡수된다.
    h.net.feeds.set(CH, fixture('push-title-edited.xml'));
    await h.poller.pollOnce(CH);

    expect(h.discord.sent).toHaveLength(1);
    expect(h.ledger.get('youtube_upload', 'PUSHVIDEO001')?.detectedVia).toBe('websub');
  });
});

describe('AC-24 — 재기동 후에도 중복이 없다', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('★★ 재기동 + 같은 영상 재푸시 → 공지 0건', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cisnes-youtube-'));
    const dbPath = join(dir, 'bot.db');

    const first = harness({ dbPath });
    await first.seed();
    await first.websub.subscribe(CH);
    await first.push(fixture('push-single.xml'));
    expect(first.discord.sent).toHaveLength(1);
    const secretBefore = first.websub.secretFor(CH);
    first.close();
    open.pop();

    // ── 재기동 ────────────────────────────────────────────────────
    const second = harness({ dbPath });
    // ★ 시크릿이 DB 에서 살아 돌아온다. 매 기동마다 새로 만들면 허브의 모든
    //   푸시가 서명 실패로 버려져 업로드가 조용히 사라진다.
    expect(second.websub.secretFor(CH)).toBe(secretBefore);

    const res = await second.push(fixture('push-single.xml'));
    expect(res.status).toBe(202);
    expect(second.discord.sent).toHaveLength(0);

    // 제목이 바뀐 재푸시도 마찬가지다 — 키가 videoId 단독이기 때문이다.
    await second.push(fixture('push-title-edited.xml'));
    expect(second.discord.sent).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  AC-25 — RSS 폴백
// ══════════════════════════════════════════════════════════════════

describe('AC-25 — WebSub 이 죽어도 누락이 없다', () => {
  it('★★ 푸시가 오지 않는 동안 RSS 가 찾아내 공지한다 (detected_via=rss)', async () => {
    const h = harness();
    await h.seed();

    // WebSub 은 완전히 침묵한다 — 푸시를 한 건도 넣지 않는다.
    h.net.feeds.set(CH, fixture('push-single.xml'));
    const out = await h.poller.pollOnce(CH);

    expect(out.ok && out.flow.announced).toBe(1);
    expect(h.discord.sent).toHaveLength(1);
    expect(h.ledger.get('youtube_upload', 'PUSHVIDEO001')?.detectedVia).toBe('rss');
    // ★ 푸터가 감지 경로를 싣는다 — 사람이 지표를 안 봐도 눈으로 알아챈다.
    expect(h.discord.sent[0]?.payload.embeds?.[0]?.footer?.text).toBe('감지: rss');
  });

  it('★ 발송에 실패해도 원장 행을 지우지 않는다 (아웃박스가 회수한다)', async () => {
    const h = harness();
    await h.seed();
    h.discord.failAlways({ kind: 'server', status: 503 });

    h.net.feeds.set(CH, fixture('push-single.xml'));
    const out = await h.poller.pollOnce(CH);

    expect(out.ok && out.flow.failed).toBe(1);
    const row = h.ledger.get('youtube_upload', 'PUSHVIDEO001');
    expect(row).toBeDefined();
    expect(row?.announcedAt).toBeUndefined();
    expect(row?.attempts).toBe(1);
    expect(h.ledger.pendingRetries().map((p) => p.eventKey)).toContain('PUSHVIDEO001');

    // ★★ 지우지 않았으므로 폴백이 다시 선점하지 못한다 — 중복이 나지 않는다.
    h.discord.failAlways(undefined);
    await h.poller.pollOnce(CH);
    expect(h.discord.sent).toHaveLength(0);
  });

  it('깨진 피드에 폴 루프가 죽지 않는다', async () => {
    const h = harness();
    await h.seed();
    h.net.feeds.set(CH, fixture('feed-broken.xml'));
    const out = await h.poller.pollOnce(CH);
    expect(out.ok).toBe(false);
    expect(h.discord.sent).toHaveLength(0);

    h.net.feeds.set(CH, fixture('push-single.xml'));
    expect((await h.poller.pollOnce(CH)).ok).toBe(true);
    expect(h.discord.sent).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════
//  AC-P4 — RSS 폴러 건강도
// ══════════════════════════════════════════════════════════════════

describe('AC-P4 — RSS 연속 실패 경보', () => {
  it('★★ 4회 연속 실패 → 경보 0건 / 5회째 → 정확히 1건', async () => {
    const h = harness();
    await h.seed();
    h.net.feeds.set(CH, undefined); // 네트워크 오류

    for (let i = 0; i < 4; i++) await h.poller.pollOnce(CH);
    expect(h.alerts).toHaveLength(0);
    expect(h.poller.failStreaks()).toEqual([{ channelId: CH, streak: 4 }]);

    await h.poller.pollOnce(CH);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({
      domain: 'rss',
      kind: 'rss_fail',
      scopeKey: CH,
      value: 5,
      threshold: 5,
    });
  });

  it('★ 임계를 넘긴 뒤에도 에피소드당 1건이다 (장애 중 도배 금지)', async () => {
    const h = harness();
    await h.seed();
    h.net.feeds.set(CH, undefined);
    for (let i = 0; i < 20; i++) await h.poller.pollOnce(CH);
    expect(h.alerts).toHaveLength(1);
  });

  it('★★ 중간에 1회라도 성공하면 카운터가 리셋된다', async () => {
    const h = harness();
    await h.seed();

    h.net.feeds.set(CH, undefined);
    for (let i = 0; i < 4; i++) await h.poller.pollOnce(CH);
    expect(h.poller.failStreaks()[0]?.streak).toBe(4);

    h.net.feeds.set(CH, EMPTY_FEED);
    await h.poller.pollOnce(CH);
    expect(h.poller.failStreaks()[0]?.streak).toBe(0);

    // 리셋됐으므로 다시 4회로는 경보가 없다.
    h.net.feeds.set(CH, undefined);
    for (let i = 0; i < 4; i++) await h.poller.pollOnce(CH);
    expect(h.alerts).toHaveLength(0);
    await h.poller.pollOnce(CH);
    expect(h.alerts).toHaveLength(1);
  });

  it('★ 파싱 실패도 폴 실패로 센다', async () => {
    const h = harness();
    await h.seed();
    h.net.feeds.set(CH, fixture('feed-broken.xml'));
    for (let i = 0; i < 5; i++) await h.poller.pollOnce(CH);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]?.kind).toBe('rss_fail');
  });

  it('★ 발송 실패는 폴 실패가 아니다 (디스코드 장애를 RSS 고장으로 오진하지 않는다)', async () => {
    const h = harness();
    await h.seed();
    h.discord.failAlways({ kind: 'server' });
    h.net.feeds.set(CH, fixture('feed-mixed.xml'));
    for (let i = 0; i < 10; i++) await h.poller.pollOnce(CH);
    expect(h.alerts.filter((a) => a.kind === 'rss_fail')).toHaveLength(0);
    expect(h.poller.failStreaks()[0]?.streak).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  AC-P5 — 서명 검증 실패
// ══════════════════════════════════════════════════════════════════

describe('AC-P5 — 틀린 서명은 조용한 202 + 지표', () => {
  it('★★ 202 + 공지 0건 + websub_signature_failures 가 정확히 1 증가한다', async () => {
    const h = harness();
    await h.seed();
    await h.websub.subscribe(CH);
    expect(h.counter.total).toBe(0);

    const res = await h.push(fixture('push-single.xml'), '공격자가-고른-시크릿');

    // 계약대로 조용히 받아 준다 — 4xx 를 주면 허브가 구독을 끊는다.
    expect(res.status).toBe(202);
    expect(h.discord.sent).toHaveLength(0);
    expect(h.ledger.get('youtube_upload', 'PUSHVIDEO001')).toBeUndefined();
    // ★ 지표가 없으면 "시크릿 불일치"와 "허브가 안 보냄"을 구분할 수 없다.
    expect(h.counter.count(CH)).toBe(1);
    expect(h.counter.total).toBe(1);
  });

  it('맞는 서명으로 다시 오면 정상 공지된다 (원장이 오염되지 않았다)', async () => {
    const h = harness();
    await h.seed();
    await h.websub.subscribe(CH);

    await h.push(fixture('push-single.xml'), '틀린-시크릿');
    expect(h.discord.sent).toHaveLength(0);

    await h.push(fixture('push-single.xml'));
    expect(h.discord.sent).toHaveLength(1);
    expect(h.counter.total).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════
//  AC-20 / AC-P7 — 구독 · 리스 · 갱신
// ══════════════════════════════════════════════════════════════════

describe('AC-20 — 구독과 리스', () => {
  it('★★ expires_at 이 허브 응답값 기준으로 채워진다 (상수가 아니다)', async () => {
    const h = harness({ leaseSeconds: 4_000 });
    const r = await h.websub.subscribe(CH);
    expect(r.ok).toBe(true);

    const row = h.subs.get(CH);
    expect(row?.leaseSeconds).toBe(4_000);
    expect(row?.expiresAt).toBe(new Date(T0 + 4_000_000).toISOString());

    // 허브가 요구한 대로 보냈는가.
    expect(h.net.hubRequests[0]).toMatchObject({
      mode: 'subscribe',
      topic: `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${CH}`,
      callback: `${CALLBACK}?channel=${CH}`,
    });
    expect(h.net.hubRequests[0]?.secret).not.toBe('');
  });

  it('★★ 허브가 다른 리스를 주면 그 값이 그대로 들어간다 — 5일을 박지 않았다', async () => {
    const h = harness({ leaseSeconds: 777 });
    await h.websub.subscribe(CH);
    expect(h.subs.get(CH)?.leaseSeconds).toBe(777);
    expect(h.subs.get(CH)?.expiresAt).toBe(new Date(T0 + 777_000).toISOString());
  });

  it('★ 허브가 lease_seconds 를 안 주면 만료를 지어내지 않는다', async () => {
    const h = harness({ leaseSeconds: undefined });
    await h.websub.subscribe(CH);
    const row = h.subs.get(CH);
    expect(row?.leaseSeconds).toBeUndefined();
    expect(row?.expiresAt).toBeUndefined();
  });

  it('★ 토픽이 다른 검증은 거절한다 (404) — 남의 피드를 우리 이름으로 공지하지 않는다', () => {
    const h = harness();
    const v = h.websub.verify({
      channelId: CH,
      mode: 'subscribe',
      topic: 'https://evil.test/feed',
      leaseSecondsRaw: '4000',
    });
    expect(v.accepted).toBe(false);
  });

  it('설정에 없는 채널의 검증은 거절한다', () => {
    const h = harness();
    const v = h.websub.verify({ channelId: 'UCother', mode: 'subscribe', topic: 'x' });
    expect(v.accepted).toBe(false);
  });

  it('★ 기동 시 모든 구독의 잔여를 로그 한 줄로 남긴다 (AC-P7)', async () => {
    const logs: { message: string; extra?: Record<string, unknown> }[] = [];
    const h = harness();
    // 별도 클라이언트가 아니라 같은 배선으로 재확인한다.
    await h.websub.subscribe(CH);
    const spy = createWebSubClient({
      http: createTextClient(createHttpBudget({ fetchImpl: () => Promise.reject(new Error('x')) })),
      subs: h.subs,
      channels: createYoutubeChannelRepo(h.db),
      configured: [{ channelId: CH, label: LABEL }],
      callbackUrl: CALLBACK,
      clock: h.clock,
      stuck: createStuckWatch({
        specs: buildSpecs({
          confirmedStuckMs: 1,
          pollFailCount: 5,
          rssFailCount: 5,
          renewFailCount: 3,
          followerStaleCount: 3,
        }),
      }),
      leaseWarnRatio: 0.2,
      hubUrl: HUB,
      onLog: (message, extra) => {
        logs.push({ message, ...(extra === undefined ? {} : { extra }) });
      },
    });
    await spy.start();
    spy.stop();

    const line = logs.find((l) => l.message === 'websub 구독 잔여');
    expect(line).toBeDefined();
    const subsLine = line?.extra?.['subscriptions'] as { channelId: string; remainingRatio: number }[];
    expect(subsLine).toHaveLength(1);
    expect(subsLine[0]?.channelId).toBe(CH);
    expect(subsLine[0]?.remainingRatio).toBe(1);
  });
});

describe('AC-P7 — 50% 갱신', () => {
  it('★★ 50% 직전에는 갱신하지 않고, 50% 에 도달하면 갱신한다', async () => {
    // 리스 4000초 → 갱신 시점 2000초. 재구독 쿨다운(600초)보다 충분히 길다 —
    // 실제 리스(일 단위)에서 그 관계가 성립하는 것과 같은 배치다.
    const h = harness({ leaseSeconds: 4_000 });
    await h.websub.subscribe(CH);
    expect(h.net.hubRequests).toHaveLength(1);

    h.clock.advance(1_999_000); // 49.98%
    await h.websub.sweep();
    expect(h.net.hubRequests).toHaveLength(1);

    h.clock.advance(1_000); // 정확히 50%
    await h.websub.sweep();
    expect(h.net.hubRequests).toHaveLength(2);
    expect(h.net.hubRequests[1]?.mode).toBe('subscribe');

    // 갱신 검증이 새 만료를 넣는다.
    expect(h.subs.get(CH)?.expiresAt).toBe(new Date(T0 + 2_000_000 + 4_000_000).toISOString());
  });

  it('★ 아직 검증되지 않은 구독은 쿨다운 뒤에 다시 시도한다', async () => {
    const h = harness({ autoVerify: false });
    await h.websub.subscribe(CH);
    expect(h.net.hubRequests).toHaveLength(1);

    h.clock.advance(60_000);
    await h.websub.sweep();
    expect(h.net.hubRequests).toHaveLength(1); // 쿨다운 안

    h.clock.advance(10 * 60_000);
    await h.websub.sweep();
    expect(h.net.hubRequests).toHaveLength(2);
  });
});

describe('AC-P7 — 리스 잔량 경보', () => {
  async function subscribedThenSilent(leaseSeconds: number): Promise<Harness> {
    const h = harness({ leaseSeconds });
    await h.websub.subscribe(CH);
    // 이후 허브는 받아만 주고 검증을 보내지 않는다 — 리스가 그대로 줄어든다.
    h.net.autoVerify = false;
    return h;
  }

  it('★★ 잔여 15% → 경보 1건', async () => {
    const h = await subscribedThenSilent(1_000);
    h.clock.advance(850_000); // 잔여 150초 / 1000초 = 15%
    const out = await h.websub.sweep();

    expect(out.warnings).toHaveLength(1);
    expect(h.leaseWarnings).toHaveLength(1);
    expect(h.leaseWarnings[0]).toMatchObject({ channelId: CH, remainingSec: 150 });
    expect(h.leaseWarnings[0]?.ratio).toBeCloseTo(0.15, 5);
  });

  it('★★ 잔여 25% → 경보 0건 (경보선은 0.2 다)', async () => {
    const h = await subscribedThenSilent(1_000);
    h.clock.advance(750_000); // 잔여 250초 = 25%
    const out = await h.websub.sweep();

    expect(out.warnings).toHaveLength(0);
    expect(h.leaseWarnings).toHaveLength(0);
  });

  it('★ 갱신 시점(50%)과 경보선(20%)은 다른 값이다 — 정상 갱신에 경보가 나지 않는다', async () => {
    const h = harness({ leaseSeconds: 4_000 });
    await h.websub.subscribe(CH);
    h.clock.advance(2_000_000); // 정확히 50% — 갱신은 일어나되 경보는 없다
    const out = await h.websub.sweep();
    expect(out.renewed).toBe(1);
    expect(out.warnings).toHaveLength(0);
  });
});

describe('AC-P7 — 갱신 연속 실패', () => {
  it('★★ 2회 연속 실패 → 경보 0건 / 3회째 → 정확히 1건', async () => {
    const h = harness();
    h.net.hubAccepts = false;

    // ★ 스윕 사이에 시계를 민다. 실패하면 재시도 백오프가 걸리므로 같은 순간에
    //   연달아 부르면 두 번째부터는 **시도 자체가 없다**(그래서 스트릭도 안 는다).
    //   실제로도 스윕은 5분 간격이고, 연속 실패는 시간에 걸쳐 쌓인다.
    await h.websub.sweep();
    h.clock.advance(30 * 60_000);
    await h.websub.sweep();
    expect(h.alerts).toHaveLength(0);

    h.clock.advance(60 * 60_000);
    await h.websub.sweep();
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({
      domain: 'websub-renew',
      kind: 'websub_lease',
      scopeKey: CH,
      value: 3,
      threshold: 3,
    });
  });

  it('★ 실패 사유가 DB 에 남는다 (재기동해도 읽을 수 있다)', async () => {
    const h = harness();
    h.net.hubAccepts = false;
    await h.websub.sweep();
    const detail = h.subs.get(CH)?.lastRenewError ?? '';
    expect(detail).toContain('http');
    expect(detail).toContain('허브가 거절했습니다');
  });

  it('★★ 중간에 1회 성공하면 스트릭이 리셋되고 사유도 지워진다', async () => {
    const h = harness();
    h.net.hubAccepts = false;
    await h.websub.sweep();
    h.clock.advance(30 * 60_000); // ★ 백오프를 넘긴다 (위 테스트 주석 참조)
    await h.websub.sweep();

    h.net.hubAccepts = true;
    h.clock.advance(60 * 60_000);
    await h.websub.sweep();
    expect(h.subs.get(CH)?.lastRenewError).toBeUndefined();
    expect(h.alerts).toHaveLength(0);

    // 리셋됐으므로 2회로는 다시 경보가 없다.
    h.net.hubAccepts = false;
    h.clock.advance(20 * 60_000);
    await h.websub.sweep();
    h.clock.advance(20 * 60_000);
    await h.websub.sweep();
    expect(h.alerts).toHaveLength(0);
  });

  it('★ RSS 실패가 websub-renew 스트릭을 오염시키지 않는다 (도메인 격리)', async () => {
    const h = harness();
    await h.seed();
    h.net.feeds.set(CH, undefined);
    for (let i = 0; i < 4; i++) await h.poller.pollOnce(CH);

    h.net.hubAccepts = false;
    await h.websub.sweep();
    // RSS 4 + 갱신 1 = 5 가 아니다. 두 도메인은 서로 격리된다.
    expect(h.alerts).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  구독 → 푸시 전 구간
// ══════════════════════════════════════════════════════════════════

describe('구독 → 검증 → 푸시 전 구간', () => {
  it('★ 구독하고 검증을 마친 뒤 푸시가 공지로 이어진다', async () => {
    const h = harness();
    await h.seed();

    const sub = await h.websub.subscribe(CH);
    expect(sub.ok).toBe(true);
    expect(h.subs.get(CH)?.expiresAt).toBeDefined();

    const res = await h.push(fixture('push-single.xml'));
    expect(res.status).toBe(202);
    expect(h.discord.sent).toHaveLength(1);
    expect(h.ledger.get('youtube_upload', 'PUSHVIDEO001')?.detectedVia).toBe('websub');
    expect(h.discord.sent[0]?.payload.embeds?.[0]?.footer?.text).toBe('감지: websub');
  });

  it('★ 시딩 전 채널에 푸시가 오면 공지하지 않고 선점만 한다 (AC-26)', async () => {
    const h = harness();
    await h.websub.subscribe(CH);
    await h.push(fixture('push-single.xml'));

    expect(h.discord.sent).toHaveLength(0);
    expect(h.ledger.get('youtube_upload', 'PUSHVIDEO001')?.seeded).toBe(true);
  });

  it('★ 깨진 푸시 본문에 500 을 내지 않는다', async () => {
    const h = harness();
    await h.seed();
    await h.websub.subscribe(CH);
    const res = await h.push(fixture('feed-broken.xml'));
    expect(res.status).toBe(202);
    expect(h.discord.sent).toHaveLength(0);
  });

  it('start() 가 구독과 주기 스윕을 건다', async () => {
    const h = harness();
    const first = await h.websub.start();
    expect(first.renewed).toBe(1);
    expect(h.net.hubRequests).toHaveLength(1);
    h.websub.stop();
    expect(h.clock.pending).toBe(0);
  });

  it('poller.start() 가 즉시 1회 돌고 타이머를 남긴다', async () => {
    const h = harness();
    h.net.feeds.set(CH, fixture('feed-15-seed.xml'));
    const first = await h.poller.start();
    expect(first).toHaveLength(1);
    expect(first[0]?.ok).toBe(true);
    expect(h.clock.pending).toBe(1);
    h.poller.stop();
    expect(h.clock.pending).toBe(0);
  });

  /**
   * ★★ 고정 간격 폴링이 상류의 스로틀링을 **스스로 연장하던** 문제 (실배포 2026-09-09).
   *
   *   초판은 `setInterval(pollAll, 60초)` 였다. 상류가 404 를 돌려주기 시작해도
   *   간격은 정확히 60초를 유지했고, 그날 320회 실패가 그 속도로 쌓였다.
   *   같은 시각 **다른 IP(휴대폰)에서는 같은 피드가 정상**이었고 제3자 채널까지
   *   같은 404 를 받았다 — 채널이 아니라 **우리 IP 가 걸린 것**이었다.
   *
   * ★ RSS 는 WebSub 이 죽었을 때의 유일한 폴백이라 상한(15분)이 필요하고,
   *   성공하면 **즉시** 기본 간격으로 돌아와야 한다.
   */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  };

  it('★ 연속 실패하면 폴 간격을 물린다 — 조여진 상류를 같은 속도로 때리지 않는다', async () => {
    const h = harness();
    h.net.feedStatus.set(CH, 404);
    await h.poller.start();
    expect(h.poller.failStreaks()[0]?.streak, '첫 폴이 실패로 세어지지 않았다').toBe(1);

    h.clock.advance(60_000);
    await flush();
    expect(h.poller.failStreaks()[0]?.streak, '60초 뒤 2회차가 돌지 않았다').toBe(2);

    // ★ 반공허 가드 — 여기가 백오프의 전부다. 없으면 60초에 또 돈다.
    h.clock.advance(60_000);
    await flush();
    expect(h.poller.failStreaks()[0]?.streak, '60초 만에 또 돌았다 — 백오프가 없다').toBe(2);

    h.clock.advance(60_000); // 2회차로부터 누적 120초
    await flush();
    expect(h.poller.failStreaks()[0]?.streak, '120초 뒤 3회차가 돌지 않았다').toBe(3);

    h.poller.stop();
  });

  it('★ 한 번이라도 성공하면 즉시 기본 간격으로 돌아온다 — 천천히 회복하지 않는다', async () => {
    const h = harness();
    h.net.feedStatus.set(CH, 404);
    await h.poller.start();
    h.clock.advance(60_000);
    await flush();
    expect(h.poller.failStreaks()[0]?.streak).toBe(2); // 다음은 120초 뒤

    // 상류가 회복된다
    h.net.feedStatus.delete(CH);
    h.net.feeds.set(CH, EMPTY_FEED);
    h.clock.advance(120_000);
    await flush();
    expect(h.poller.failStreaks()[0]?.streak, '성공이 연속 실패를 리셋하지 않았다').toBe(0);

    // ★ 이제 60초 만에 다시 돌아야 한다 — 120초로 남아 있으면 안 된다
    h.net.feedStatus.set(CH, 404);
    h.clock.advance(60_000);
    await flush();
    expect(h.poller.failStreaks()[0]?.streak, '성공 후에도 간격이 늘어난 채였다').toBe(1);

    h.poller.stop();
  });

  it('★★ 구독이 실패하면 재시도 간격이 벌어진다 — 재시도가 막힘을 유지시키지 않게', async () => {
    // 실측(2026-09-10)에서 이것이 없어 하루 414건이 나갔다. 상대는 우리 IP 를 이미
    // 간헐적으로 조이던 구글이라, 재시도가 막힌 상태를 **유지시키는 쪽**으로 일했다.
    const h = harness();
    h.net.hubAccepts = false;
    h.net.autoVerify = false;

    await h.websub.sweep();
    expect(h.net.hubRequests, '첫 시도가 나가지 않았다').toHaveLength(1);

    // 스윕 주기(300초)가 지나도 백오프(연속 1회 → 600초) 안이면 두드리지 않는다.
    h.clock.advance(300_000);
    await h.websub.sweep();
    expect(h.net.hubRequests, '백오프 중인데 또 두드렸다').toHaveLength(1);

    // 백오프가 지나면 다시 시도한다 — 영구히 멈추는 것이 아니다.
    h.clock.advance(301_000);
    await h.websub.sweep();
    expect(h.net.hubRequests, '백오프가 끝났는데 시도하지 않았다').toHaveLength(2);

    // ★ 허브가 회복되면 **즉시** 기본 리듬으로 돌아온다. 이 시점 연속 실패는 2회라
    //   백오프가 남아 있었다면 1200초 > 쿨다운 600초라 아래 시도가 일어나지 않는다.
    h.net.hubAccepts = true;
    h.clock.advance(1_201_000);
    await h.websub.sweep();
    expect(h.net.hubRequests).toHaveLength(3);

    h.clock.advance(RESUBSCRIBE_COOLDOWN_MS + 1_000);
    await h.websub.sweep();
    expect(h.net.hubRequests, '성공 후에도 백오프가 남아 있었다').toHaveLength(4);
  });
});
