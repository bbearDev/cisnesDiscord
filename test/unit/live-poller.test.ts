import { describe, it, expect, beforeEach } from 'vitest';

import { LiveApiResponseSchema, type LiveApiFailure } from '../../src/chzzk/live-api-schema.js';
import {
  selectChannel,
  type LiveApiClient,
  type LiveApiFetchResult,
} from '../../src/chzzk/live-api-client.js';
import type { LiveAnnounceJob, LiveLedger, LiveSessionStore } from '../../src/live/live-announce.js';
import {
  createLivePoller,
  readSeenUnknownChannels,
  UNKNOWN_CHANNELS_SEEN_KEY,
  type LivePollEvent,
  type LivePoller,
} from '../../src/live/live-poller.js';
import { buildSpecs, createStuckWatch, type StuckWatch } from '../../src/live/stuck-watch.js';
import { ManualClock } from '../../src/runtime/clock.js';
import type { RuntimeStateStore } from '../../src/runtime/liveness-stamp.js';
import { createFakeOpsAlerts, type FakeOpsAlerts } from '../helpers/ops-alerts.js';
import { loadJsonFixture } from '../e2e/harness/fake-chzzkbot.js';

/**
 * `GET /api/live` 폴러 (계획 §5.1 · §S5).
 *
 * ★ 이 파일이 세는 것은 세 가지다:
 *   ① **공지 건수** — DD-2(`live:true, confirmed:false` 5회 → 0건), 채널 필터
 *   ② **경보 건수** — AC-P1(5분 → 1건 / 4:59 → 0건), AC-P2(5회 연속 → 1건)
 *   ③ **평상시 무경보** — 세션 없는 채널 100회 폴 → 0건
 *
 * ★ 폴러는 스트릭을 스스로 세지 않는다. 여기서도 `stuck-watch` 실물을 꽂아
 *   **테스트가 세는 것과 운영이 보는 것이 같은 신호**가 되게 한다.
 */

const OURS = 'c3355ea2b3bea6c646789510796379d6';
const FOREIGN = '3594a5258433f765b6247dfe05e5fb33';
const POLL_MS = 3 * 60_000; // live.apiPollIntervalMin 기본 3분
const CONFIRMED_STUCK_MS = 5 * 60_000; // live.confirmedStuckMin 기본 5분
const POLL_FAIL_COUNT = 5; // live.pollFailThresholdCount 기본 5회

// ══════════════════════════════════════════════════════════════════
//  더블
// ══════════════════════════════════════════════════════════════════

function fromFixture(file: string): LiveApiFetchResult {
  const response = LiveApiResponseSchema.parse(loadJsonFixture(file));
  const { target, unknownChannelIds } = selectChannel(response, OURS);
  return { ok: true, response, target, unknownChannelIds };
}

/** 우리 채널 한 건만 담은 응답 — 낯선 채널 경보를 섞지 않고 판정만 보고 싶을 때 */
function soloIdle(): LiveApiFetchResult {
  const response = LiveApiResponseSchema.parse({
    version: 1,
    generatedAt: '2026-09-06T18:00:00.000Z',
    channels: [
      {
        channelId: OURS,
        channelName: '시스네',
        live: false,
        confirmed: false,
        exact: false,
        status: 'running',
        socketState: 'connected',
      },
    ],
  });
  const { target, unknownChannelIds } = selectChannel(response, OURS);
  return { ok: true, response, target, unknownChannelIds };
}

function failure(kind: LiveApiFailure): LiveApiFetchResult {
  return { ok: false, failure: kind };
}

interface ScriptedClient extends LiveApiClient {
  /** 다음 폴부터 이 결과를 준다 (다음 지정 전까지 계속) */
  set(result: LiveApiFetchResult): void;
  readonly calls: number;
}

function scriptedClient(initial: LiveApiFetchResult): ScriptedClient {
  let current = initial;
  let calls = 0;
  return {
    url: 'http://127.0.0.1:8080/api/live',
    set(r) {
      current = r;
    },
    get calls() {
      return calls;
    },
    fetch() {
      calls += 1;
      return Promise.resolve(current);
    },
  };
}

interface FakeLedger {
  repo: LiveLedger;
  readonly keys: readonly string[];
  failWith(error?: Error): void;
}

