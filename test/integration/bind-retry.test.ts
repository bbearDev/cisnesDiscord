import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';

import {
  createWebServer,
  listenWithRetry,
  BindInUseError,
  BIND_ERROR_EXIT_CODE,
  DEFAULT_BIND_ADDRESS,
  type Route,
  type WebServer,
} from '../../src/web/server.js';
import { SYSTEMD_TIMEOUT_STOP_SEC } from '../../src/config/schema.js';

/**
 * ★ EADDRINUSE — **포트 바인드가 상호배제의 1차 프리미티브다** (계획 §5.4 rev.3, §9.3).
 *
 * chzzkbot 의 PID 락은 **죽은 PID 의 락을 인수한다** — 그래서 좀비가 포트를 붙들고
 * 있으면 락 인수는 성공하고 `listen` 이 EADDRINUSE 로 실패한다. 그 실패는
 * `RestartPreventExitStatus` 에 걸리지 않아 `Restart=always` 와 만나면
 * **무한 재시작 플래핑**이 된다. 이 파일이 그 결함이 되살아나지 않았음을 고정한다.
 *
 * ★ 실제 소켓을 쓴다. 여기서만은 포트를 연다 — 커널이 강제하는 배제라는 것이
 *   요점이라 흉내로는 판정되지 않는다. 다만 **시간은 주입한다**: 30초를 실제로
 *   기다리면 아무도 이 테스트를 안 돌린다.
 */

const ping: Route = { method: 'GET', path: '/ping', handle: () => ({ status: 200, body: '{}' }) };

let blocker: Server | undefined;
let web: WebServer | undefined;

afterEach(async () => {
  await new Promise<void>((r) => {
    if (blocker === undefined) {
      r();
      return;
    }
    blocker.close(() => {
      r();
    });
  });
  blocker = undefined;
  await web?.close();
  web = undefined;
});

/** 임의 포트를 하나 잡고 그 번호를 돌려준다 — 이 서버가 "범인" 이다 */
function occupy(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, DEFAULT_BIND_ADDRESS, () => {
      s.removeListener('error', reject);
      const addr = s.address();
      resolve({ server: s, port: typeof addr === 'object' && addr !== null ? addr.port : 0 });
    });
  });
}

/** 시간을 주입한다. `sleep` 이 시계를 그만큼 민다 */
function fakeTime() {
  let current = 0;
  const slept: number[] = [];
  return {
    now: () => current,
    slept,
    sleep: (ms: number): Promise<void> => {
      slept.push(ms);
      current += ms;
      return Promise.resolve();
    },
  };
}

describe('listenWithRetry — 포트를 잡지 못했을 때', () => {
  it('★★ 창이 끝날 때까지 안 풀리면 exit 78 로 끝낸다 (새 종료 코드를 만들지 않는다)', async () => {
    const held = await occupy();
    blocker = held.server;
    web = createWebServer({ routes: [ping] });
    const time = fakeTime();

    const err = await listenWithRetry(web, {
      port: held.port,
      retrySec: SYSTEMD_TIMEOUT_STOP_SEC,
      now: time.now,
      sleep: time.sleep,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BindInUseError);
    const bindErr = err as BindInUseError;

    // ★ 78 은 이미 RestartPreventExitStatus 에 있다. 새 코드를 만들면 그 목록을
    //   함께 고쳐야 하고, 그 한 줄을 빠뜨리는 순간 플래핑이 되살아난다.
    expect(bindErr.exitCode).toBe(BIND_ERROR_EXIT_CODE);
    expect(BIND_ERROR_EXIT_CODE).toBe(78);

    // ★ 운영자가 범인을 곧바로 찾을 수 있어야 한다.
    expect(bindErr.format()).toContain(`ss -ltnp | grep :${String(held.port)}`);
    expect(bindErr.port).toBe(held.port);
  });

  it('★ 백오프는 1s → 2s → 4s → 8s → 8s… 이고 창(30초)을 넘지 않는다', async () => {
    const held = await occupy();
    blocker = held.server;
    web = createWebServer({ routes: [ping] });
    const time = fakeTime();

    await listenWithRetry(web, {
      port: held.port,
      retrySec: SYSTEMD_TIMEOUT_STOP_SEC,
      now: time.now,
      sleep: time.sleep,
    }).catch(() => undefined);

    expect(time.slept.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
    // 남은 창보다 길게 자지 않는다 — 그러면 마지막 시도 기회를 잃는다.
    expect(time.slept.reduce((a, b) => a + b, 0)).toBe(SYSTEMD_TIMEOUT_STOP_SEC * 1_000);
  });

  it('★★ 창 안에 점유가 풀리면 정상 기동한다 (일시적/영구를 시간으로 가른다)', async () => {
    const held = await occupy();
    blocker = held.server;
    web = createWebServer({ routes: [ping] });
    const time = fakeTime();
    const bound: { address: string; port: number }[] = [];

    let released = false;
    const addr = await listenWithRetry(web, {
      port: held.port,
      retrySec: SYSTEMD_TIMEOUT_STOP_SEC,
      now: time.now,
      onBound: (a) => bound.push(a),
      sleep: async (ms) => {
        await time.sleep(ms);
        // 앞 인스턴스가 정상 종료를 마쳤다 — 7초쯤 지난 시점.
        if (!released && time.now() >= 7_000) {
          released = true;
          await new Promise<void>((r) => {
            held.server.close(() => {
              r();
            });
          });
          blocker = undefined;
        }
      },
    });

    expect(addr.port).toBe(held.port);
    // ★ 기동 로그에 **실제** 바인드 주소를 찍는다 (§5.4 rev.5 — 계약으로 같은 것).
    expect(bound).toEqual([{ address: DEFAULT_BIND_ADDRESS, port: held.port }]);
  });

  it('EADDRINUSE 가 아닌 오류는 재시도하지 않고 그대로 올린다', async () => {
    web = createWebServer({ routes: [ping] });
    const time = fakeTime();

    // 이 호스트에 없는 주소다 (TEST-NET-3) → EADDRNOTAVAIL. 기다려도 안 풀린다.
    const err = await listenWithRetry(web, {
      port: 0,
      host: '203.0.113.1',
      retrySec: SYSTEMD_TIMEOUT_STOP_SEC,
      now: time.now,
      sleep: time.sleep,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BindInUseError);
    expect(time.slept).toEqual([]);
  });
});

describe('listenWithRetry — 정상 경로', () => {
  it('비어 있는 포트는 첫 시도에 잡고 실제 주소를 알린다', async () => {
    web = createWebServer({ routes: [ping] });
    const bound: { address: string; port: number }[] = [];
    const time = fakeTime();

    const addr = await listenWithRetry(web, {
      port: 0,
      now: time.now,
      sleep: time.sleep,
      onBound: (a) => bound.push(a),
    });

    expect(addr.address).toBe(DEFAULT_BIND_ADDRESS);
    expect(addr.port).toBeGreaterThan(0);
    expect(bound).toEqual([addr]);
    expect(time.slept).toEqual([]);

    // 실제로 응답한다.
    const res = await fetch(`http://${DEFAULT_BIND_ADDRESS}:${String(addr.port)}/ping`);
    expect(res.status).toBe(200);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});
