import { describe, it, expect } from 'vitest';

import {
  LEASE_RENEW_AT_ELAPSED_RATIO,
  TOPIC_URL_BASE,
  YOUTUBE_HUB_URL,
  leaseRemainingRatio,
  parseLeaseSeconds,
  renewAfterMs,
  topicUrl,
} from '../../src/youtube/websub-client.js';
import { YOUTUBE_FEED_URL_BASE, feedUrl } from '../../src/youtube/rss-poller.js';

/**
 * 계획 §5.3 "WebSub 운영 규칙" — 리스 계산 (AC-20 · AC-P7).
 *
 * ★★ 이 파일이 지키는 문장: **허브가 준 `lease_seconds` 를 그대로 쓰고 50% 에 갱신한다.
 *   상수 5일을 박지 않는다.** 그래서 `renewAfterMs` 에는 기본 리스가 없고, 리스를
 *   모르면 "지금 갱신"(0)이다 — 모르는 값을 채워 넣는 대신 다시 물어본다.
 */

describe('parseLeaseSeconds — 허브가 준 값만 믿는다', () => {
  it('정상 값을 그대로 돌려준다', () => {
    expect(parseLeaseSeconds('432000')).toBe(432_000); // 5일
    expect(parseLeaseSeconds('864000')).toBe(864_000); // 10일 — 허브가 다른 값을 줘도 그대로다
    expect(parseLeaseSeconds(' 60 ')).toBe(60);
    expect(parseLeaseSeconds('1')).toBe(1);
  });

  it('★ 0 · 음수 · 비정수 · 결측을 전부 undefined 로 접는다 (기본값을 채우지 않는다)', () => {
    expect(parseLeaseSeconds('0')).toBeUndefined();
    expect(parseLeaseSeconds('-1')).toBeUndefined();
    expect(parseLeaseSeconds('-432000')).toBeUndefined();
    expect(parseLeaseSeconds('12.5')).toBeUndefined();
    expect(parseLeaseSeconds('abc')).toBeUndefined();
    expect(parseLeaseSeconds('')).toBeUndefined();
    expect(parseLeaseSeconds('   ')).toBeUndefined();
    expect(parseLeaseSeconds(null)).toBeUndefined();
    expect(parseLeaseSeconds(undefined)).toBeUndefined();
    expect(parseLeaseSeconds('Infinity')).toBeUndefined();
    expect(parseLeaseSeconds('NaN')).toBeUndefined();
  });
});

describe('renewAfterMs — 50% 시점', () => {
  it('★ 리스의 정확히 절반이다', () => {
    expect(LEASE_RENEW_AT_ELAPSED_RATIO).toBe(0.5);
    expect(renewAfterMs(432_000)).toBe(216_000_000); // 5일 → 2.5일
    expect(renewAfterMs(100)).toBe(50_000);
    expect(renewAfterMs(1)).toBe(500);
  });

  it('★★ 0 · 음수 · 결측 방어 — 전부 0(즉시 갱신)이다', () => {
    // 상수 5일을 채워 넣지 않는다. 모르면 지금 다시 묻는 것이 안전한 방향이다 —
    // 길게 잡으면 만료를 지나치고, 짧게 잡으면 재구독이 한 번 더 나갈 뿐이다.
    expect(renewAfterMs(0)).toBe(0);
    expect(renewAfterMs(-1)).toBe(0);
    expect(renewAfterMs(-432_000)).toBe(0);
    expect(renewAfterMs(undefined)).toBe(0);
    expect(renewAfterMs(Number.NaN)).toBe(0);
    expect(renewAfterMs(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('홀수 리스에서도 정수 밀리초다', () => {
    expect(Number.isInteger(renewAfterMs(3))).toBe(true);
  });
});

describe('leaseRemainingRatio — AC-P7 판정값', () => {
  const NOW = 1_000_000;
  const LEASE = 1_000; // 초 → 1,000,000ms

  it('막 갱신됐으면 1, 절반 지났으면 0.5, 만료면 0', () => {
    expect(leaseRemainingRatio(NOW, NOW + LEASE * 1_000, LEASE)).toBe(1);
    expect(leaseRemainingRatio(NOW, NOW + LEASE * 500, LEASE)).toBe(0.5);
    expect(leaseRemainingRatio(NOW, NOW, LEASE)).toBe(0);
  });

  it('★ 만료를 지나도 음수가 되지 않는다 (0 으로 접는다)', () => {
    expect(leaseRemainingRatio(NOW, NOW - 999_999, LEASE)).toBe(0);
  });

  it('★ 1 을 넘지 않는다 (허브가 리스를 늘려 준 뒤의 과도기)', () => {
    expect(leaseRemainingRatio(NOW, NOW + LEASE * 5_000, LEASE)).toBe(1);
  });

  it('★★ 만료 시각이나 리스를 모르면 0 이다 — "모르는 구독"은 경보 대상이 맞다', () => {
    expect(leaseRemainingRatio(NOW, undefined, LEASE)).toBe(0);
    expect(leaseRemainingRatio(NOW, NOW + 1_000, undefined)).toBe(0);
    expect(leaseRemainingRatio(NOW, NOW + 1_000, 0)).toBe(0);
    expect(leaseRemainingRatio(NOW, NOW + 1_000, -5)).toBe(0);
  });

  it('AC-P7 경보선(0.2) 경계 — 0.15 는 아래, 0.25 는 위다', () => {
    const lease = 1_000;
    const at15 = NOW + lease * 1_000 * 0.15;
    const at25 = NOW + lease * 1_000 * 0.25;
    expect(leaseRemainingRatio(NOW, at15, lease) < 0.2).toBe(true);
    expect(leaseRemainingRatio(NOW, at25, lease) < 0.2).toBe(false);
  });
});

describe('주소 상수', () => {
  it('허브는 계획이 지정한 곳이다', () => {
    expect(YOUTUBE_HUB_URL).toBe('https://pubsubhubbub.appspot.com/subscribe');
  });

  it('★ 토픽 주소와 RSS 폴 주소는 경로가 다르다 — 섞으면 검증이 전부 거절된다', () => {
    expect(TOPIC_URL_BASE).toBe('https://www.youtube.com/xml/feeds/videos.xml');
    expect(YOUTUBE_FEED_URL_BASE).toBe('https://www.youtube.com/feeds/videos.xml');
    expect(TOPIC_URL_BASE).not.toBe(YOUTUBE_FEED_URL_BASE);
    expect(topicUrl('UCabc')).toBe(
      'https://www.youtube.com/xml/feeds/videos.xml?channel_id=UCabc',
    );
    expect(feedUrl('UCabc')).toBe('https://www.youtube.com/feeds/videos.xml?channel_id=UCabc');
  });

  it('채널 id 를 인코딩한다', () => {
    expect(topicUrl('UC a&b')).toContain('channel_id=UC%20a%26b');
  });
});
