import { describe, it, expect } from 'vitest';
import type { DestinationStream } from 'pino';

import { createLogger } from '../../src/runtime/logger.js';

/**
 * 로그 마스킹 (AC-32 · 계획 §9.4 마지막 행).
 *
 *   "전 로그 캡처해 토큰·웹훅 URL·**LIVE_API_TOKEN** 형태 0건"
 *
 * ★ 이 계층이 따로 있는 이유. `redact.test.ts` 는 함수를 판정하고 여기는 **배선**을
 *   판정한다. 마스킹 함수가 완벽해도 로거가 그것을 부르지 않으면 아무 소용이 없고,
 *   그 배선은 함수 테스트로는 절대 드러나지 않는다.
 */

// secrets-scan: 의도적 표본 — 지어낸 값이다. 실제 토큰 앞부분을 복사하면 그 자체가 유출이다
const FAKE_BOT_TOKEN = 'ZmFrZUJvdFRva2VuSWRQYXJ0MDA.ZmFrZTA.ZmFrZUhtYWNQYXJ0MDAwMDAwMDAwMDAw';
// secrets-scan: 의도적 표본
const FAKE_WEBHOOK_URL = 'https://discord.com/api/webhooks/000000000000000000/ZmFrZVdlYmhvb2tUb2tlbjAwMDAwMDAwMDAwMA';
// secrets-scan: 의도적 표본 — LIVE_API_TOKEN 모양(48자 hex)
const FAKE_LIVE_API_TOKEN = 'a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3';

const SECRETS = [FAKE_BOT_TOKEN, FAKE_WEBHOOK_URL, FAKE_LIVE_API_TOKEN];

function capturingLogger(): { logger: ReturnType<typeof createLogger>; output: () => string } {
  const lines: string[] = [];
  const destination: DestinationStream = {
    write(chunk: string): void {
      lines.push(chunk);
    },
  };
  return {
    logger: createLogger({ level: 'trace', destination }),
    output: () => lines.join(''),
  };
}

describe('createLogger — 전 로그에 원문 0건', () => {
  it('★ 알려진 키(경로 그물)에 실린 비밀값이 남지 않는다', () => {
    const { logger, output } = capturingLogger();
    logger.info({ botToken: FAKE_BOT_TOKEN, webhookUrl: FAKE_WEBHOOK_URL }, '기동');
    for (const s of SECRETS) expect(output()).not.toContain(s);
  });

  it('★★ 키 이름이 무해해도 남지 않는다 — 값 모양 그물이 배선돼 있다', () => {
    // 경로 기반 redact 에만 맡기면 여기서 그대로 샌다.
    // 상류 응답 스키마가 바뀌어 새 필드로 토큰이 실려 오는 경우가 정확히 이 모양이다.
    const { logger, output } = capturingLogger();
    logger.warn({ detail: FAKE_LIVE_API_TOKEN, memo: FAKE_BOT_TOKEN }, '조회 실패');
    for (const s of SECRETS) expect(output()).not.toContain(s);
  });

  it('★ 메시지 본문 한가운데 박혀도 남지 않는다 (err.message 대비)', () => {
    const { logger, output } = capturingLogger();
    logger.error(`웹훅 ${FAKE_WEBHOOK_URL} 로 401, 헤더 토큰 ${FAKE_LIVE_API_TOKEN}`);
    for (const s of SECRETS) expect(output()).not.toContain(s);
  });

  it('★ 중첩 객체·배열 안쪽도 훑는다', () => {
    const { logger, output } = capturingLogger();
    logger.info({
      upstream: { headers: { 'x-chzzkbot-token': FAKE_LIVE_API_TOKEN } },
      alerts: [{ url: FAKE_WEBHOOK_URL }],
    });
    for (const s of SECRETS) expect(output()).not.toContain(s);
  });

  it('★ 비밀값이 아닌 것은 그대로 남는다 — 다 가리면 로그가 쓸모없어진다', () => {
    const { logger, output } = capturingLogger();
    logger.info(
      { channelId: 'c3355ea2b3bea6c646789510796379d6', detectedVia: 'webhook' },
      '방송 시작 공지',
    );
    const out = output();
    // 치지직 channelId 는 32자 hex 라 40자 하한에 걸리지 않는다 (공개 식별자다).
    expect(out).toContain('c3355ea2b3bea6c646789510796379d6');
    expect(out).toContain('webhook');
    expect(out).toContain('방송 시작 공지');
  });

  it('레벨 필터가 동작한다', () => {
    const lines: string[] = [];
    const destination: DestinationStream = {
      write(chunk: string): void {
        lines.push(chunk);
      },
    };
    const logger = createLogger({ level: 'warn', destination });
    logger.debug('보이면 안 된다');
    logger.warn('보여야 한다');
    expect(lines.join('')).not.toContain('보이면 안 된다');
    expect(lines.join('')).toContain('보여야 한다');
  });
});
