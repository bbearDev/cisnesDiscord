import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  createWebServer,
  MAX_BODY_BYTES,
  SECURITY_HEADERS,
  type Route,
} from '../../src/web/server.js';
import { createHealthRoute, evaluateHealth, HEARTBEAT_STALE_MS } from '../../src/web/routes/health.js';
import { ManualClock, systemClock } from '../../src/runtime/clock.js';

/**
 * 웹 서버 골격 (계획 §S3 · §5.4).
 *
 * ★ 이 파일은 **포트를 한 번도 열지 않는다.** 핸들러를 export 한 것이
 *   그것을 가능하게 한 설계이고, 여기서 그 사실을 고정한다.
 *   포트를 실제로 여는 검증은 `test/integration/bind-retry.test.ts` 가 맡는다.
 */

interface Captured {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
}

/** 포트 없이 핸들러를 호출한다 */
function call(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  init: { method?: string; url?: string; headers?: Record<string, string>; body?: string | Buffer },
): Promise<Captured> {
  const bodyBuf =
    init.body === undefined
      ? Buffer.alloc(0)
      : Buffer.isBuffer(init.body)
        ? init.body
        : Buffer.from(init.body);

  // ★ `destroy` 를 덮어쓰지 않는다. 비동기 이터레이터가 순회를 마칠 때 그것을
  //   부르므로, 아무것도 하지 않는 스텁으로 바꾸면 `for await` 이 영영 끝나지 않는다.
  const req = Readable.from(bodyBuf.length > 0 ? [bodyBuf] : []) as unknown as IncomingMessage;
  Object.assign(req, {
    method: init.method ?? 'GET',
    url: init.url ?? '/',
    headers: init.headers ?? {},
  });

  return new Promise<Captured>((resolve) => {
    const out: Captured = { status: 0, headers: {}, body: '' };
    const res = {
      headersSent: false,
      writeHead(status: number, headers: Record<string, string | string[]>) {
        out.status = status;
        out.headers = headers;
        (this as { headersSent: boolean }).headersSent = true;
        return this;
      },
      end(chunk?: string | Buffer) {
        if (chunk !== undefined) out.body += chunk.toString();
        resolve(out);
      },
    } as unknown as ServerResponse;

    handler(req, res);
  });
}

const echo: Route = {
  method: 'POST',
  path: '/echo',
  handle: (req) => ({ status: 200, body: JSON.stringify({ size: req.body.length }) }),
};

const ping: Route = {
  method: 'GET',
  path: '/ping',
  handle: () => ({ status: 200, body: '{"ok":true}' }),
};

describe('web/server — 보안 헤더', () => {
  it('★ 모든 응답에 no-referrer · CSP default-src none · no-store · nosniff 가 붙는다', async () => {
    const web = createWebServer({ routes: [ping] });
    const res = await call(web.handler, { url: '/ping' });

    expect(res.status).toBe(200);
    expect(res.headers['Referrer-Policy']).toBe('no-referrer');
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(String(res.headers['Content-Security-Policy'])).toContain("default-src 'none'");
  });

  it('404·405·500 같은 오류 응답에도 같은 헤더가 붙는다', async () => {
    // 헤더를 성공 경로에만 붙이면 정확히 오류 페이지에서 리퍼러가 샌다.
    const boom: Route = {
      method: 'GET',
      path: '/boom',
      handle: () => {
        throw new Error('내부 사정');
      },
    };
    const web = createWebServer({ routes: [ping, boom] });

    for (const [url, status] of [
      ['/nope', 404],
      ['/boom', 500],
    ] as const) {
      const res = await call(web.handler, { url });
      expect(res.status).toBe(status);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
        expect(res.headers[k]).toBe(v);
      }
    }
  });

  it('500 응답에 내부 사유를 싣지 않는다', async () => {
    const boom: Route = {
      method: 'GET',
      path: '/boom',
      handle: () => {
        throw new Error('/home/opencode/secret/path 에서 실패');
      },
    };
    const logged: string[] = [];
    const web = createWebServer({ routes: [boom], onLog: (m, extra) => logged.push(`${m} ${JSON.stringify(extra)}`) });

    const res = await call(web.handler, { url: '/boom' });
    expect(res.body).not.toContain('/home/opencode');
    // 자세한 것은 로그로만 간다.
    expect(logged.join('\n')).toContain('/home/opencode');
  });
});

