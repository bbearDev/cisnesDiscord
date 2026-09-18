import { describe, it, expect } from 'vitest';

import { buildSpecs, createStuckWatch } from '../../src/live/stuck-watch.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { openDb } from '../../src/store/db.js';
import { migrate } from '../../src/store/migrate.js';
import { createWebSubSubRepo } from '../../src/store/repos/websub-sub-repo.js';
import { createYoutubeChannelRepo } from '../../src/store/repos/youtube-channel-repo.js';
import type { TextClient, TextFailureKind, TextOutcome } from '../../src/youtube/http-text.js';
import {
  RESUBSCRIBE_COOLDOWN_MS,
  WEBSUB_BACKOFF_MAX_SEC,
  WEBSUB_PENDING_BACKOFF_MAX_SEC,
  createWebSubClient,
} from '../../src/youtube/websub-client.js';

/**
 * 실패 **종류별** 처리 — `hubDelivery` 가 실제로 클라이언트 동작을 가르는가.
 *
 * ★★ **왜 e2e 하니스가 아니라 여기인가.** `youtube-alert.test.ts` 의 하니스는
 *   `fetchImpl` 로 응답을 흉내 내므로 **HTTP 상태만** 만들 수 있다. `timeout` 과
 *   `budget` 은 `runtime/http-budget.ts` 가 진짜 `setTimeout`·실시간 `now()` 로
 *   판정하는 값이라 가짜 시계로는 재현되지 않는다.
 *
 *   그래서 그 두 종류는 **순수 함수 테스트만 있으면 공허하다** — `hubDelivery` 의
 *   분기를 뒤집어도 클라이언트 쪽 테스트는 하나도 안 깨진다. `TextClient` 를 통째로
 *   스텁으로 갈아 끼워 그 구멍을 막는다. (같은 종류의 공허함을 이 PR 에서 이미
 *   한 번 놓쳤다 — 미정 백오프 상한이 그랬다.)
 */

const CH = 'UCdeliveryTest00000001';
const LABEL = '전달 판정 테스트';
const T0 = Date.parse('2026-09-19T00:00:00.000Z');

/** 언제나 같은 실패를 돌려주는 `TextClient` */
function failWith(kind: TextFailureKind, status?: number): TextClient & { calls: number } {
  const c = {
    calls: 0,
    request: (): Promise<TextOutcome> => {
      c.calls += 1;
      return Promise.resolve({
        ok: false,
        kind,
        ...(status === undefined ? {} : { status }),
        detail: `스텁 실패: ${kind}`,
      });
    },
  };
  return c;
}

function build(http: TextClient) {
  const clock = new ManualClock(T0);
  const db = openDb({ path: ':memory:' });
  migrate(db);
  const subs = createWebSubSubRepo(db);
  const websub = createWebSubClient({
    http,
    subs,
    channels: createYoutubeChannelRepo(db),
    configured: [{ channelId: CH, label: LABEL }],
    callbackUrl: 'https://bot.test/websub',
    clock,
    stuck: createStuckWatch({
      specs: buildSpecs({
        confirmedStuckMs: 5 * 60_000,
        pollFailCount: 5,
        rssFailCount: 5,
        renewFailCount: 3,
        followerStaleCount: 3,
      }),
    }),
    leaseWarnRatio: 0.2,
  });
  return {
    clock,
    subs,
    websub,
    close: (): void => {
      db.close();
    },
  };
}

describe('★★ 5xx — 허브가 받았을 수 있다', () => {
  it('검증 대기 창을 열고 renewPending 으로 센다', async () => {
    const h = build(failWith('http', 503));
    const out = await h.websub.sweep();

    expect(out.renewPending, '5xx 를 미정으로 안 셌다').toBe(1);
    expect(out.renewFailed).toBe(0);
    expect(h.subs.get(CH)?.subscribedAt, '검증 대기 창이 안 열렸다').toBeDefined();
    h.close();
  });

  /**
   * ★★ **생산자와 소비자 사이의 배선을 잡는다.**
   *
   *   `skippedCooldown` 을 올리는 쪽(`runSweep`)과 읽는 쪽(`/구독갱신` 문구)은 각각
   *   테스트가 있었지만 **그 사이가 없었다** — 증가 줄을 지워도 저장소 전체가 통과했다.
   *   그러면 카운터가 영영 0 이고, 새 문구 분기는 죽은 코드가 되며, 운영자는 다시
   *   *"갱신할 구독이 없습니다"* 를 `잔여 0%` 옆에서 읽게 된다.
   */
  it('★★ 검증 대기 창에 걸린 채널을 skippedCooldown 으로 센다 (시도는 0건)', async () => {
    const http = failWith('http', 503);
    const h = build(http);

    await h.websub.sweep(); // 미정 → markRequested → 창 10분
    expect(http.calls).toBe(1);

    h.clock.advance(60_000); // 창 안
    const out = await h.websub.sweep();

    expect(out.skippedCooldown, '창에 걸린 채널을 안 셌다').toBe(1);
    expect(out.renewPending, '시도하지도 않고 미정으로 셌다').toBe(0);
    expect(out.renewFailed).toBe(0);
    expect(http.calls, '창 안인데 허브를 또 두드렸다').toBe(1);
    h.close();
  });

  it('★ 창이 풀리면 skippedCooldown 이 다시 0 이다 — 굳으면 안 된다', async () => {
    const h = build(failWith('http', 503));
    await h.websub.sweep();
    h.clock.advance(RESUBSCRIBE_COOLDOWN_MS + 1_000);
    const out = await h.websub.sweep();
    expect(out.skippedCooldown).toBe(0);
    expect(out.renewPending).toBe(1);
    h.close();
  });

  it('★★ 재시도 상한이 30분이다 — 1시간이면 성사 가능한 시도를 버린다', async () => {
    const h = build(failWith('http', 503));
    // 상한에 닿을 만큼 스트릭을 올린다
    for (let i = 0; i < 6; i++) {
      await h.websub.sweep();
      h.clock.advance(61 * 60_000);
    }
    await h.websub.sweep();

    // 31분 — 미정 상한(30분)은 지났고 확정 실패 상한(1시간)은 아직이다
    h.clock.advance(31 * 60_000);
    const out = await h.websub.sweep();
    expect(out.renewPending, '30분이 지났는데 다시 치지 않았다').toBe(1);
    h.close();
  });
});

