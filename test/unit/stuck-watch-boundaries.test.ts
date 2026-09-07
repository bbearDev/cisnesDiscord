import { describe, expect, it } from 'vitest';

import { buildSpecs, createStuckWatch } from '../../src/live/stuck-watch.js';
import type { StuckWatchThresholds } from '../../src/live/stuck-watch.js';

/**
 * `stuck-watch` 경계 — 계획 §9.1 이 지목한 검증.
 *
 * ★ 왜 경계를 unit 으로 고정하는가.
 *   AC-P1/P2/P4/P7 이 **한 구현을 공유**하므로, 경계 하나가 어긋나면 네 경보가
 *   함께 어긋난다. 그리고 그 어긋남은 **조용하다** — 임계를 넘겨야 발화하는
 *   물건이라 평상시 테스트로는 드러나지 않는다.
 */

const T: StuckWatchThresholds = {
  confirmedStuckMs: 5 * 60_000,
  pollFailCount: 5,
  rssFailCount: 5,
  renewFailCount: 3,
  followerStaleCount: 5,
};

const SISNES = 'c3355ea2b3bea6c646789510796379d6';
const UC = 'UCcisnesTest0000000001';

function watch(): ReturnType<typeof createStuckWatch> {
  return createStuckWatch({ specs: buildSpecs(T) });
}

describe('AC-P1 — confirmed 고착 (지속시간 판정)', () => {
  it('4분 59초까지는 경보하지 않는다', () => {
    const w = watch();
    const t0 = 1_000_000;
    for (const dt of [0, 60_000, 299_999]) {
      expect(w.observe('confirmed-stuck', SISNES, true, t0 + dt)).toBeUndefined();
    }
  });

  it('정확히 5분에 경보 1건을 낸다', () => {
    const w = watch();
    const t0 = 1_000_000;
    w.observe('confirmed-stuck', SISNES, true, t0);
    const fired = w.observe('confirmed-stuck', SISNES, true, t0 + 300_000);
    expect(fired).toBeDefined();
    expect(fired?.kind).toBe('confirmed_stuck');
    expect(fired?.value).toBe(300_000);
  });

  it('임계를 넘긴 뒤에도 다시 발화하지 않는다 — 에피소드당 1건', () => {
    const w = watch();
    const t0 = 1_000_000;
    w.observe('confirmed-stuck', SISNES, true, t0);
    expect(w.observe('confirmed-stuck', SISNES, true, t0 + 300_000)).toBeDefined();
    for (const dt of [400_000, 600_000, 3_600_000]) {
      expect(w.observe('confirmed-stuck', SISNES, true, t0 + dt)).toBeUndefined();
    }
  });

  it('지속시간은 관측 시각이 아니라 나쁜 상태의 시작 시각을 기준으로 잰다', () => {
    // ★ 폴링 주기가 불규칙해도 판정이 흔들리면 안 된다.
    const w = watch();
    w.observe('confirmed-stuck', SISNES, true, 0);
    // 두 번째 관측이 한참 뒤에 와도 기준은 여전히 t=0 이다
    const fired = w.observe('confirmed-stuck', SISNES, true, 300_000);
    expect(fired?.value).toBe(300_000);
  });

  it('정상 관측 하나로 에피소드가 끝나고 지속 카운터가 0 이 된다', () => {
    const w = watch();
    w.observe('confirmed-stuck', SISNES, true, 0);
    w.observe('confirmed-stuck', SISNES, false, 100_000);
    expect(w.value('confirmed-stuck', SISNES, 400_000)).toBe(0);
    // 다시 나빠져도 새 에피소드라 5분을 다시 채워야 한다
    w.observe('confirmed-stuck', SISNES, true, 200_000);
    expect(w.observe('confirmed-stuck', SISNES, true, 200_000 + 299_999)).toBeUndefined();
    expect(w.observe('confirmed-stuck', SISNES, true, 200_000 + 300_000)).toBeDefined();
  });
});

describe('AC-P2 — live-api unknown (연속횟수 판정)', () => {
  it('4회까지는 경보하지 않고 5회째에 1건을 낸다', () => {
    const w = watch();
    for (let i = 1; i <= 4; i++) {
      expect(w.observe('live-api-unknown', SISNES, true, i)).toBeUndefined();
    }
    expect(w.observe('live-api-unknown', SISNES, true, 5)?.kind).toBe('live_api_unknown');
  });

  it('중간에 announce 가 한 번 오면 카운터가 리셋된다', () => {
    const w = watch();
    for (let i = 1; i <= 4; i++) w.observe('live-api-unknown', SISNES, true, i);
    w.observe('live-api-unknown', SISNES, false, 5);
    expect(w.value('live-api-unknown', SISNES, 5)).toBe(0);
    for (let i = 6; i <= 9; i++) {
      expect(w.observe('live-api-unknown', SISNES, true, i)).toBeUndefined();
    }
  });
});