function fakeLedger(): FakeLedger {
  const keys: string[] = [];
  let boom: Error | undefined;
  return {
    repo: {
      claim(kind, eventKey) {
        if (boom !== undefined) throw boom;
        const k = `${kind} ${eventKey}`;
        if (keys.includes(k)) return false;
        keys.push(k);
        return true;
      },
    },
    get keys() {
      return keys;
    },
    failWith(error) {
      boom = error;
    },
  };
}

function fakeSessions(): LiveSessionStore & { readonly recorded: unknown[]; readonly closed: number } {
  const recorded: unknown[] = [];
  let closed = 0;
  return {
    record: (s) => {
      recorded.push(s);
    },
    closeOpen: () => {
      closed += 1;
      return 1;
    },
    get recorded() {
      return recorded;
    },
    get closed() {
      return closed;
    },
  };
}

// ══════════════════════════════════════════════════════════════════
//  조립
// ══════════════════════════════════════════════════════════════════

let clock: ManualClock;
let alerts: FakeOpsAlerts;
let stuckWatch: StuckWatch;
let ledger: FakeLedger;
let sessions: ReturnType<typeof fakeSessions>;
let announced: LiveAnnounceJob[];
let client: ScriptedClient;
let poller: LivePoller;

function build(initial: LiveApiFetchResult): void {
  clock = new ManualClock(1_000_000);
  alerts = createFakeOpsAlerts(OURS);
  stuckWatch = createStuckWatch({
    specs: buildSpecs({
      confirmedStuckMs: CONFIRMED_STUCK_MS,
      pollFailCount: POLL_FAIL_COUNT,
      rssFailCount: 5,
      renewFailCount: 3,
      followerStaleCount: 3,
    }),
  });
  ledger = fakeLedger();
  sessions = fakeSessions();
  announced = [];
  client = scriptedClient(initial);
  poller = createLivePoller({
    client,
    channelId: OURS,
    ledger: ledger.repo,
    sessions,
    announce: (job) => {
      announced.push(job);
      return Promise.resolve();
    },
    stuckWatch,
    alerts: alerts.service,
    clock,
    intervalMs: POLL_MS,
  });
}

beforeEach(() => {
  build(soloIdle());
});

// ══════════════════════════════════════════════════════════════════
//  판정별 처리
// ══════════════════════════════════════════════════════════════════

describe('announce — 공지 1건, 원장 1선점', () => {
  beforeEach(() => {
    build(fromFixture('chzzkbot/api-live-announce.json'));
  });

  it('★ detected_via=api-poll 로 선점하고 제목 없이 공지한다', async () => {
    const tick = await poller.poll();
    expect(tick.outcome).toBe('ran');
    expect(tick.announced).toBe(true);
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({ liveHash: 'df09256e', detectedVia: 'api-poll' });
    // 폴링 응답에는 liveTitle 칸이 없다 — 제목 없는 문안이 쓰인다.
    expect(announced[0]!.embed.title).toBe('시스네 방송이 시작되었습니다');
    expect(announced[0]!.embed.timestamp).toBe('2026-09-06T18:56:39.000Z');
  });

  it('★ 같은 방송을 10회 폴링해도 공지는 1건이다 (원장이 막는다)', async () => {
    for (let i = 0; i < 10; i++) {
      clock.advance(POLL_MS);
      await poller.poll();
    }
    expect(announced).toHaveLength(1);
    expect(ledger.keys).toEqual(['live_start df09256e']);
  });

  it('★ seeded 를 세우지 않는다 (rev.4 B-1 — 세우면 이후 claim 이 반드시 실패한다)', async () => {
    const seen: unknown[] = [];
    build(fromFixture('chzzkbot/api-live-announce.json'));
    const spy: LiveLedger = {
      claim: (kind, key, _at, via, opts) => {
        seen.push({ kind, key, via, opts });
        return true;
      },
    };
    poller = createLivePoller({
      client,
      channelId: OURS,
      ledger: spy,
      sessions,
      announce: (job) => {
        announced.push(job);
        return Promise.resolve();
      },
      stuckWatch,
      alerts: alerts.service,
      clock,
      intervalMs: POLL_MS,
    });
    await poller.poll();
    expect(seen).toEqual([
      { kind: 'live_start', key: 'df09256e', via: 'api-poll', opts: undefined },
    ]);
  });

  it('원장 쓰기가 실패하면 공지하지 않는다 (선점 없는 발송은 중복을 만든다)', async () => {
    ledger.failWith(new Error('database is locked'));
    const tick = await poller.poll();
    expect(tick.announced).toBe(false);
    expect(announced).toHaveLength(0);
  });

  it('세션 저장이 실패해도 공지는 나간다', async () => {
    sessions.record = () => {
      throw new Error('disk full');
    };
    await poller.poll();
    expect(announced).toHaveLength(1);
  });

  it('AC-P6 감시에 선점 사실을 알린다', async () => {
    const claims: string[] = [];
    build(fromFixture('chzzkbot/api-live-announce.json'));
    poller = createLivePoller({
      client,
      channelId: OURS,
      ledger: ledger.repo,
      sessions,
      announce: () => Promise.resolve(),
      stuckWatch,
      alerts: alerts.service,
      clock,
      intervalMs: POLL_MS,
      silenceWatch: {
        noteClaim: (h) => claims.push(h),
      },
    });
    await poller.poll();
    expect(claims).toEqual(['df09256e']);
  });
});

