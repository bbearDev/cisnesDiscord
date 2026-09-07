import { describe, it, expect } from 'vitest';

import { redactDeep, redactString, looksSecret, maskString } from '../../src/runtime/redact.js';

/**
 * 마스킹 검증 (AC-32).
 *
 * 판정 기준은 하나다: **redactDeep 결과에 원문이 0건**.
 * 계획 §S2 수용 기준의 그 문장을 그대로 옮긴 것이고, §9.4 의 "전 로그 캡처해
 * 토큰·웹훅 URL·LIVE_API_TOKEN 형태 0건" 이 이 규칙의 로그 계층 판이다.
 *
 * ★ 아래 값은 전부 **지어낸 것**이다. 실제 토큰 앞부분을 복사하면 그 자체가 유출이다.
 */

// secrets-scan: 의도적 표본 — 마스킹을 검증하려면 가짜 비밀값을 심어야 한다
const FAKE_BOT_TOKEN = 'ZmFrZUJvdFRva2VuSWRQYXJ0MDA.ZmFrZTA.ZmFrZUhtYWNQYXJ0MDAwMDAwMDAwMDAw';
// secrets-scan: 의도적 표본
const FAKE_WEBHOOK_URL = 'https://discord.com/api/webhooks/000000000000000000/ZmFrZVdlYmhvb2tUb2tlbjAwMDAwMDAwMDAwMA';
// secrets-scan: 의도적 표본 — LIVE_API_TOKEN 모양(48자 hex)
const FAKE_LIVE_API_TOKEN = 'a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3';

/** 마스킹 결과 어디에도 원문이 남지 않았는가. */
function containsNone(rendered: string, secrets: readonly string[]): boolean {
  return secrets.every((s) => !rendered.includes(s));
}

describe('redact — 값 모양 그물', () => {
  it('디스코드 봇 토큰 모양을 잡는다', () => {
    expect(looksSecret(FAKE_BOT_TOKEN)).toBe(true);
  });

  it('디스코드 웹훅 URL 을 잡는다', () => {
    expect(looksSecret(FAKE_WEBHOOK_URL)).toBe(true);
  });

  it('48자 hex(LIVE_API_TOKEN 모양)를 잡는다', () => {
    expect(looksSecret(FAKE_LIVE_API_TOKEN)).toBe(true);
  });

  it('★ 32자 hex 채널 id 는 잡지 않는다 — 공개 식별자가 가려지면 로그가 쓸모없어진다', () => {
    // 계획 §8 이 확정한 시스네 채널 id. 정확히 32자다.
    expect(looksSecret('c3355ea2b3bea6c646789510796379d6')).toBe(false);
  });

  it('키 이름 그물 — 값이 평범해도 키가 수상하면 가린다', () => {
    expect(redactString('평범한값입니다요', 'liveApiToken')).not.toBe('평범한값입니다요');
  });
});

describe('redactDeep — 원문 0건', () => {
  const secrets = [FAKE_BOT_TOKEN, FAKE_WEBHOOK_URL, FAKE_LIVE_API_TOKEN];

  it('★ 중첩 객체 어디에 있어도 원문이 남지 않는다', () => {
    const payload = {
      bot: { token: FAKE_BOT_TOKEN },
      alerts: [{ url: FAKE_WEBHOOK_URL }],
      upstream: { headers: { 'x-chzzkbot-token': FAKE_LIVE_API_TOKEN } },
    };
    const rendered = JSON.stringify(redactDeep(payload));
    expect(containsNone(rendered, secrets)).toBe(true);
  });

  it('★ 키 이름이 무해해도 값 모양만으로 잡는다 — 스키마가 바뀌어도 새지 않는다', () => {
    // 이것이 두 번째 그물이 있는 이유다. 이름이 `note` 라 키 그물에는 안 걸린다.
    const payload = { note: FAKE_BOT_TOKEN, memo: FAKE_LIVE_API_TOKEN, link: FAKE_WEBHOOK_URL };
    const rendered = JSON.stringify(redactDeep(payload));
    expect(containsNone(rendered, secrets)).toBe(true);
  });

  it('★ 문장 한가운데 박힌 비밀값도 잡는다 (에러 메시지 대비)', () => {
    const message =
      `조회 실패: 헤더 ${FAKE_LIVE_API_TOKEN} 로 401, ` +
      `웹훅 ${FAKE_WEBHOOK_URL} 도 실패, 봇 토큰 ${FAKE_BOT_TOKEN}`;
    const rendered = redactString(message);
    expect(containsNone(rendered, secrets)).toBe(true);
  });

  it('배열·원시값을 망가뜨리지 않는다', () => {
    expect(redactDeep([1, true, null, '짧은값'])).toEqual([1, true, null, '짧은값']);
  });

  it('maskString 은 길이를 남긴다 — 디버깅에 길이가 자주 필요하다', () => {
    expect(maskString(FAKE_LIVE_API_TOKEN)).toContain(`[len=${String(FAKE_LIVE_API_TOKEN.length)}]`);
    expect(maskString('짧음')).toBe('***');
  });
});
