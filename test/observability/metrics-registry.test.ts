import { describe, expect, it } from 'vitest';

import {
  AIGOM,
  GUILD,
  SIS,
  YT_CHANNEL,
  boot,
  type Harness,
} from '../helpers/app-harness.js';
import { CHZZKBOT_WEBHOOK_PATH } from '../../src/web/routes/chzzkbot-webhook.js';
import { createWebSubSubRepo } from '../../src/store/repos/websub-sub-repo.js';
import { createYoutubeChannelRepo } from '../../src/store/repos/youtube-channel-repo.js';
import {
  METRIC_NAMES,
  METRIC_SPECS,
  SAMPLE_CAPACITY,
  createMetricsRegistry,
  type CounterSample,
  type DurationSample,
  type GaugeSample,
  type MetricName,
  type MetricsRegistry,
} from '../../src/runtime/metrics.js';

/**
 * §9.4 지표 레지스트리 — **이름마다 "그 사건이 나면 숫자가 움직이는가" 를 본다.**
 *
 * ## 왜 존재 확인으로는 부족한가
 *
 * 배선이 빠진 지표는 **언제나 0** 이고, 0 은 *"아무 일도 없었다"* 와 구분되지
 * 않는다. 그래서 `snapshot()` 에 칸이 있다는 것만 보면 **배선 없이도 통과한다** —
 * 그게 §9.4 가 막으려는 실패의 정확한 모양이다.
 *
 * ★★ 그래서 이 파일의 모든 단언은 **배선을 지우면 빨개져야 한다.**
 *   그것을 못 지키는 단언(사건을 일으키지 않고 0을 확인하는 것)은 여기 두지 않는다.
 *
 * ★ 두 종류의 지표가 있고 몰아가는 방법이 다르다 (`runtime/metrics.ts` 의
 *   `METRIC_SPECS`).
 *
 *   - `source: 'local'`  — 레지스트리가 직접 센다. **실제 사건**(웹훅 수신 · 폴 ·
 *     선점 · 발송 실패)을 일으켜 확인한다.
 *   - `source: 'reader'` — 값이 다른 모듈 안에 산다. 그 모듈의 **공개 API 로**
 *     값을 움직인 뒤 스냅샷이 따라오는지 본다. 읽기 함수를 빼면 빨개진다.
 *     (그 모듈 자신의 계수 규칙은 각자의 테스트가 이미 고정한다.)
 */

// ══════════════════════════════════════════════════════════════════
//  도우미
// ══════════════════════════════════════════════════════════════════

function sampleOf(registry: MetricsRegistry, name: MetricName) {
  return registry.snapshot()[name];
}

function counterOf(registry: MetricsRegistry, name: MetricName): CounterSample {
  const s = sampleOf(registry, name);
  if (s.kind !== 'counter') throw new Error(`${name} 는 counter 가 아니다`);
  return s;
}

function gaugeOf(registry: MetricsRegistry, name: MetricName): GaugeSample {
  const s = sampleOf(registry, name);
  if (s.kind !== 'gauge') throw new Error(`${name} 는 gauge 가 아니다`);
  return s;
}

function durationOf(registry: MetricsRegistry, name: MetricName): DurationSample {
  const s = sampleOf(registry, name);
  if (s.kind !== 'duration') throw new Error(`${name} 는 duration 이 아니다`);
  return s;
}

/**
 * 조건이 설 때까지 기다린다.
 *
 * ★ 웹훅 라우트는 2xx 를 **먼저** 돌려주고 발송은 비동기로 나간다(§S5). 그래서
 *   `live_webhook_to_post_ms` 는 응답 직후에는 아직 없다 — 그 비동기가 끝나야
 *   생긴다. 배선이 없으면 여기서 시간 초과로 **실패한다.**
 */
async function waitFor(pred: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`조건이 성립하지 않았습니다: ${label}`);
}

/**
 * ★ `RequestInfo` 는 브라우저 lib 의 이름이라 여기(ES2023 + @types/node)에는 없다.
 *   `fetch` 자신의 시그니처에서 뜨면 런타임이 바뀌어도 갈리지 않는다.
 */
type FetchTarget = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function targetUrl(input: FetchTarget): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