describe('ended — 상태만 갱신하고 공지하지 않는다', () => {
  it('★ 종료 공지를 만들지 않는다 (스펙에 종료 AC 가 없다)', async () => {
    build(soloIdle());
    const tick = await poller.poll();
    expect(tick.judgment?.state).toBe('ended');
    expect(announced).toHaveLength(0);
    expect(sessions.closed).toBe(1);
  });
});

describe('unknown — 아무것도 하지 않는다', () => {
  it('★★ DD-2 — live:true, confirmed:false 를 5회 연속 받아도 공지 0건', async () => {
    build(fromFixture('chzzkbot/api-live-unconfirmed.json'));
    for (let i = 0; i < 5; i++) {
      await poller.poll();
      clock.advance(POLL_MS);
    }
    expect(announced).toHaveLength(0);
    expect(ledger.keys).toEqual([]);
  });

  it('status:starting 에서는 상태를 갱신하지도 공지하지도 않는다', async () => {
    build(fromFixture('chzzkbot/api-live-status-starting.json'));
    const tick = await poller.poll();
    expect(tick.judgment).toMatchObject({ state: 'unknown', reason: 'status-not-running' });
    expect(announced).toHaveLength(0);
    expect(sessions.closed).toBe(0);
  });

  it.each<LiveApiFailure>(['timeout', 'network', 'budget', 'http', 'bad-body', 'schema'])(
    '조회 실패(%s)에서 공지도 상태 갱신도 하지 않는다',
    async (kind) => {
      build(failure(kind));
      const tick = await poller.poll();
      expect(tick.judgment?.state).toBe('unknown');
      expect(announced).toHaveLength(0);
      expect(sessions.closed).toBe(0);
    },
  );
});

// ══════════════════════════════════════════════════════════════════
//  ★ 채널 필터 (§5.1 rev.5 실측 2채널)
// ══════════════════════════════════════════════════════════════════