describe('AC-P4 / AC-P7 — 같은 구현, 다른 임계', () => {
  it('RSS 는 4회 무경보 / 5회 경보', () => {
    const w = watch();
    for (let i = 1; i <= 4; i++) expect(w.observe('rss', UC, true, i)).toBeUndefined();
    expect(w.observe('rss', UC, true, 5)?.kind).toBe('rss_fail');
  });

  it('WebSub 갱신은 2회 무경보 / 3회 경보', () => {
    const w = watch();
    for (let i = 1; i <= 2; i++) expect(w.observe('websub-renew', UC, true, i)).toBeUndefined();
    expect(w.observe('websub-renew', UC, true, 3)?.kind).toBe('websub_lease');
  });
});

describe('★ 도메인 간 카운터 격리 — 공유 구현의 가장 흔한 회귀', () => {
  it('RSS 실패가 live-api unknown 스트릭을 오염시키지 않는다', () => {
    const w = watch();
    for (let i = 1; i <= 4; i++) w.observe('rss', UC, true, i);
    expect(w.value('rss', UC, 4)).toBe(4);
    expect(w.value('live-api-unknown', SISNES, 4)).toBe(0);
  });

  it('반대 방향도 성립한다', () => {
    const w = watch();
    for (let i = 1; i <= 4; i++) w.observe('live-api-unknown', SISNES, true, i);
    expect(w.value('live-api-unknown', SISNES, 4)).toBe(4);
    expect(w.value('rss', UC, 4)).toBe(0);
  });

  it('같은 도메인이라도 채널이 다르면 카운터가 갈린다', () => {
    const w = watch();
    for (let i = 1; i <= 4; i++) w.observe('rss', 'UCaaaaaaaaaaaaaaaaaaaaaa', true, i);
    expect(w.value('rss', 'UCbbbbbbbbbbbbbbbbbbbbbb', 4)).toBe(0);
    // 한 채널이 임계를 넘겨도 다른 채널은 조용하다
    w.observe('rss', 'UCaaaaaaaaaaaaaaaaaaaaaa', true, 5);
    expect(w.observe('rss', 'UCbbbbbbbbbbbbbbbbbbbbbb', true, 6)).toBeUndefined();
  });
});

describe('★ follower-stale — 배선하되 발화하지 않는다 (S1-J 전까지)', () => {
  it('임계를 한참 넘겨도 경보하지 않는다', () => {
    const w = watch();
    for (let i = 1; i <= 10; i++) {
      expect(w.observe('follower-stale', SISNES, true, i)).toBeUndefined();
    }
  });

  it('그러나 스트릭은 정확히 센다 — 지표는 남아야 한다', () => {
    // ★ 이것이 요점이다. 경보만 끄고 관측은 남긴다.
    //   `staleAfterMin` 150분이 실측이 아니라 추론이므로 임계가 맞는지 모른다.
    //   세어 두어야 S1-J 가 실제 분포를 보고 임계를 정할 수 있다.
    const w = watch();
    for (let i = 1; i <= 10; i++) w.observe('follower-stale', SISNES, true, i);
    expect(w.value('follower-stale', SISNES, 10)).toBe(10);
  });
});

describe('snapshot — 지표 수집', () => {
  it('도메인과 채널키를 분리해 돌려준다', () => {
    const w = watch();
    w.observe('rss', UC, true, 1);
    w.observe('live-api-unknown', SISNES, true, 1);
    const snap = w.snapshot(1);
    expect(snap).toHaveLength(2);
    expect(snap.find((s) => s.domain === 'rss')?.scopeKey).toBe(UC);
    expect(snap.find((s) => s.domain === 'live-api-unknown')?.scopeKey).toBe(SISNES);
  });

  it('구분자가 채널키를 자르지 않는다', () => {
    // ★ 구분자로 ':' 나 '-' 를 쓰면 채널키가 잘린다. NUL 이라 안전하다.
    const w = watch();
    const weird = 'UC-with-dashes:and:colons';
    w.observe('rss', weird, true, 1);
    expect(w.snapshot(1)[0]?.scopeKey).toBe(weird);
  });

  it('reset 은 그 도메인·채널만 지운다', () => {
    const w = watch();
    w.observe('rss', UC, true, 1);
    w.observe('live-api-unknown', SISNES, true, 1);
    w.reset('rss', UC);
    expect(w.value('rss', UC, 1)).toBe(0);
    expect(w.value('live-api-unknown', SISNES, 1)).toBe(1);
  });
});