const IDLE = 'chzzkbot/api-live-2channels-idle.json';
const ANNOUNCE = 'chzzkbot/api-live-announce.json';
const UNCONFIRMED = 'chzzkbot/api-live-unconfirmed.json';
/** `api-live-announce.json` 이 싣고 있는 값. 웹훅과 폴링이 같은 방송을 가리켜야 한다 */
const LIVE_HASH = 'df09256e';

function webhookBody(openedAt: string): {
  event: 'live.started';
  version: number;
  channelId: string;
  channelName: string;
  openDate: string;
  openedAt: string;
  liveHash: string;
  liveTitle: string;
  detectedAt: string;
} {
  return {
    event: 'live.started',
    version: 1,
    channelId: SIS,
    channelName: '시스네',
    openDate: '2026-09-07 03:56:39',
    openedAt,
    liveHash: LIVE_HASH,
    liveTitle: '오늘은 잡담방송',
    detectedAt: openedAt,
  };
}

function post(h: Harness, openedAt: string): Promise<{ status: number }> {
  return h.upstream.postLiveStarted(
    `${h.app.baseUrl}${CHZZKBOT_WEBHOOK_PATH}`,
    webhookBody(openedAt),
    { token: h.app.config.secrets.LIVE_EVENT_WEBHOOK_TOKEN },
  );
}

// ══════════════════════════════════════════════════════════════════
//  표 자체
// ══════════════════════════════════════════════════════════════════

describe('§9.4 — 표가 코드로 존재한다', () => {
  it('★ 스냅샷이 §9.4 이름을 하나도 빠짐없이 담는다', async () => {
    const { app } = await boot();
    // 이름 하나가 빠지면 그 지표는 **물어볼 방법 자체가 없다.**
    expect(Object.keys(app.metricsRegistry.snapshot()).sort()).toEqual([...METRIC_NAMES].sort());
  });

  it('★★ 읽기 함수가 빠진 §9.4 지표가 없다 — 배선 누락은 영원한 0 으로 숨는다', async () => {
    const { app } = await boot();
    expect(app.metricsRegistry.unwired()).toEqual([]);
  });

  it('종류·출처 표가 이름 목록과 정확히 같은 키를 갖는다', () => {
    expect(Object.keys(METRIC_SPECS).sort()).toEqual([...METRIC_NAMES].sort());
  });
});

// ══════════════════════════════════════════════════════════════════
//  local — 웹훅 경로 (AC-15 의 판정 축)
// ══════════════════════════════════════════════════════════════════

