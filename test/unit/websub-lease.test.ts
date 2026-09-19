import { describe, it, expect } from 'vitest';

import { MAX_YOUTUBE_CHANNELS } from '../../src/config/schema.js';
import {
  CALL_TIMEOUT_MS,
} from '../../src/runtime/http-budget.js';
import {
  LEASE_RENEW_AT_ELAPSED_RATIO,
  WEBSUB_BACKOFF_MAX_SEC,
  WEBSUB_BUDGET_MS,
  WEBSUB_PENDING_BACKOFF_MAX_SEC,
  WEBSUB_SWEEP_SEC,
  RESUBSCRIBE_COOLDOWN_MS,
  hubDelivery,
  renewBackoffMs,
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

describe('★★ 구독 재시도 백오프 — 재시도가 막힘을 유지시키지 않게', () => {
  it('연속 실패마다 2배로 벌어진다', () => {
    expect(renewBackoffMs(1, 300)).toBe(600_000); // 10분
    expect(renewBackoffMs(2, 300)).toBe(1_200_000); // 20분
    expect(renewBackoffMs(3, 300)).toBe(2_400_000); // 40분
  });

  it(`상한 ${String(WEBSUB_BACKOFF_MAX_SEC)}초를 넘지 않는다 — 막힘이 풀린 뒤 복귀가 느려지면 안 된다`, () => {
    for (const streak of [4, 10, 100]) {
      expect(renewBackoffMs(streak, 300)).toBeLessThanOrEqual(WEBSUB_BACKOFF_MAX_SEC * 1_000);
    }
    expect(renewBackoffMs(100, 300)).toBe(WEBSUB_BACKOFF_MAX_SEC * 1_000);
  });

  it('★ 연속 실패가 0 이면 백오프가 없다 — 성공 즉시 기본 주기로 돌아온다', () => {
    expect(renewBackoffMs(0, 300)).toBe(0);
    expect(renewBackoffMs(-1, 300)).toBe(0);
  });

  it('★ 첫 실패의 대기는 스윕 주기보다 길다 — 아니면 게이트가 아무 일도 안 한다', () => {
    expect(renewBackoffMs(1, WEBSUB_SWEEP_SEC)).toBeGreaterThan(WEBSUB_SWEEP_SEC * 1_000);
  });

  it('★★ 미정 상한은 확정 실패보다 짧다 — 성사 가능한 시도를 1시간씩 버리면 안 된다', () => {
    expect(WEBSUB_PENDING_BACKOFF_MAX_SEC).toBeLessThan(WEBSUB_BACKOFF_MAX_SEC);
    expect(renewBackoffMs(100, 300, WEBSUB_PENDING_BACKOFF_MAX_SEC)).toBe(
      WEBSUB_PENDING_BACKOFF_MAX_SEC * 1_000,
    );
    // 같은 스트릭인데 미정 쪽이 더 빨리 다시 시도한다 — 그것이 이 상수의 존재 이유다
    expect(renewBackoffMs(100, 300, WEBSUB_PENDING_BACKOFF_MAX_SEC)).toBeLessThan(
      renewBackoffMs(100, 300),
    );
  });

  it('★★ 미정 상한도 검증 대기 창보다는 길다 — 창 안에 또 두드리면 창이 무의미하다', () => {
    // 미정은 `markRequested` 로 10분 창이 열린다. 백오프 상한이 그보다 짧으면
    // 백오프가 먼저 풀려도 쿨다운에 막히므로, 상한은 창 이상이어야 뜻이 있다.
    expect(WEBSUB_PENDING_BACKOFF_MAX_SEC * 1_000).toBeGreaterThanOrEqual(RESUBSCRIBE_COOLDOWN_MS);
  });

  it('★ 기본 상한은 확정 실패 쪽이다 — 새 호출자가 덜 두드리는 쪽으로 틀리게', () => {
    expect(renewBackoffMs(100, 300)).toBe(WEBSUB_BACKOFF_MAX_SEC * 1_000);
  });
});

/**
 * ★★ 이 블록이 지키는 문장: **`ok === false` 는 "실패했다" 가 아니라 "모른다" 일 수 있다.**
 *
 *   실측 2026-09-19 — 허브가 20초를 끌다 `503 Transient error` 를 돌려준 요청이
 *   2분 뒤 검증 GET 을 받아 5일짜리 리스로 성사됐다. 같은 요청을 두 채널에 보냈는데
 *   응답은 초 단위까지 같았고 결과만 갈렸다. 허브는 확률적으로 처리한다.
 */
describe('★★ hubDelivery — 503 을 실패로 단정하지 않는다', () => {
  it('요청을 받고 나서 난 오류(500·502·503·504)만 may-be-accepted 다', () => {
    expect(hubDelivery({ kind: 'http', status: 503 })).toBe('may-be-accepted'); // 관측된 것
    expect(hubDelivery({ kind: 'http', status: 500 })).toBe('may-be-accepted');
    expect(hubDelivery({ kind: 'http', status: 502 })).toBe('may-be-accepted');
    expect(hubDelivery({ kind: 'http', status: 504 })).toBe('may-be-accepted');
  });

  /**
   * ★★ `>= 500` 으로 뭉뚱그리면 이 둘까지 미정이 된다. 5xx 지만 **4xx 와 같은 확정
   *   거절**이라, 30분 상한과 "기다리면 붙는다" 를 물리면 4xx 를 미정에서 뺀 이유
   *   ("설정이 틀려서 영영 안 붙는 상태를 10분 창 뒤에 숨긴다")가 그대로 되돌아온다.
   */
  it('★★ 501·505·511 은 5xx 라도 거절이다 — 재시도해도 같은 답이다', () => {
    expect(hubDelivery({ kind: 'http', status: 501 })).toBe('rejected'); // Not Implemented
    expect(hubDelivery({ kind: 'http', status: 505 })).toBe('rejected'); // HTTP Version Not Supported
    expect(hubDelivery({ kind: 'http', status: 511 })).toBe('rejected'); // Network Auth Required
    expect(hubDelivery({ kind: 'http', status: 599 })).toBe('rejected');
  });

  it('★★ 4xx 는 거절이다 — 거절된 요청까지 기다리면 영영 안 붙는 상태를 숨긴다', () => {
    expect(hubDelivery({ kind: 'http', status: 400 })).toBe('rejected');
    expect(hubDelivery({ kind: 'http', status: 403 })).toBe('rejected');
    expect(hubDelivery({ kind: 'http', status: 404 })).toBe('rejected');
    expect(hubDelivery({ kind: 'http', status: 429 })).toBe('rejected');
    expect(hubDelivery({ kind: 'http', status: 499 })).toBe('rejected');
  });

  it('★★ 타임아웃은 no-answer 다 — 닿았는지 모를 뿐, 곧 붙는다는 뜻이 아니다', () => {
    // 이 구분이 30분 상한과 "저절로 완료" 문구를 5xx 에만 묶는다. 무응답은 오히려
    // 우리가 조여지고 있다는 신호(2026-09-10)라 덜 두드려야 한다.
    expect(hubDelivery({ kind: 'timeout' })).toBe('no-answer');
  });

  /**
   * ★★ `budget` 은 **거절**이다. 예산 소진은 두 경로인데 둘 다 기다릴 이유가 없다:
   *   `remaining <= 0` 은 요청을 보내지도 않은 것이고(`http-budget.ts` 의
   *   `http-budget-wiring.test.ts` 가 `expect(spy).not.toHaveBeenCalled()` 로 못 박는다),
   *   나머지 하나는 **429 의 `Retry-After` 가 예산을 넘긴 경우** — 허브가 속도를
   *   줄이라고 명시한 것이다. 이것을 "기다리면 붙는다" 로 접으면 오지 않을 검증을
   *   기다리게 하면서 30분마다 두드린다.
   */
  it('★★ 예산 초과는 거절이다 — 미전송이거나 429 인데, 둘 다 기다릴 이유가 없다', () => {
    expect(hubDelivery({ kind: 'budget' })).toBe('rejected');
  });

  it('★ 네트워크 오류는 거절이다 — 요청이 닿지 않았다', () => {
    expect(hubDelivery({ kind: 'network' })).toBe('rejected');
    expect(hubDelivery({ kind: 'not-text' })).toBe('rejected');
  });

  it('★ status 를 모르는 http 는 미정으로 치지 않는다 — 근거 없이 기다리게 된다', () => {
    expect(hubDelivery({ kind: 'http', status: undefined })).toBe('rejected');
  });
});

describe('★★ 회당 타임아웃과 작업 예산은 짝이다', () => {
  it('예산이 회당 타임아웃보다 크다 — 작으면 예산이 먼저 끊어 상향이 무의미해진다', () => {
    expect(WEBSUB_BUDGET_MS).toBeGreaterThan(CALL_TIMEOUT_MS['websub-subscribe']);
  });

  it('★ 예산이 실측 최악 응답(20초)보다 넉넉하다 — 아니면 503 을 받아 보지도 못한다', () => {
    // 20초를 넘기면 허브가 503 을 준다. 그 응답을 **받아서 기록**할 수 있어야
    // 다음 사람이 원인을 손으로 curl 해 찾지 않는다.
    expect(CALL_TIMEOUT_MS['websub-subscribe']).toBeGreaterThan(20_000);
  });

  it('★★ 스윕 한 바퀴가 **설계 상한 채널 수**로도 주기 안에 끝난다', () => {
    // ★ 2(지금 배포의 수)로 단언하면 계약이 아니라 현황을 고정한다. 스윕은 순차라
    //   실제 불변식은 `예산 × N < 주기` 이고, N 의 계약값은 `MAX_YOUTUBE_CHANNELS` 다.
    //   넘기면 다음 틱이 앞 틱과 겹쳐 재진입 가드에 접히고 갱신이 조용히 굶는다.
    expect(WEBSUB_BUDGET_MS * MAX_YOUTUBE_CHANNELS).toBeLessThan(WEBSUB_SWEEP_SEC * 1_000);
  });
});
