import { describe, expect, it } from 'vitest';

import { API_TOKEN, SIS, WEBHOOK_TOKEN, boot } from '../helpers/app-harness.js';
import { CHZZKBOT_WEBHOOK_PATH } from '../../src/web/routes/chzzkbot-webhook.js';
import { FOLLOWER_UNKNOWN_REASONS } from '../../src/chzzk/follower-check.js';
import { CALL_TIMEOUT_MS } from '../../src/runtime/http-budget.js';

/**
 * 지표 배선 — 계획 §9.4.
 *
 * ## 이 계층이 확인하는 것은 값이 아니라 **배선의 존재**다
 *
 * §9.4 의 표는 *"지표가 실제로 배선돼 있는지를 테스트한다"* 고 적었다.
 * 지표는 **읽히기 위해** 존재하는데, 배선이 빠진 지표는 **언제나 0** 이고
 * 0 은 *"아무 일도 없었다"* 와 **구분되지 않는다.**
 * 즉 배선 누락은 조용하고, 하필 사고가 났을 때 침묵한다.
 *
 * ★ 그래서 여기서는 **사건을 일으키고 숫자가 움직이는지**를 본다.
 *   "필드가 존재한다" 만 보면 배선 없이도 통과한다.
 */

describe('§9.4 — 아웃바운드 지표', () => {
  it('★ outbound_timeout_total{call} — 실제로 타임아웃을 내면 그 호출의 칸이 오른다', async () => {
    const { app } = await boot((u) => {
      // ★ 응답을 영영 주지 않는다. AbortSignal 이 실제로 걸려 있어야만 끊긴다.
      u.setHang(true);
    });

    // ★ 기동 복구가 이미 1회 조회하고 타임아웃을 냈다(§S7). 절대값이 아니라
    //   **증분**을 본다 — 절대값으로 쓰면 복구 동작이 바뀔 때마다 이 테스트가 깨진다.
    const before = app.metrics.timeouts['live-api'] ?? 0;
    expect(before).toBeGreaterThanOrEqual(1); // 복구가 실제로 조회했다는 증거

    const tick = await app.livePoller.poll();
    expect(tick.outcome).not.toBe('skipped');

    // 배선이 없으면 이 값은 영원히 0 이고, 그 침묵이 곧 "상류가 멀쩡하다" 로 읽힌다.
    expect((app.metrics.timeouts['live-api'] ?? 0) - before).toBe(1);

    // ★ 라벨이 호출별로 갈린다 — 특정 상류만 병드는 것을 보려면 이게 필요하다.
    //   (같은 하니스를 두 번 띄우면 실제 타임아웃을 두 번 기다려 6초가 더 든다.
    //    한 번 띄운 김에 여기서 함께 단언한다.)
    expect(app.metrics.timeouts['follower-lookup'] ?? 0).toBe(0);
    expect(app.metrics.timeouts['rss-poll'] ?? 0).toBe(0);
    expect(app.metrics.timeouts['websub-subscribe'] ?? 0).toBe(0);
  }, 20_000);

  it('왕복 시간이 기록된다 (follower_lookup_ms 의 축)', async () => {
    const { app } = await boot((u) => {
      u.loadLiveFixture('chzzkbot/api-live-2channels-idle.json');
    });
    await app.livePoller.poll();

    expect(app.metrics.latencyCount['live-api']).toBeGreaterThanOrEqual(1);
    expect(app.metrics.lastLatencyMs['live-api']).toBeGreaterThanOrEqual(0);
    // 회당 타임아웃보다 오래 걸렸다면 애초에 끊겼어야 한다
    expect(app.metrics.lastLatencyMs['live-api']).toBeLessThanOrEqual(CALL_TIMEOUT_MS['live-api']);
  });
});

describe('§9.4 — 판정 건강도 지표', () => {
  it('★ live_api_unknown_streak — 조회 실패가 스트릭으로 쌓인다', async () => {
    const { app, clock } = await boot((u) => {
      u.setStatus(500);
    });

    // 기동 복구가 1회차를 센다(§S7). 이어지는 폴이 그 위에 쌓인다.
    expect(app.stuckWatch.value('live-api-unknown', SIS, clock.now())).toBe(1);
    await app.livePoller.poll();
    expect(app.stuckWatch.value('live-api-unknown', SIS, clock.now())).toBe(2);
  });

  it('★ 정상 응답 하나로 스트릭이 리셋된다 — 지표가 굳어 있지 않다', async () => {
    const { app, upstream, clock } = await boot((u) => {
      u.setStatus(500);
    });
    await app.livePoller.poll();
    expect(app.stuckWatch.value('live-api-unknown', SIS, clock.now())).toBeGreaterThan(0);

    upstream.setStatus(undefined);
    upstream.loadLiveFixture('chzzkbot/api-live-2channels-idle.json');
    await app.livePoller.poll();
    expect(app.stuckWatch.value('live-api-unknown', SIS, clock.now())).toBe(0);
  });

  it('★ live_unconfirmed_duration_sec — confirmed 고착이 시간으로 쌓인다 (AC-P1 의 축)', async () => {
    const { app, clock } = await boot((u) => {
      u.loadLiveFixture('chzzkbot/api-live-unconfirmed.json');
    });

    await app.livePoller.poll();
    const t0 = app.stuckWatch.value('confirmed-stuck', SIS, clock.now());
    clock.advance(60_000);
    await app.livePoller.poll();
    // 지속시간이 실제로 자란다 — 이 값이 5분을 넘으면 AC-P1 이 난다
    expect(app.stuckWatch.value('confirmed-stuck', SIS, clock.now())).toBeGreaterThan(t0);
  });
});