describe('§9.4 — 웹훅 수신 → 게시', () => {
  it('★★ live_webhook_to_post_ms · live_opened_to_post_ms · live_webhook_ack_ms · live_detected_via{webhook}', async () => {
    const h = await boot((u) => {
      u.loadLiveFixture(IDLE);
    });
    const { app, clock } = h;

    // ★ 이 지표들이 전부 0 인 상태에서 출발한다는 것을 못 박는다 — 그래야
    //   아래 단언이 "움직였다" 를 말한다.
    expect(durationOf(app.metricsRegistry, 'live_webhook_to_post_ms').count).toBe(0);
    expect(durationOf(app.metricsRegistry, 'live_webhook_ack_ms').count).toBe(0);

    // 방송이 1분 전에 열렸다고 말하는 페이로드. `openedAt` 기준 총 지연이 그만큼이다.
    const openedAt = new Date(clock.now() - 60_000).toISOString();
    const res = await post(h, openedAt);
    expect(res.status).toBe(202);

    // 2xx 는 이미 돌아왔다 — 응답 시간은 그 순간 기록된다.
    expect(durationOf(app.metricsRegistry, 'live_webhook_ack_ms').count).toBe(1);

    await waitFor(
      () => durationOf(app.metricsRegistry, 'live_webhook_to_post_ms').count === 1,
      'live_webhook_to_post_ms (AC-15 의 판정 축)',
    );

    const toPost = durationOf(app.metricsRegistry, 'live_webhook_to_post_ms');
    expect(toPost.lastMs).toBeGreaterThanOrEqual(0);
    // 표본이 하나뿐이면 p95 는 그 값이다 — 버퍼가 실제로 채워졌다는 증거다.
    expect(toPost.p95Ms).toBe(toPost.lastMs);

    // ★ `openedAt` 기준은 **다른 축**이다. 웹훅 수신 기준과 값이 같으면
    //   둘 중 하나가 잘못된 시작점을 쓰고 있다는 뜻이다.
    const opened = durationOf(app.metricsRegistry, 'live_opened_to_post_ms');
    expect(opened.count).toBe(1);
    expect(opened.lastMs).toBeGreaterThan(50_000);
    expect(opened.lastMs).toBeLessThan(70_000);

    // 감지 경로가 라벨로 갈린다 — `api-poll` 비율 상승이 웹훅 고장 신호다
    expect(counterOf(app.metricsRegistry, 'live_detected_via').byLabel.webhook).toBe(1);
  });

  it('★ 2xx 가 아닌 응답은 ack 분포에 섞이지 않는다 (여유 계산이 짧은 쪽으로 왜곡된다)', async () => {
    const h = await boot((u) => {
      u.loadLiveFixture(IDLE);
    });
    const { app } = h;

    // 토큰이 틀린 요청 — 401 이고 chzzkbot 은 재시도하지 않는다
    const bad = await h.upstream.postLiveStarted(
      `${app.baseUrl}${CHZZKBOT_WEBHOOK_PATH}`,
      webhookBody(new Date().toISOString()),
      { token: 'z'.repeat(48) },
    );
    expect(bad.status).toBe(401);
    expect(durationOf(app.metricsRegistry, 'live_webhook_ack_ms').count).toBe(0);

    // 같은 하니스에서 정상 요청 하나 — 그때는 센다
    await post(h, new Date().toISOString());
    expect(durationOf(app.metricsRegistry, 'live_webhook_ack_ms').count).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════
//  local — 판정 분포
// ══════════════════════════════════════════════════════════════════

describe('§9.4 — live_state_verdict · live_detected_via{api-poll}', () => {
  it('★★ 세 판정이 라벨별로 쌓이고, 폴링 선점이 `api-poll` 로 기록된다', async () => {
    const { app, upstream } = await boot((u) => {
      u.loadLiveFixture(IDLE);
    });

    // 기동 복구가 `ended` 를 한 번 세었다(§S7). 복구를 빼면 "기동마다 unknown 인데
    // 분포에는 안 보인다" 가 되므로 여기서 함께 못 박는다.
    expect(counterOf(app.metricsRegistry, 'live_state_verdict').byLabel.ended).toBe(1);

    await app.livePoller.poll(); // ended 2

    upstream.setStatus(500);
    await app.livePoller.poll(); // unknown 1

    upstream.setStatus(undefined);
    upstream.loadLiveFixture(ANNOUNCE);
    await app.livePoller.poll(); // announce 1 + 원장 선점

    const verdict = counterOf(app.metricsRegistry, 'live_state_verdict');
    expect(verdict.byLabel).toEqual({ ended: 2, unknown: 1, announce: 1 });
    expect(verdict.total).toBe(4);

    expect(counterOf(app.metricsRegistry, 'live_detected_via').byLabel['api-poll']).toBe(1);
  });

  it('★ live_unconfirmed_observed — `confirmed:false` 를 본 횟수. **0 이면 S1-C 관측과 모순이다**', async () => {
    const { app } = await boot((u) => {
      u.loadLiveFixture(UNCONFIRMED);
    });

    // 기동 복구가 이미 한 번 봤다 — `live && !confirmed` 는 unknown 이다
    expect(counterOf(app.metricsRegistry, 'live_unconfirmed_observed').total).toBe(1);
    await app.livePoller.poll();
    expect(counterOf(app.metricsRegistry, 'live_unconfirmed_observed').total).toBe(2);
    expect(counterOf(app.metricsRegistry, 'live_state_verdict').byLabel.unknown).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════════
//  local — 원장 · 발송
// ══════════════════════════════════════════════════════════════════

describe('§9.4 — 원장 · 디스코드', () => {
  it('★★ announcement_claim_conflicts — 원장이 막은 수. **0 이 아니어야 정상이다**', async () => {
    const { app } = await boot();
    const at = new Date().toISOString();

    expect(app.ledger.claim('youtube_upload', 'vid-1', at, 'websub')).toBe(true);
    // 선점 성공은 감지 경로 라벨로 남는다 — RSS 비율이 곧 WebSub 건강도다
    expect(counterOf(app.metricsRegistry, 'youtube_detected_via').byLabel.websub).toBe(1);
    expect(counterOf(app.metricsRegistry, 'announcement_claim_conflicts').total).toBe(0);

    // 두 번째는 막힌다. 이 숫자가 계속 0 이면 "중복이 없었다" 가 아니라
    // **원장이 일했다는 증거가 없다** 는 뜻이다.
    expect(app.ledger.claim('youtube_upload', 'vid-1', at, 'rss')).toBe(false);
    const conflicts = counterOf(app.metricsRegistry, 'announcement_claim_conflicts');
    expect(conflicts.total).toBe(1);
    expect(conflicts.byLabel.youtube_upload).toBe(1);
    // 막힌 시도는 감지 경로로 세지 않는다 — 그 공지는 나가지 않았다
    expect(counterOf(app.metricsRegistry, 'youtube_detected_via').byLabel.rss).toBeUndefined();
  });

  it('★ discord_send_failures — 재시도를 소진한 최종 실패만 센다 (AC-19)', async () => {
    const { app, upstream, fake } = await boot((u) => {
      u.loadLiveFixture(IDLE);
    });
    expect(counterOf(app.metricsRegistry, 'discord_send_failures').total).toBe(0);

    // 403 은 재시도하지 않는다(권한은 4초 안에 생기지 않는다) — 한 번에 최종 실패다
    fake.failAlways({ kind: 'forbidden' });
    upstream.loadLiveFixture(ANNOUNCE);
    await app.livePoller.poll();

    const failures = counterOf(app.metricsRegistry, 'discord_send_failures');
    expect(failures.total).toBe(1);
    expect(failures.byLabel.forbidden).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════
//  local — AC-P6
// ══════════════════════════════════════════════════════════════════

describe('§9.4 — live_webhook_silence_sec (AC-P6 의 판정 축)', () => {
  it('★★ 폴링이 먼저 선점하고 나중에 웹훅이 오면, 그 간격이 초로 남는다', async () => {
    const h = await boot((u) => {
      u.loadLiveFixture(IDLE);
    });
    const { app, upstream, clock } = h;

    upstream.loadLiveFixture(ANNOUNCE);
    await app.livePoller.poll();
    // 폴링이 선점했다 → 유예창이 걸렸다. 아직 짝이 없으니 값도 없다.
    expect(app.silenceWatch.armed).toBe(1);
    expect(gaugeOf(app.metricsRegistry, 'live_webhook_silence_sec').value).toBeUndefined();

    clock.advance(120_000);
    const res = await post(h, new Date(clock.now()).toISOString());
    // 폴링이 이미 집었으므로 웹훅은 중복이다 — 그래도 **도착 사실**은 기록된다
    expect(res.status).toBe(200);

    expect(gaugeOf(app.metricsRegistry, 'live_webhook_silence_sec').value).toBe(120);
    // 같은 시나리오가 원장 중복 차단도 한 건 만든다
    expect(counterOf(app.metricsRegistry, 'announcement_claim_conflicts').byLabel.live_start).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════
//  reader — 스트릭 게이지
// ══════════════════════════════════════════════════════════════════

describe('§9.4 — stuck-watch 에 사는 값들', () => {
  it('★ live_api_unknown_streak — 조회 실패가 쌓이면 게이지가 따라 오른다', async () => {
    const { app } = await boot((u) => {
      u.setStatus(500);
    });
    // 기동 복구가 1회차를 세었다(§S7)
    expect(gaugeOf(app.metricsRegistry, 'live_api_unknown_streak').value).toBe(1);
    await app.livePoller.poll();
    expect(gaugeOf(app.metricsRegistry, 'live_api_unknown_streak').value).toBe(2);
  });

  it('★★ live_unconfirmed_duration_sec — **밀리초가 아니라 초다**', async () => {
    const { app, clock } = await boot((u) => {
      u.loadLiveFixture(UNCONFIRMED);
    });

    await app.livePoller.poll(); // 고착 에피소드 시작
    clock.advance(180_000);
    await app.livePoller.poll();

    // ★ 이름이 `_sec` 인데 값이 ms 면 AC-P1 임계를 1000배 틀리게 읽는다.
    //   `stuck-watch` 는 duration 도메인을 ms 로 세므로 여기서 접혀야 한다.
    expect(gaugeOf(app.metricsRegistry, 'live_unconfirmed_duration_sec').value).toBe(180);
    expect(app.stuckWatch.value('confirmed-stuck', SIS, clock.now())).toBe(180_000);
  });

  it('★ websub_renew_fail_streak{channel} · youtube_rss_fail_streak{channel} 이 채널별로 갈린다', async () => {
    const { app, clock } = await boot();

    app.stuckWatch.observe('websub-renew', YT_CHANNEL, true, clock.now());
    app.stuckWatch.observe('rss', YT_CHANNEL, true, clock.now());
    app.stuckWatch.observe('rss', YT_CHANNEL, true, clock.now());

    expect(gaugeOf(app.metricsRegistry, 'websub_renew_fail_streak').byLabel[YT_CHANNEL]).toBe(1);
    expect(gaugeOf(app.metricsRegistry, 'youtube_rss_fail_streak').byLabel[YT_CHANNEL]).toBe(2);
    // 한 채널의 실패가 다른 채널을 덮지 않는다
    expect(gaugeOf(app.metricsRegistry, 'youtube_rss_fail_streak').byLabel['UCother']).toBeUndefined();
  });

  it('★ websub_lease_ratio{channel} — 리스 잔량이 비율로 보인다 (AC-P7)', async () => {
    const expiresAt = new Date(Date.now() + 216_000_000).toISOString();
    const { app } = await boot(
      (u) => {
        u.loadLiveFixture(IDLE);
      },
      {
        seed: (db) => {
          createYoutubeChannelRepo(db).upsert(YT_CHANNEL, '테스트');
          const subs = createWebSubSubRepo(db);
          subs.ensure(YT_CHANNEL, 'a'.repeat(32));
          // 5일 리스 중 2.5일이 남았다 → 0.5
          subs.recordLease(YT_CHANNEL, 432_000, expiresAt);
        },
      },
    );

    const ratio = gaugeOf(app.metricsRegistry, 'websub_lease_ratio').byLabel[YT_CHANNEL];
    expect(ratio).toBeGreaterThan(0.45);
    expect(ratio).toBeLessThan(0.55);
  });
});

// ══════════════════════════════════════════════════════════════════
//  reader — 팔로워
// ══════════════════════════════════════════════════════════════════

describe('§9.4 — follower-check 에 사는 값들', () => {
  const VIEWER = 'aaaa1111bbbb2222cccc3333dddd4444';

  /** 상류 팔로워 응답만 가로채고 나머지는 실제 하니스로 흘려보낸다 */
  function followerFetch(bodyOf: () => unknown): typeof fetch {
    return async (input: FetchTarget, init?: FetchInit): Promise<Response> => {
      if (targetUrl(input).includes('/api/followers/')) {
        return new Response(JSON.stringify(bodyOf()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return fetch(input, init);
    };
  }

  it('★★ follower_lookup_total · _ms · _snapshot_age_sec · _unknown_total{reason} · _recheck_total', async () => {
    let wrongChannel = false;
    const cachedAtMs = Date.now() - 60_000;
    const fetchImpl = followerFetch(() => ({
      channelId: wrongChannel ? AIGOM : SIS,
      viewerChannelId: VIEWER,
      isFollower: false,
      everSynced: true,
      cachedAt: new Date(cachedAtMs).toISOString(),
    }));

    const { app, clock } = await boot(
      (u) => {
        u.loadLiveFixture(IDLE);
      },
      { fetchImpl },
    );

    expect(counterOf(app.metricsRegistry, 'follower_lookup_total').total).toBe(0);

    const first = await app.followers.check(VIEWER, clock.now());
    expect(first.verdict).toBe('no');

    expect(counterOf(app.metricsRegistry, 'follower_lookup_total').total).toBe(1);
    // 왕복 시간은 `OutboundMetrics` 가 재고 레지스트리는 그것을 **읽는다**
    expect(durationOf(app.metricsRegistry, 'follower_lookup_ms').count).toBe(1);
    expect(durationOf(app.metricsRegistry, 'follower_lookup_ms').lastMs).toBeGreaterThanOrEqual(0);
    // 거부 안내에 싣는 값과 같은 값이어야 한다 (R-4)
    expect(gaugeOf(app.metricsRegistry, 'follower_snapshot_age_sec').value).toBe(
      first.snapshotAgeSec,
    );
    expect(gaugeOf(app.metricsRegistry, 'follower_snapshot_age_sec').value).toBeGreaterThan(0);

    // ★ R5 — 남의 채널 응답은 `wrong-channel` 로 접힌다
    wrongChannel = true;
    const second = await app.followers.check(VIEWER, clock.now());
    expect(second.reason).toBe('wrong-channel');
    expect(
      counterOf(app.metricsRegistry, 'follower_lookup_unknown_total').byLabel['wrong-channel'],
    ).toBe(1);
    expect(counterOf(app.metricsRegistry, 'follower_lookup_unknown_total').total).toBe(1);

    // ★ AD-2 재조회 — **인증당 최대 1**
    wrongChannel = false;
    expect(app.followers.scheduleRecheck(VIEWER, first, () => undefined)).toBe(true);
    expect(counterOf(app.metricsRegistry, 'follower_lookup_recheck_total').total).toBe(0);
    clock.advance(11 * 60_000);
    expect(counterOf(app.metricsRegistry, 'follower_lookup_recheck_total').total).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════
//  reader — 그 밖의 배선
// ══════════════════════════════════════════════════════════════════

describe('§9.4 — 게이트웨이 · 서명 · 인증 · 아웃바운드', () => {
  it('★ discord_gateway_reconnects · websub_signature_failures{channel} · outbound_timeout_total{call} · auth_flow_rejected{reason}', async () => {
    const { app, fake } = await boot();

    // FM1 의 조기 경보
    expect(counterOf(app.metricsRegistry, 'discord_gateway_reconnects').total).toBe(0);
    fake.simulateReconnect();
    expect(counterOf(app.metricsRegistry, 'discord_gateway_reconnects').total).toBe(1);

    // AC-P5 — 조용한 202 의 원인을 특정하는 유일한 축
    app.signatureFailures.record(YT_CHANNEL, 'mismatch');
    expect(
      counterOf(app.metricsRegistry, 'websub_signature_failures').byLabel[YT_CHANNEL],
    ).toBe(1);

    // §5.6.1 — 특정 호출만 치솟으면 그 상류가 병들고 있다
    app.metrics.recordTimeout('rss-poll');
    app.metrics.recordTimeout('rss-poll');
    const timeouts = counterOf(app.metricsRegistry, 'outbound_timeout_total');
    expect(timeouts.byLabel['rss-poll']).toBe(2);
    expect(timeouts.byLabel['oauth-token']).toBeUndefined();

    // §5.6.2 — `/인증` 진입 거절
    const enter = { guildId: GUILD, userId: 'user-1', pendingInGuild: 0 };
    expect(app.authGuard.tryEnter(enter).ok).toBe(true);
    expect(app.authGuard.tryEnter(enter).ok).toBe(false);
    expect(counterOf(app.metricsRegistry, 'auth_flow_rejected').byLabel.cooldown).toBe(1);
  });

  it('★ viewer_token_revoke_failures — revoke 가 실패하면 잔여 권한이 남는다', async () => {
    const viewerChannel = 'ffff9999eeee8888dddd7777cccc6666';
    const fetchImpl = async (input: FetchTarget, init?: FetchInit): Promise<Response> => {
      const url = targetUrl(input);
      const json = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (url.endsWith('/auth/v1/token/revoke')) return json({ code: 500 }, 500);
      if (url.endsWith('/auth/v1/token')) return json({ code: 200, content: { accessToken: 'at' } });
      if (url.endsWith('/open/v1/users/me')) {
        return json({ code: 200, content: { channelId: viewerChannel, channelName: '시청자' } });
      }
      return fetch(input, init);
    };

    const { app } = await boot(() => undefined, { fetchImpl });
    // AD-1 — 보호 채널이면 revoke 자체를 건너뛴다. 이 시청자는 보호 대상이 아니다.
    expect(app.protectedChannelIds).not.toContain(viewerChannel);
    expect(counterOf(app.metricsRegistry, 'viewer_token_revoke_failures').total).toBe(0);

    const identified = await app.viewerToken.identify({ code: 'code-1' });
    expect(identified.ok).toBe(true);
    // revoke 는 fire-and-forget 이다 — 끝날 때까지 기다린다
    await app.viewerToken.settled();

    expect(counterOf(app.metricsRegistry, 'viewer_token_revoke_failures').total).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════
//  레지스트리 자체
// ══════════════════════════════════════════════════════════════════

describe('레지스트리 — 값을 접는 규칙', () => {
  it('★ p95 는 표본에서 나온다', () => {
    const r = createMetricsRegistry({});
    for (let i = 1; i <= 100; i++) r.duration('live_webhook_ack_ms', i);
    const d = durationOf(r, 'live_webhook_ack_ms');
    expect(d.count).toBe(100);
    expect(d.lastMs).toBe(100);
    expect(d.p95Ms).toBe(95);
  });

  it('★ 표본 버퍼는 상한을 넘지 않는다 — 상류 오작동이 무한 증가 지점이 되면 안 된다', () => {
    const r = createMetricsRegistry({});
    const total = SAMPLE_CAPACITY + 100;
    for (let i = 1; i <= total; i++) r.duration('live_webhook_ack_ms', i);
    const d = durationOf(r, 'live_webhook_ack_ms');
    // 횟수는 전부 세지만 표본은 최근 것만 남는다 → p95 가 최근 창에서 나온다
    expect(d.count).toBe(total);
    expect(d.p95Ms).toBeGreaterThan(total - SAMPLE_CAPACITY);
  });

  it('★★ 라벨이 둘 이상인 게이지는 `value` 를 주지 않는다 — 접는 규칙이 지표마다 다르다', () => {
    const r = createMetricsRegistry({
      gauges: {
        websub_lease_ratio: () => ({ a: 0.1, b: 0.9 }),
        youtube_rss_fail_streak: () => ({ only: 3 }),
      },
    });
    // 잔량은 최솟값이 나쁘고 연속 실패는 최댓값이 나쁘다 — 하나로 접으면 한쪽이 틀린다
    expect(gaugeOf(r, 'websub_lease_ratio').value).toBeUndefined();
    expect(gaugeOf(r, 'websub_lease_ratio').byLabel).toEqual({ a: 0.1, b: 0.9 });
    // 라벨이 하나뿐이면 그 값이 곧 답이다
    expect(gaugeOf(r, 'youtube_rss_fail_streak').value).toBe(3);
  });

  it('★ 읽기 함수가 던져도 스냅샷은 살아 있다 (Principle 2)', () => {
    const r = createMetricsRegistry({
      counters: {
        discord_gateway_reconnects: () => {
          throw new Error('상류가 무너졌다');
        },
      },
    });
    expect(() => r.snapshot()).not.toThrow();
    expect(counterOf(r, 'discord_gateway_reconnects').total).toBe(0);
  });

  it('★ 읽기 함수를 꽂지 않으면 `unwired()` 가 그 이름을 말한다', () => {
    const r = createMetricsRegistry();
    // 로컬 기록 지표는 여기 없다 — 읽기 함수가 필요한 이름만 나온다
    expect(r.unwired()).toContain('discord_gateway_reconnects');
    expect(r.unwired()).not.toContain('live_webhook_ack_ms');
  });

  it('★ 읽기 함수는 한 번만 꽂을 수 있다 — 덮어쓰면 먼저 꽂은 배선이 조용히 사라진다', async () => {
    const r = createMetricsRegistry();
    r.bind({ counters: { discord_gateway_reconnects: () => 7 } });
    expect(counterOf(r, 'discord_gateway_reconnects').total).toBe(7);
    expect(() => {
      r.bind({});
    }).toThrow();

    // 조립부는 이미 한 번 꽂았다
    const { app } = await boot();
    expect(() => {
      app.metricsRegistry.bind({});
    }).toThrow();
  });
});