describe('★★ 채널 필터 — 남의 방송을 우리 서버에 공지하지 않는다', () => {
  it('아이곰만 방송 중인 응답에서 공지 0건, 우리 판정은 ended', async () => {
    build(fromFixture('chzzkbot/api-live-foreign-channel-live.json'));
    const tick = await poller.poll();
    expect(announced).toHaveLength(0);
    expect(tick.judgment?.state).toBe('ended');
  });

  it('★ 설정에 없는 채널을 처음 보면 unknown_channel 경보 1건 — 그 뒤로는 도배하지 않는다', async () => {
    build(fromFixture('chzzkbot/api-live-2channels-idle.json'));
    for (let i = 0; i < 20; i++) {
      await poller.poll();
      clock.advance(POLL_MS);
    }
    expect(alerts.countOf('unknown_channel')).toBe(1);
    expect(alerts.raised[0]!.message).toContain(FOREIGN);
  });

  /**
   * ★★ 재기동을 넘어 한 번만 — 메모리에만 두면 배포마다 아이곰으로 울린다 (운영 관측 2026-09-12).
   *
   * 같은 `RuntimeStateStore` 로 폴러를 다시 만드는 것이 곧 재기동이다.
   */
  describe('★★ unknown_channel 은 재기동을 넘어 한 번만 — runtime_state 가 기억한다', () => {
    function memoryStore(): RuntimeStateStore & { rows: Map<string, string> } {
      const rows = new Map<string, string>();
      return {
        rows,
        get: (k) => rows.get(k),
        set: (k, v) => {
          rows.set(k, v);
        },
      };
    }

    /** `build()` 와 같은 폴러를 저장소·이벤트 수집기만 더해 만든다 */
    function boot(store: RuntimeStateStore, initial: LiveApiFetchResult): { p: LivePoller; events: LivePollEvent[] } {
      build(initial);
      const events: LivePollEvent[] = [];
      const p = createLivePoller({
        client,
        channelId: OURS,
        ledger: ledger.repo,
        sessions,
        announce: () => Promise.resolve(),
        stuckWatch,
        alerts: alerts.service,
        clock,
        intervalMs: POLL_MS,
        unknownChannelMemory: store,
        onEvent: (e) => events.push(e),
      });
      return { p, events };
    }

    it('첫 기동: 경보 1건 + 이벤트 1건, 목록이 저장된다', async () => {
      const store = memoryStore();
      const { p, events } = boot(store, fromFixture('chzzkbot/api-live-2channels-idle.json'));
      await p.poll();
      await p.poll();
      expect(alerts.countOf('unknown_channel')).toBe(1);
      expect(events.filter((e) => e.type === 'unknown-channel')).toHaveLength(1);
      expect(readSeenUnknownChannels(store)).toEqual([FOREIGN]);
    });

    it('★★ 재기동: 경보 0건 — 그러나 이벤트는 다시 1건 (AD-1 보호 목록은 프로세스마다 채워야 한다)', async () => {
      const store = memoryStore();
      const first = boot(store, fromFixture('chzzkbot/api-live-2channels-idle.json'));
      await first.p.poll();
      expect(alerts.countOf('unknown_channel')).toBe(1);

      // 재기동 — 새 프로세스, 같은 DB
      const second = boot(store, fromFixture('chzzkbot/api-live-2channels-idle.json'));
      for (let i = 0; i < 5; i++) await second.p.poll();
      expect(alerts.countOf('unknown_channel')).toBe(0); // build() 가 alerts 를 새로 만들었다
      const evs = second.events.filter((e) => e.type === 'unknown-channel');
      expect(evs).toHaveLength(1);
      expect(evs[0]?.channelIds).toEqual([FOREIGN]);
    });

    it('★ 재기동 뒤 정말 새 채널이 나타나면 그 채널로만 경보한다', async () => {
      const store = memoryStore();
      store.set(UNKNOWN_CHANNELS_SEEN_KEY, JSON.stringify([FOREIGN]), '');
      const response = LiveApiResponseSchema.parse(loadJsonFixture('chzzkbot/api-live-2channels-idle.json'));
      const NEWCOMER = 'ffff0000ffff0000ffff0000ffff0000';
      const { p } = boot(store, {
        ok: true,
        response,
        target: response.channels.find((c) => c.channelId === OURS),
        unknownChannelIds: [FOREIGN, NEWCOMER],
      });
      await p.poll();
      expect(alerts.countOf('unknown_channel')).toBe(1);
      expect(alerts.raised[0]!.message).toContain(NEWCOMER);
      expect(alerts.raised[0]!.message).not.toContain(FOREIGN);
      expect(readSeenUnknownChannels(store)).toEqual([NEWCOMER, FOREIGN].sort());
    });

    it('저장값이 깨졌으면 빈 목록으로 본다 — 한 번 더 울릴 뿐 폴링은 산다', async () => {
      const store = memoryStore();
      store.set(UNKNOWN_CHANNELS_SEEN_KEY, '{oops', '');
      expect(readSeenUnknownChannels(store)).toEqual([]);
      store.set(UNKNOWN_CHANNELS_SEEN_KEY, JSON.stringify([1, '', 'x']), '');
      expect(readSeenUnknownChannels(store)).toEqual(['x']);
      const { p } = boot(store, fromFixture('chzzkbot/api-live-2channels-idle.json'));
      await p.poll();
      expect(alerts.countOf('unknown_channel')).toBe(1);
    });

    it('저장이 실패해도 폴링은 산다', async () => {
      const store = memoryStore();
      store.set = () => {
        throw new Error('disk full');
      };
      const { p } = boot(store, fromFixture('chzzkbot/api-live-2channels-idle.json'));
      const tick = await p.poll();
      expect(tick.outcome).toBe('ran');
      expect(alerts.countOf('unknown_channel')).toBe(1);
    });

    it('저장소를 주지 않으면 예전처럼 메모리만 — 재기동마다 다시 울린다', async () => {
      build(fromFixture('chzzkbot/api-live-2channels-idle.json'));
      await poller.poll();
      expect(alerts.countOf('unknown_channel')).toBe(1);
      build(fromFixture('chzzkbot/api-live-2channels-idle.json'));
      await poller.poll();
      expect(alerts.countOf('unknown_channel')).toBe(1);
    });
  });

  it('우리 채널만 판정한다 — 남의 채널은 announce 여도 우리 결론을 바꾸지 않는다', async () => {
    build(fromFixture('chzzkbot/api-live-foreign-channel-live.json'));
    await poller.poll();
    // 아이곰 행은 3상태식으로 announce 지만(live-state.test.ts 가 확인) 우리는 안 본다.
    expect(ledger.keys).toEqual([]);
  });

  it('응답에 우리 채널이 아예 없으면 unknown 이다 (ended 로 접지 않는다)', async () => {
    const response = LiveApiResponseSchema.parse(
      loadJsonFixture('chzzkbot/api-live-foreign-channel-live.json'),
    );
    const only = { ...response, channels: response.channels.filter((c) => c.channelId !== OURS) };
    build({ ok: true, response: only, target: undefined, unknownChannelIds: [FOREIGN] });
    const tick = await poller.poll();
    expect(tick.judgment).toMatchObject({ state: 'unknown', reason: 'channel-missing' });
    expect(sessions.closed).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  ★ 경보 (AC-P1 · AC-P2)
// ══════════════════════════════════════════════════════════════════

describe('★★ AC-P1 — confirmed 고착 (지속시간 판정)', () => {
  it('5분 지속 → 경보 정확히 1건', async () => {
    build(fromFixture('chzzkbot/api-live-unconfirmed.json'));
    await poller.poll(); // t=0 고착 시작
    clock.advance(CONFIRMED_STUCK_MS);
    await poller.poll(); // t=5분
    expect(alerts.countOf('confirmed_stuck')).toBe(1);
  });

  it('★ 4분 59초에서는 0건 (정상 창은 14초 + 스캔 수십 초라 오탐이 없다)', async () => {
    build(fromFixture('chzzkbot/api-live-unconfirmed.json'));
    await poller.poll();
    clock.advance(CONFIRMED_STUCK_MS - 1_000);
    await poller.poll();
    expect(alerts.countOf('confirmed_stuck')).toBe(0);
  });

  it('임계를 넘긴 뒤 계속 고착이어도 도배하지 않는다 (에피소드당 1건)', async () => {
    build(fromFixture('chzzkbot/api-live-unconfirmed.json'));
    for (let i = 0; i < 10; i++) {
      await poller.poll();
      clock.advance(CONFIRMED_STUCK_MS);
    }
    expect(alerts.countOf('confirmed_stuck')).toBe(1);
  });

  it('중간에 announce 가 오면 고착 카운터가 리셋된다', async () => {
    build(fromFixture('chzzkbot/api-live-unconfirmed.json'));
    await poller.poll();
    clock.advance(CONFIRMED_STUCK_MS - 1_000);
    client.set(fromFixture('chzzkbot/api-live-announce.json'));
    await poller.poll();
    client.set(fromFixture('chzzkbot/api-live-unconfirmed.json'));
    clock.advance(2_000);
    await poller.poll();
    expect(alerts.countOf('confirmed_stuck')).toBe(0);
  });

  it('★ 조회가 실패한 틱은 고착 시계를 리셋하지 않는다 (관측 없음 ≠ 정상)', async () => {
    build(fromFixture('chzzkbot/api-live-unconfirmed.json'));
    await poller.poll(); // 고착 시작

    clock.advance(CONFIRMED_STUCK_MS / 2);
    client.set(failure('timeout'));
    await poller.poll(); // 못 봤다 — 리셋하면 안 된다

    clock.advance(CONFIRMED_STUCK_MS / 2);
    client.set(fromFixture('chzzkbot/api-live-unconfirmed.json'));
    await poller.poll();
    expect(alerts.countOf('confirmed_stuck')).toBe(1);
  });

  it('경보 문구에 지속 시간과 chzzkbot 로그 확인 명령이 실린다', async () => {
    build(fromFixture('chzzkbot/api-live-unconfirmed.json'));
    await poller.poll();
    clock.advance(CONFIRMED_STUCK_MS);
    await poller.poll();
    const msg = alerts.raised.find((r) => r.kind === 'confirmed_stuck')!.message;
    expect(msg).toContain('5분');
    expect(msg).toContain('방송을 인식했습니다');
  });
});

describe('★★ AC-P2 — unknown 연속 (연속횟수 판정)', () => {
  it('5회 연속 → 경보 1건', async () => {
    build(failure('timeout'));
    for (let i = 0; i < POLL_FAIL_COUNT; i++) {
      await poller.poll();
      clock.advance(POLL_MS);
    }
    expect(alerts.countOf('live_api_unknown')).toBe(1);
  });

  it('4회에서는 0건', async () => {
    build(failure('timeout'));
    for (let i = 0; i < POLL_FAIL_COUNT - 1; i++) {
      await poller.poll();
      clock.advance(POLL_MS);
    }
    expect(alerts.countOf('live_api_unknown')).toBe(0);
  });

  it('★ 중간에 announce 가 한 번 오면 카운터가 리셋된다', async () => {
    build(failure('timeout'));
    for (let i = 0; i < 4; i++) {
      await poller.poll();
      clock.advance(POLL_MS);
    }
    client.set(fromFixture('chzzkbot/api-live-announce.json'));
    await poller.poll();
    expect(alerts.countOf('live_api_unknown')).toBe(0);

    client.set(failure('timeout'));
    for (let i = 0; i < 4; i++) {
      clock.advance(POLL_MS);
      await poller.poll();
    }
    expect(alerts.countOf('live_api_unknown')).toBe(0);

    clock.advance(POLL_MS);
    await poller.poll();
    expect(alerts.countOf('live_api_unknown')).toBe(1);
  });

  it('★ ended 도 성공한 관측이라 카운터를 리셋한다', async () => {
    build(failure('timeout'));
    for (let i = 0; i < 4; i++) {
      await poller.poll();
      clock.advance(POLL_MS);
    }
    client.set(soloIdle());
    await poller.poll();
    client.set(failure('timeout'));
    for (let i = 0; i < 4; i++) {
      clock.advance(POLL_MS);
      await poller.poll();
    }
    expect(alerts.countOf('live_api_unknown')).toBe(0);
  });

  it('임계를 넘긴 뒤에도 에피소드당 1건이다', async () => {
    build(failure('network'));
    for (let i = 0; i < 30; i++) {
      await poller.poll();
      clock.advance(POLL_MS);
    }
    expect(alerts.countOf('live_api_unknown')).toBe(1);
  });
});

describe('★★ 평상시 무경보 — 세션 없는 채널', () => {
  it('live:false, confirmed:false, status:running 을 100회 폴링해도 경보 0건', async () => {
    build(soloIdle());
    for (let i = 0; i < 100; i++) {
      await poller.poll();
      clock.advance(POLL_MS);
    }
    // 하루 대부분이 이 상태다. 여기서 울면 경보 채널이 통째로 쓸모없어진다.
    expect(alerts.raised).toEqual([]);
    expect(announced).toHaveLength(0);
    expect(client.calls).toBe(100);
  });
});

// ══════════════════════════════════════════════════════════════════
//  루프 규율
// ══════════════════════════════════════════════════════════════════

describe('폴 루프', () => {
  it('★ 재진입 가드 — 앞 바퀴가 도는 중이면 새로 시작하지 않는다', async () => {
    build(soloIdle());
    let release: (() => void) | undefined;
    client.fetch = () =>
      new Promise<LiveApiFetchResult>((resolve) => {
        release = (): void => {
          resolve(soloIdle());
        };
      });

    const first = poller.poll();
    const second = await poller.poll();
    expect(second.outcome).toBe('skipped');
    release?.();
    expect((await first).outcome).toBe('ran');
  });

  it('start 는 즉시 1회 돌고 그 뒤 주기마다 돈다 (AC-29 기동 복구)', async () => {
    // 폴 한 바퀴는 여러 마이크로태스크를 지난다. 큐를 비워야 그 바퀴가 끝난다.
    const flush = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

    build(soloIdle());
    poller.start();
    await flush();
    // 기동 직후 1회 — 꺼져 있던 동안 시작된 방송을 여기서 잡는다.
    expect(client.calls).toBe(1);

    for (let i = 0; i < 3; i++) {
      clock.advance(POLL_MS);
      await flush();
    }
    expect(client.calls).toBe(4);
    poller.dispose();
  });

  it('dispose 뒤에는 타이머가 남지 않고 폴도 돌지 않는다', async () => {
    build(soloIdle());
    poller.start();
    poller.dispose();
    expect(clock.pending).toBe(0);
    expect((await poller.poll()).outcome).toBe('disposed');
  });
});