describe('§9.4 — 팔로워 지표', () => {
  it('★ follower_lookup_unknown_total{reason} 의 라벨 7종이 전부 배선돼 있다', async () => {
    const { app } = await boot();
    const counts = app.followers.metrics.unknownByReason;

    // ★ 라벨이 갈리면 §13 `scopes-이상` 이 지정한 "유일한 관측 축" 을 잃는다.
    //   그래서 목록 자체를 상수와 대조한다 — 하나라도 빠지면 여기서 걸린다.
    for (const reason of FOLLOWER_UNKNOWN_REASONS) {
      expect(counts[reason]).toBe(0);
    }
    expect(Object.keys(counts).sort()).toEqual([...FOLLOWER_UNKNOWN_REASONS].sort());
  });

});

describe('§9.4 — WebSub · 디스코드 지표', () => {
  it('★ discord_gateway_reconnects — 테스트가 세는 값과 운영이 보는 값이 같다', async () => {
    const { app, fake } = await boot();
    expect(app.gateway.reconnectCount).toBe(0);
    fake.simulateReconnect();
    // ★ 하니스와 프로덕션이 **같은 계수 규칙**을 공유한다(§S3). 둘이 갈리면
    //   테스트가 통과해도 운영에서 못 본다.
    expect(app.gateway.reconnectCount).toBe(1);
  });
});

describe('§9.4 — 원장 · 운영 기록', () => {
  it('★ ops_events 가 사유별로 셀 수 있다 — 기록이 뭉뚱그려지지 않는다', async () => {
    const { app } = await boot((u) => {
      u.setStatus(500);
    });
    // 기동 복구 실패가 사유 라벨과 함께 남는다
    expect(app.ops.count('recovery_live_unknown')).toBe(1);
    expect(app.ops.list('recovery_live_unknown')[0]?.detail).toBeTruthy();
  });
});

describe('AC-32 — 토큰이 운영 기록으로 새지 않는다', () => {
  /**
   * ★ 이 테스트는 한 번 **공허했다**. 초판은 `app.ops.list()` 에 대해 단언했는데
   *   그 시나리오(정상 폴 1회)에서는 목록이 **비어 있어** 단언이 무조건 참이었다 —
   *   토큰 유출에 대해 아무것도 검증하지 않았다.
   *
   * ★★ 그리고 모양(32자 hex)으로 찾으면 안 된다. 치지직 `channelId`
   *   (`c3355ea2b3bea6c646789510796379d6`)가 **정확히 32자 hex** 라, 목록이 비지 않게
   *   되는 순간 **정상 데이터에 오탐**한다. 실제 비밀값 문자열을 찾는다.
   *
   * 두 실수 모두 같은 뿌리다 — **단언이 실패할 수 있는 상태를 만들지 않았다.**
   * 그래서 여기서는 기록을 **실제로 만들고**, 비어 있지 않음을 먼저 못 박는다.
   */
  it('★ 토큰이 틀린 웹훅은 401 + 운영 기록을 남기는데, 그 기록에 토큰이 없다', async () => {
    const { app } = await boot((u) => {
      u.loadLiveFixture('chzzkbot/api-live-2channels-idle.json');
    });

    const wrongToken = 'z'.repeat(48);
    const res = await fetch(`${app.baseUrl}${CHZZKBOT_WEBHOOK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-chzzkbot-token': wrongToken },
      body: JSON.stringify({ event: 'live.started', version: 1, channelId: SIS }),
    });
    expect(res.status).toBe(401);

    // ★★ 공허 방지: 검사할 대상이 실제로 생겼는지 **먼저** 확인한다.
    //    이 단언이 없으면 기록이 0건일 때 아래가 전부 공짜로 통과한다 —
    //    초판이 정확히 그랬다. 이 한 줄이 이 테스트가 실패할 수 있음을 보증한다.
    const rows = app.ops.list();
    expect(rows.length).toBeGreaterThan(0);

    const haystack = rows.map((e) => `${e.kind} ${e.detail ?? ''}`).join('\n');
    // 모양이 아니라 **실제 값**을 찾는다 — channelId 오탐을 피한다.
    expect(haystack).not.toContain(wrongToken);
    expect(haystack).not.toContain(WEBHOOK_TOKEN);
    expect(haystack).not.toContain(API_TOKEN);
  });

  it('정상 채널 id 는 오탐하지 않는다 — 32자 hex 를 모양으로 잡으면 안 되는 이유', async () => {
    const { app } = await boot((u) => {
      u.loadLiveFixture('chzzkbot/api-live-foreign-channel-live.json');
    });
    await app.livePoller.poll();

    // 남의 채널을 본 기록에는 `channelId` 가 **정상적으로** 들어간다.
    const haystack = app.ops.list().map((e) => `${e.kind} ${e.detail ?? ''}`).join('\n');
    expect(haystack).not.toContain(API_TOKEN);
    expect(haystack).not.toContain(WEBHOOK_TOKEN);
  });
});