/**
 * ★★ **무응답은 "곧 붙는다" 가 아니다.**
 *
 *   닿았는지 모르므로 중복 요청은 막아야 하지만(창은 연다), 30분 상한과
 *   *"저절로 완료됩니다"* 는 **503 응답이 20.29초에 도착한** 관측에서 나온 것이지
 *   무응답에서 나온 것이 아니다. 무응답은 오히려 우리가 조여지고 있다는 신호에
 *   가까우므로 **덜 두드려야** 한다.
 */
describe('★★ timeout — 닿았는지 모른다', () => {
  it('검증 대기 창은 연다 — 닿았을 수 있으므로 또 보내면 중복이 된다', async () => {
    const h = build(failWith('timeout'));
    await h.websub.sweep();
    expect(h.subs.get(CH)?.subscribedAt, '무응답인데 창을 안 열었다').toBeDefined();
    h.close();
  });

  it('★★ 그러나 renewPending 이 아니다 — "곧 붙는다" 고 말하면 안 된다', async () => {
    const h = build(failWith('timeout'));
    const out = await h.websub.sweep();
    expect(out.renewPending, '무응답을 "허브가 받았다" 로 셌다').toBe(0);
    expect(out.renewFailed).toBe(1);
    h.close();
  });

  it('★★ 재시도 상한이 1시간이다 — 조여지는 신호에 두 배로 두드리면 안 된다', async () => {
    const h = build(failWith('timeout'));
    for (let i = 0; i < 6; i++) {
      await h.websub.sweep();
      h.clock.advance(61 * 60_000);
    }
    await h.websub.sweep();

    // 31분 — 미정 상한이면 쳤겠지만 확정 실패 상한(1시간)이라 아직이다
    h.clock.advance(31 * 60_000);
    const out = await h.websub.sweep();
    // ★ 실패 메시지를 **탐지하는 단언에** 붙인다. `renewFailed === 0` 쪽은 30분 상한을
    //   물려도 참이라(시도가 일어나고 'failed' 가 아니라 'pending' 이 된다) 장식이다.
    expect(out.renewPending + out.renewFailed, '무응답에 30분 상한을 물려 다시 쳤다').toBe(0);
    h.close();
  });
});

/**
 * ★★ **`budget` 은 거절이다.** 예산 소진은 두 경로인데 둘 다 기다릴 이유가 없다:
 *   `remaining <= 0` 은 요청을 **보내지도 않은** 것이고, 나머지는 **429 의
 *   `Retry-After` 가 예산을 넘긴** 것 — 허브가 속도를 줄이라고 명시한 경우다.
 *   창을 열면 오지 않을 검증을 기다리게 되고, 30분 상한까지 물리면 속도를 줄이라는
 *   상대를 두 배로 두드린다.
 */
describe('★★ budget — 미전송이거나 429 다', () => {
  it('검증 대기 창을 열지 않는다', async () => {
    const h = build(failWith('budget'));
    await h.websub.sweep();
    expect(h.subs.get(CH)?.subscribedAt, '기다릴 이유가 없는데 창을 열었다').toBeUndefined();
    h.close();
  });

  it('renewFailed 로 센다 — 운영자에게 "기다리라" 고 하면 안 된다', async () => {
    const h = build(failWith('budget'));
    const out = await h.websub.sweep();
    expect(out.renewPending).toBe(0);
    expect(out.renewFailed).toBe(1);
    h.close();
  });
});

describe('network — 닿지 않았다', () => {
  it('창을 열지 않고 확정 실패로 센다', async () => {
    const h = build(failWith('network'));
    const out = await h.websub.sweep();
    expect(h.subs.get(CH)?.subscribedAt).toBeUndefined();
    expect(out.renewFailed).toBe(1);
    h.close();
  });
});

describe('★ 상한 상수의 관계', () => {
  it('미정 상한 < 확정 실패 상한, 그리고 검증 대기 창 이상이다', () => {
    expect(WEBSUB_PENDING_BACKOFF_MAX_SEC).toBeLessThan(WEBSUB_BACKOFF_MAX_SEC);
    expect(WEBSUB_PENDING_BACKOFF_MAX_SEC * 1_000).toBeGreaterThanOrEqual(RESUBSCRIBE_COOLDOWN_MS);
  });
});
