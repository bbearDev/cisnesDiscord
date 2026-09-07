import { statSync } from 'node:fs';

import type { Clock } from '../../runtime/clock.js';
import { HEARTBEAT_INTERVAL_MS } from '../../runtime/heartbeat.js';
import type { Route, RouteResponse } from '../server.js';

/**
 * `GET /healthz` — 하트비트 나이 + DB 스키마 버전 (계획 §S3).
 *
 * ★ 두 값을 함께 내는 이유. "프로세스가 살아 있는가"와 "그 프로세스가 쓸 수 있는
 *   DB 위에 서 있는가"는 다른 질문이고, 둘 중 하나만 보면 진단이 갈린다 —
 *   마이그레이션이 안 끝난 채로 응답만 하는 프로세스는 살아 있는 게 아니다.
 *
 * ★ **이 경로는 공개하지 않는다.** 리버스 프록시 화이트리스트에 없다
 *   (`deploy/reverse-proxy.example.conf` — 공개는 OAuth 콜백과 WebSub 둘뿐).
 *   그래도 내부 정보를 최소로만 싣는다: 스키마 버전과 초 단위 나이뿐이고
 *   경로·PID·설정은 싣지 않는다.
 *
 * ★ 프로세스 **밖**의 감시자(systemd 타이머 워치독, §S8)가 같은 하트비트 파일을
 *   본다. 이쪽만으로는 프로세스가 통째로 죽은 경우를 알 수 없다 — 그때는
 *   이 응답 자체가 없어지기 때문이다 (dead-man's-switch).
 */

/**
 * 이만큼 갱신이 없으면 `degraded`.
 *
 * ← `HEARTBEAT_INTERVAL_MS`(30초) × 3. **두 번까지의 누락은 정상으로 본다** —
 * 디스크가 잠깐 느린 것과 하트비트 루프가 멈춘 것을 가르는 값이고, 1배로 잡으면
 * 정상 지터가 곧바로 빨간불이 된다. 상수를 따로 박지 않고 주기에서 유도한다
 * (계획 §2-b — "정의 복제가 7분/8분 분기의 원인이었다").
 */
export const HEARTBEAT_STALE_MS = HEARTBEAT_INTERVAL_MS * 3;

export interface HealthDeps {
  /** 설정 `paths.heartbeat` */
  heartbeatPath: string;
  clock: Clock;
  /**
   * 적용된 최신 스키마 버전 (`store/migrate.ts` 의 `currentVersion`).
   * DB 가 아직 안 열렸으면 `undefined` — 그 상태는 `degraded` 다.
   */
  schemaVersion: () => number | undefined;
  /** 테스트 주입점. 기본은 `statSync().mtimeMs` */
  mtimeMs?: (path: string) => number | undefined;
}

export interface HealthBody {
  status: 'ok' | 'degraded';
  /** 하트비트 파일이 없으면 null */
  heartbeatAgeSec: number | null;
  schemaVersion: number | null;
  at: string;
}

function defaultMtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    // 파일이 없다 = 아직 한 번도 안 뛰었거나 볼륨이 빠졌다. 둘 다 degraded 다.
    return undefined;
  }
}

export function evaluateHealth(deps: HealthDeps): { status: number; body: HealthBody } {
  const stat = deps.mtimeMs ?? defaultMtimeMs;
  const mtime = stat(deps.heartbeatPath);
  const now = deps.clock.now();

  // ★ 음수 나이(미래 mtime)는 0 으로 접는다. 시계가 뒤로 갔을 때 "-3초 전이라
  //   신선하다" 가 되는 것을 막는다 — 나이를 신선도 판정에 쓰는 이상 부호가 있으면 안 된다.
  const ageMs = mtime === undefined ? undefined : Math.max(0, now - mtime);
  const version = deps.schemaVersion();

  const fresh = ageMs !== undefined && ageMs < HEARTBEAT_STALE_MS;
  const ready = version !== undefined && version > 0;
  const ok = fresh && ready;

  return {
    // 503 을 주는 것이 핵심이다. 200 으로 내용만 바꾸면 감시자가 본문을 파싱해야
    // 하고, 파싱을 빠뜨린 감시자는 장애를 정상으로 읽는다.
    status: ok ? 200 : 503,
    body: {
      status: ok ? 'ok' : 'degraded',
      heartbeatAgeSec: ageMs === undefined ? null : Math.round(ageMs / 1000),
      schemaVersion: version ?? null,
      at: deps.clock.date().toISOString(),
    },
  };
}

export function createHealthRoute(deps: HealthDeps): Route {
  return {
    method: 'GET',
    path: '/healthz',
    handle(): RouteResponse {
      const out = evaluateHealth(deps);
      return { status: out.status, body: JSON.stringify(out.body) };
    },
  };
}