describe('web/server — 라우팅', () => {
  it('등록되지 않은 경로는 404, 메서드만 다르면 405 로 구분한다', async () => {
    const web = createWebServer({ routes: [ping, echo] });
    expect((await call(web.handler, { url: '/none' })).status).toBe(404);
    expect((await call(web.handler, { url: '/ping', method: 'POST' })).status).toBe(405);
    expect((await call(web.handler, { url: '/echo', method: 'GET' })).status).toBe(405);
  });

  it('HEAD 는 GET 라우트를 타되 본문을 싣지 않는다', async () => {
    const web = createWebServer({ routes: [ping] });
    const res = await call(web.handler, { url: '/ping', method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.body).toBe('');
    expect(res.headers['Referrer-Policy']).toBe('no-referrer');
  });

  it('쿼리스트링이 있어도 경로로만 매칭한다', async () => {
    const web = createWebServer({ routes: [ping] });
    expect((await call(web.handler, { url: '/ping?hub.challenge=abc' })).status).toBe(200);
  });
});

describe('web/server — MAX_BODY_BYTES', () => {
  it('상한 안의 본문은 그대로 통과한다', async () => {
    const web = createWebServer({ routes: [echo] });
    const body = 'x'.repeat(1024);
    const res = await call(web.handler, { url: '/echo', method: 'POST', body });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ size: 1024 });
  });

  it('★ Content-Length 로 선언된 초과 본문은 한 바이트도 읽지 않고 413 이다', async () => {
    const web = createWebServer({ routes: [echo] });
    const res = await call(web.handler, {
      url: '/echo',
      method: 'POST',
      headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
      body: 'x',
    });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: 'payload_too_large' });
  });

  it('★ 길이를 선언하지 않아도 누적 검사가 잡는다 (선언 값을 믿지 않는다)', async () => {
    const web = createWebServer({ routes: [echo] });
    const res = await call(web.handler, {
      url: '/echo',
      method: 'POST',
      body: Buffer.alloc(MAX_BODY_BYTES + 1, 0x61),
    });
    expect(res.status).toBe(413);
  });
});

describe('web/routes/health — GET /healthz', () => {
  const START = Date.parse('2026-09-07T00:00:00.000Z');

  function deps(overrides: { ageMs?: number | undefined; version?: number | undefined }) {
    const clock = new ManualClock(START);
    return {
      clock,
      heartbeatPath: '/tmp/does-not-matter',
      schemaVersion: () => overrides.version,
      mtimeMs: () => (overrides.ageMs === undefined ? undefined : START - overrides.ageMs),
    };
  }

  it('하트비트가 신선하고 스키마가 적용돼 있으면 200 ok', () => {
    const out = evaluateHealth(deps({ ageMs: 5_000, version: 1 }));
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ status: 'ok', heartbeatAgeSec: 5, schemaVersion: 1 });
  });

  it('★ 하트비트가 낡으면 503 이다 — 200 으로 내용만 바꾸면 감시자가 놓친다', () => {
    expect(evaluateHealth(deps({ ageMs: HEARTBEAT_STALE_MS - 1, version: 1 })).status).toBe(200);
    expect(evaluateHealth(deps({ ageMs: HEARTBEAT_STALE_MS, version: 1 })).status).toBe(503);
  });

  it('하트비트 파일이 없으면 나이가 null 이고 degraded 다', () => {
    const out = evaluateHealth(deps({ ageMs: undefined, version: 1 }));
    expect(out.status).toBe(503);
    expect(out.body.heartbeatAgeSec).toBeNull();
  });

  it('★ DB 가 아직 안 열렸거나 마이그레이션 전이면 degraded 다', () => {
    // 응답만 하는 프로세스는 살아 있는 게 아니다.
    expect(evaluateHealth(deps({ ageMs: 1_000, version: undefined })).status).toBe(503);
    expect(evaluateHealth(deps({ ageMs: 1_000, version: 0 })).status).toBe(503);
  });

  it('시계가 뒤로 가도 나이가 음수가 되지 않는다', () => {
    const out = evaluateHealth(deps({ ageMs: -60_000, version: 1 }));
    expect(out.body.heartbeatAgeSec).toBe(0);
    expect(out.status).toBe(200);
  });

  describe('mtime 을 주입하지 않으면 실제 파일을 본다', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'cisnes-health-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('막 쓴 하트비트 파일은 신선하다', () => {
      const path = join(dir, 'heartbeat');
      writeFileSync(path, `${new Date().toISOString()}\n`, 'utf-8');
      const out = evaluateHealth({
        heartbeatPath: path,
        clock: systemClock,
        schemaVersion: () => 1,
      });
      expect(out.status).toBe(200);
      expect(out.body.heartbeatAgeSec).toBeLessThan(5);
    });

    it('파일이 없으면 던지지 않고 degraded 다 (볼륨이 빠져도 응답은 나온다)', () => {
      const out = evaluateHealth({
        heartbeatPath: join(dir, '없는파일'),
        clock: systemClock,
        schemaVersion: () => 1,
      });
      expect(out.status).toBe(503);
      expect(out.body.heartbeatAgeSec).toBeNull();
    });
  });

  it('라우트로 꽂으면 /healthz 가 JSON 을 낸다', async () => {
    const web = createWebServer({ routes: [createHealthRoute(deps({ ageMs: 1_000, version: 1 }))] });
    const res = await call(web.handler, { url: '/healthz' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: 'ok', schemaVersion: 1 });
    expect(res.headers['Cache-Control']).toBe('no-store');
  });
});
