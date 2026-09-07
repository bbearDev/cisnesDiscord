// 출처: chzzkbot src/runtime/heartbeat.ts (그대로 — 계획 §14)
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Clock, Disposable } from './clock.js';

/**
 * 하트비트 — data/heartbeat (AC-34).
 *
 * 두 감시자가 이 파일 하나를 본다:
 *   ① `GET /healthz` — 하트비트 나이 + DB 버전 (§S3)
 *   ② systemd 타이머 워치독 — 90분 초과면 디스코드 알림 (§S8)
 *
 * ②가 봇 프로세스 **바깥**에 있는 게 핵심이다. 프로세스가 통째로 죽으면
 * ①도 함께 죽으므로, 외부 감시자만 그걸 알아챌 수 있다 (dead-man's-switch).
 *
 * mtime 을 갱신하는 것이 목적이므로 내용은 최소로 둔다.
 */

export const HEARTBEAT_INTERVAL_MS = 30_000;

export interface HeartbeatOptions {
  path: string;
  clock: Clock;
  intervalMs?: number;
  /** 쓰기 실패를 알리되 봇을 죽이지는 않는다 */
  onError?: (err: unknown) => void;
}

export function startHeartbeat(opts: HeartbeatOptions): Disposable {
  const { path, clock } = opts;
  const intervalMs = opts.intervalMs ?? HEARTBEAT_INTERVAL_MS;

  const beat = (): void => {
    try {
      // ★ mkdir 도 try 안에 둔다. 밖에 두면 경로가 나쁠 때 startHeartbeat 가 던져
      //   봇 기동 자체를 막는다 — **부가 기능이 본체를 죽이는 형태**다
      //   (계획 Principle 2). 매 tick 마다 부르는 건 낭비로 보이지만,
      //   볼륨이 잠깐 빠졌다 돌아오는 경우까지 스스로 복구된다는 이득이 있다.
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${clock.date().toISOString()}\n`, 'utf-8');
    } catch (e: unknown) {
      // 디스크가 가득 찼거나 볼륨이 읽기 전용이어도 봇 본체는 계속 돈다.
      // 하트비트가 멈추면 외부 감시자가 알아채는 것이 설계된 동작이다.
      opts.onError?.(e);
    }
  };

  beat(); // 기동 즉시 한 번 — 첫 30초 동안 "낡음" 으로 보이지 않게
  return clock.setInterval(beat, intervalMs);
}
