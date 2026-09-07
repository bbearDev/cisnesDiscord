// 출처: chzzkbot src/runtime/logger.ts (그대로 — 계획 §14)
import { mkdirSync } from 'node:fs';
import pino, { type Logger, type DestinationStream } from 'pino';

import { redactDeep, redactString } from './redact.js';

/**
 * 구조화 로거 (AC-32).
 *
 * 요구:
 *   - pino JSON, 일 1회 로테이션, 14일 보관
 *   - 봇 토큰 · 웹훅 URL · `LIVE_API_TOKEN` 이 원문으로 남지 않는다
 *   - 로그 산출물 전체를 정규식으로 훑는 observability 테스트가 그 사실을 고정한다
 *
 * ★ 마스킹을 pino 의 redact(경로 기반)에만 맡기지 않는다.
 *   경로 기반은 "미리 알고 있는 필드" 만 가린다. chzzkbot 응답 스키마가 바뀌거나
 *   개발자가 err.message 에 토큰을 끼워 넣으면 그대로 샌다.
 *   그래서 logMethod 훅에서 인자 전체를 redactDeep 으로 훑는다 — 값의 모양까지 본다.
 */

export interface LoggerOptions {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  /** 로그 디렉터리. destination 을 직접 주면 무시된다 */
  dir?: string;
  retentionDays?: number;
  /** 테스트에서 출력을 가로채기 위해 주입 */
  destination?: DestinationStream;
}

/** 미리 아는 필드는 경로로도 막아 둔다 (두 그물 중 첫 번째). */
const REDACT_PATHS = [
  'botToken',
  'accessToken',
  'refreshToken',
  'clientSecret',
  'client_secret',
  'authorization',
  'Authorization',
  'headers.authorization',
  'headers.Authorization',
  // chzzkbot 계약이 쓰는 헤더 이름. 이 값이 곧 LIVE_API_TOKEN 이다.
  'headers["x-chzzkbot-token"]',
  'webhookUrl',
  'liveApiToken',
  'liveEventWebhookToken',
  '*.accessToken',
  '*.refreshToken',
  '*.clientSecret',
  '*.botToken',
];

export function createLogger(opts: LoggerOptions): Logger {
  const base: pino.LoggerOptions = {
    level: opts.level,
    redact: { paths: REDACT_PATHS, censor: '***' },
    hooks: {
      // 인자 전체를 값 기준으로 한 번 더 훑는다.
      logMethod(args, method) {
        const scrubbed = args.map((a) => (typeof a === 'string' ? redactString(a) : redactDeep(a)));
        method.apply(this, scrubbed as Parameters<typeof method>);
      },
    },
  };

  if (opts.destination) return pino(base, opts.destination);

  const dir = opts.dir ?? 'data/logs';
  mkdirSync(dir, { recursive: true });

  const transport = pino.transport({
    target: 'pino-roll',
    options: {
      file: `${dir}/cisnes`,
      frequency: 'daily',
      extension: '.log',
      mkdir: true,
      limit: { count: opts.retentionDays ?? 14 },
      dateFormat: 'yyyy-MM-dd',
    },
  }) as DestinationStream;

  return pino(base, transport);
}
