// 출처: chzzkbot src/web/server.ts (골격 그대로 — 라우트 표와 EADDRINUSE 재시도 정책을
//       이 저장소의 것으로 교체했다. 계획 §14 · Principle 5 "차용은 복사한다")
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * 웹 서버 — `node:http` 단일 서버 (계획 §5.4 D1 · §S3).
 *
 * ★ 프레임워크를 넣지 않는다. 인입이 넷뿐이고(§5.4 표) 전부 단순 GET/POST 다.
 *   express 를 넣으면 의존성 트리와 함께 **미들웨어 순서**라는 새 실패 모드가
 *   따라온다 — 이 규모에서 그 교환은 손해다.
 *
 * ★ **핸들러를 export 한다.** 테스트가 포트를 열지 않고도 요청을 넣을 수 있어야 하고,
 *   실제로 포트를 열어 돌려보는 테스트(EADDRINUSE)도 있어야 한다. 둘 다 같은 함수를 탄다.
 *
 * ★ **바인드 주소는 계약이다.** 기본 `127.0.0.1` 이고 기동 로그에 **실제 바인드
 *   주소를 찍는다.** 계획 §5.4 rev.5 가 못 박은 그대로다 —
 *   *"우연히 같아지는 것과 계약으로 같은 것은 다르다."*
 *   상류가 마침 루프백에 붙는다는 사실은 우리 요건의 근거가 되지 못한다.
 */

// ══════════════════════════════════════════════════════════════════
//  공통 응답 규약
// ══════════════════════════════════════════════════════════════════

/**
 * 모든 응답에 붙는 보안 헤더.
 *
 * ★ `Referrer-Policy: no-referrer` 가 여기서 제일 중요하다. OAuth 콜백 URL 에는
 *   `?code=` 가 붙어 있고, 그 페이지에서 밖으로 나가는 요청에 리퍼러가 실리면
 *   **인가 코드가 제3자 로그에 남는다** (S4 가 이 헤더 위에 올라간다).
 * ★ CSP 는 `default-src 'none'`. 우리가 내보내는 것은 JSON 과 최소 HTML 뿐이라
 *   조일 수 있고, 조여 두면 나중에 누가 스크립트를 얹는 순간 브라우저가 막는다.
 * ★ `no-store` — 상태·콜백 응답이 공용 브라우저 캐시나 프록시에 남으면 안 된다.
 * ★ `nosniff` — JSON 을 HTML 로 해석시키려는 시도를 막는다.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
});

/**
 * 요청 본문 상한.
 *
 * ★ 상한 없이 스트림을 다 읽으면 요청 하나로 메모리를 채울 수 있다.
 *   우리가 받는 가장 큰 본문은 WebSub 푸시(유튜브 Atom 축약 피드)이고 수 KB 다.
 *   64KB 면 그 열 배가 넘으므로 정상 트래픽을 자르지 않으면서 상한 역할을 한다.
 */
export const MAX_BODY_BYTES = 64 * 1024;

export interface RouteRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: IncomingHttpHeaders;
  /**
   * 본문. **서버가 이미 `MAX_BODY_BYTES` 상한을 강제한 뒤**라 라우트는 크기를
   * 다시 보지 않아도 된다 — 상한을 라우트마다 두면 새 라우트가 그걸 빠뜨린다.
   * GET/HEAD 에서는 빈 Buffer.
   */
  readonly body: Buffer;
}

export interface RouteResponse {
  status: number;
  /** 기본 `application/json; charset=utf-8` */
  contentType?: string;
  body: string;
  /** 보안 헤더에 더할 것 (`Set-Cookie` 등). 보안 헤더를 덮어쓰지 않는다 */
  headers?: Record<string, string | string[]>;
}

export interface Route {
  /** `GET` 는 `HEAD` 도 함께 받는다 */
  method: 'GET' | 'POST';
  /** 정확히 일치하는 경로 하나. 패턴 매칭을 두지 않는다 — 인입이 넷뿐이다 */
  path: string;
  handle(req: RouteRequest): RouteResponse | Promise<RouteResponse>;
}

export interface WebServerOptions {
  /**
   * 이 서버가 아는 경로의 전부. 표에 없는 경로는 404 다.
   *
   * ★ 화이트리스트다. 공개 표면과 봇 로직이 한 주소 공간에 있으므로(§5.4 D1 Cons)
   *   "등록된 것만 연다" 가 격리의 한 축이다.
   */
  routes: readonly Route[];
  onLog?: (message: string, extra?: Record<string, unknown>) => void;
}

export interface WebServer {
  /** `http.createServer` 에 그대로 넘길 수 있는 핸들러 — 포트 없이 테스트할 수 있다 */
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** 한 번만 시도한다. EADDRINUSE 재시도는 `listenWithRetry` 가 맡는다 */
  listen(port: number, host?: string): Promise<BoundAddress>;
  close(): Promise<void>;
  readonly server: Server;
}

/** 실제로 열린 주소. **기동 로그에 이걸 찍는다** (§5.4 rev.5) */
export interface BoundAddress {
  address: string;
  port: number;
}

// ══════════════════════════════════════════════════════════════════
//  본문 읽기
// ══════════════════════════════════════════════════════════════════

/** 상한을 넘었으면 `undefined`. 호출부가 413 을 낸다 */
async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  // ★ 선언된 길이부터 본다. 스트림을 한 바이트도 안 읽고 거를 수 있으면 그게 제일 싸다.
  //   다만 이걸 **믿지는 않는다** — 아래 누적 검사가 진짜 방어다.
  const declared = Number.parseInt(req.headers['content-length'] ?? '', 10);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return undefined;

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

// ══════════════════════════════════════════════════════════════════
//  서버
// ══════════════════════════════════════════════════════════════════

export function createWebServer(opts: WebServerOptions): WebServer {
  const log = (message: string, extra?: Record<string, unknown>): void => {
    try {
      opts.onLog?.(message, extra);
    } catch {
      /* 로그가 응답을 죽이면 안 된다 (Principle 2) */
    }
  };

  function send(res: ServerResponse, out: RouteResponse, headOnly: boolean): void {
    res.writeHead(out.status, {
      'Content-Type': out.contentType ?? 'application/json; charset=utf-8',
      ...SECURITY_HEADERS,
      ...(out.headers ?? {}),
    });
    // HEAD 는 본문을 싣지 않는다. 헤더는 GET 과 같아야 한다.
    res.end(headOnly ? undefined : out.body);
  }

  function problem(status: number, detail: string): RouteResponse {
    // ★ 사유를 자세히 싣지 않는다. 내부 경로·스택이 밖으로 나가면 그 자체가 정보 노출이다.
    return { status, body: JSON.stringify({ error: detail }) };
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    // ★ 프라미스를 밖으로 내보내지 않는다. 여기서 새면 요청 하나가
    //   unhandled rejection 으로 프로세스를 흔든다.
    void (async (): Promise<void> => {
      try {
        // host 는 상대 경로를 파싱하기 위한 더미다 — 신뢰하지 않는다.
        const url = new URL(req.url ?? '/', 'http://localhost');
        const method = req.method ?? 'GET';
        const headOnly = method === 'HEAD';
        const lookup = headOnly ? 'GET' : method;

        const route = opts.routes.find((r) => r.path === url.pathname && r.method === lookup);
        if (route === undefined) {
          // 경로는 있는데 메서드가 다르면 405, 아예 없으면 404.
          // 둘을 구분하는 편이 운영자에게 훨씬 빠른 단서다.
          const known = opts.routes.some((r) => r.path === url.pathname);
          send(res, problem(known ? 405 : 404, known ? 'method_not_allowed' : 'not_found'), headOnly);
          return;
        }

        let body: Buffer = Buffer.alloc(0);
        if (lookup === 'POST') {
          const read = await readBody(req);
          if (read === undefined) {
            log('요청 본문이 상한을 넘었습니다', {
              path: url.pathname,
              maxBodyBytes: MAX_BODY_BYTES,
            });
            // ★ 응답을 먼저 보내고 그 다음에 연결을 끊는다. 순서가 반대면
            //   보내는 쪽은 413 을 못 보고 "그냥 끊겼다" 로만 안다.
            send(res, problem(413, 'payload_too_large'), false);
            req.destroy();
            return;
          }
          body = read;
        }

        const out = await route.handle({ method, url, headers: req.headers, body });
        send(res, out, headOnly);
      } catch (e: unknown) {
        log('요청 처리 중 예외', { detail: e instanceof Error ? e.message : String(e) });
        if (!res.headersSent) {
          send(res, problem(500, 'internal_error'), false);
        } else {
          res.end();
        }
      }
    })();
  };

  const server = createServer(handler);

  return {
    handler,
    server,
    listen: (port, host = DEFAULT_BIND_ADDRESS) => listenOnce(server, port, host),
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
        // ★ keep-alive 로 놀고 있는 연결을 끊는다. 안 끊으면 `close` 가 그 연결이
        //   스스로 끝나기를 기다려 **정상 종료가 무기한 늦어진다**. 처리 중인
        //   요청은 건드리지 않는다 — 원장 claim 중에 끊으면 그게 누락이 된다.
        server.closeIdleConnections();
      });
    },
  };
}

// ══════════════════════════════════════════════════════════════════
//  ★ EADDRINUSE — 포트 바인드가 상호배제의 1차 프리미티브다 (계획 §5.4 rev.3)
// ══════════════════════════════════════════════════════════════════

/**
 * 기본 바인드 주소.
 *
 * ★ 이것이 격리의 전부다. 공개해야 하는 것은 OAuth 콜백과 WebSub 수신 둘뿐이고
 *   그 둘은 리버스 프록시가 종단한다. `0.0.0.0` 으로 열면 웹훅 수신구와
 *   `/healthz` 가 인터넷에 그대로 노출된다.
 */
export const DEFAULT_BIND_ADDRESS = '127.0.0.1';

/**
 * ★ **새 종료 코드를 만들지 않는다.** 78(EX_CONFIG)을 재사용한다.
 *
 *   새 코드를 만들면 `deploy/systemd/cisnesdiscord.service` 의
 *   `RestartPreventExitStatus=78 70` 을 함께 고쳐야 하고, **그 한 줄을 빠뜨리면
 *   무한 재시작 플래핑이 정확히 되살아난다** (계획 §5.4 rev.3 보강).
 *   이미 목록에 있는 코드를 쓰면 그 실수의 자리가 없다.
 */
export const BIND_ERROR_EXIT_CODE = 78;

/**
 * 백오프 1s → 2s → 4s → 8s → 8s… (계획 §5.4).
 *
 * 즉시 포기하면 정상 종료 중인 앞 인스턴스를 못 기다리고, 무한 재시도하면
 * 남의 프로세스가 잡았을 때 영영 안 끝난다. **일시적/영구를 시간으로 가른다.**
 */
export const BIND_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];

/** 재시도 창을 넘겨도 포트가 안 풀렸다 — 일시적이 아니다 */
export class BindInUseError extends Error {
  readonly exitCode = BIND_ERROR_EXIT_CODE;
  readonly address: string;
  readonly port: number;
  readonly waitedMs: number;
  readonly attempts: number;

  constructor(address: string, port: number, waitedMs: number, attempts: number) {
    super(`포트 ${address}:${String(port)} 를 ${String(Math.round(waitedMs / 1000))}초 동안 잡지 못했습니다`);
    this.name = 'BindInUseError';
    this.address = address;
    this.port = port;
    this.waitedMs = waitedMs;
    this.attempts = attempts;
  }

  /** stderr 로 내보낼 사람이 읽는 형태. **범인을 찾는 명령을 함께 싣는다** (§5.4) */
  format(): string {
    const bar = '═'.repeat(64);
    return (
      `\n${bar}\n 포트 점유 — 봇을 기동할 수 없습니다\n${bar}\n\n` +
      `  원인: ${this.message} (시도 ${String(this.attempts)}회)\n` +
      '  뜻: 이미 다른 프로세스가 이 포트를 듣고 있습니다. 리스닝 소켓은 커널이\n' +
      '      강제하는 상호배제라, 이 상태로는 두 번째 인스턴스가 뜰 수 없습니다.\n\n' +
      '  점유한 프로세스를 찾으십시오:\n' +
      `    ss -ltnp | grep :${String(this.port)}\n\n` +
      `  종료 코드 ${String(this.exitCode)} 로 끝냅니다 — systemd 가 재시작하지 않습니다\n` +
      '  (RestartPreventExitStatus=78 70). 원인을 고친 뒤 직접 기동하십시오.\n' +
      `${bar}\n`
    );
  }
}

function listenOnce(server: Server, port: number, host: string): Promise<BoundAddress> {
  return new Promise<BoundAddress>((resolve, reject) => {
    const onError = (e: unknown): void => {
      server.removeListener('listening', onListening);
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      const addr = server.address();
      resolve(
        typeof addr === 'object' && addr !== null
          ? { address: addr.address, port: addr.port }
          : { address: host, port },
      );
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function isAddrInUse(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE';
}

export interface ListenRetryOptions {
  port: number;
  host?: string;
  /** 설정 `startup.bindRetrySec`. 기본 30초 = systemd `TimeoutStopSec` */
  retrySec?: number;
  /** 테스트 주입점 — 실제로 30초를 기다리지 않기 위해 */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onRetry?: (info: { attempt: number; waitMs: number; elapsedMs: number }) => void;
  /** 실제 바인드 주소를 기동 로그에 남긴다 (§5.4 rev.5 — "계약으로 같은 것") */
  onBound?: (addr: BoundAddress) => void;
}

/**
 * 포트를 잡는다. **기동 순서 1단계** — PID 락(2)과 DB 열기(3)보다 먼저다.
 *
 * ★ 이 순서를 바꾸지 않는다 (계획 §5.4 rev.3).
 *   chzzkbot 의 락은 **죽은 PID 의 락을 인수한다** — 그렇게 하지 않으면 크래시
 *   한 번에 사람이 락 파일을 지워야 하기 때문이다. 그래서 좀비가 포트를 붙들고
 *   있으면 **락 인수는 성공하고 `listen` 이 EADDRINUSE 로 실패**한다.
 *   포트를 먼저 잡으면 그 상태가 애초에 만들어지지 않는다.
 */
export async function listenWithRetry(
  web: WebServer,
  opts: ListenRetryOptions,
): Promise<BoundAddress> {
  const host = opts.host ?? DEFAULT_BIND_ADDRESS;
  const retrySec = opts.retrySec ?? 30;
  const windowMs = retrySec * 1_000;
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ??
    ((ms: number): Promise<void> =>
      new Promise((r) => {
        setTimeout(r, ms).unref();
      }));

  const start = now();
  let attempt = 0;

  for (;;) {
    try {
      const bound = await web.listen(opts.port, host);
      opts.onBound?.(bound);
      return bound;
    } catch (e: unknown) {
      // EADDRINUSE 가 아니면 재시도할 이유가 없다 (EACCES 는 기다려도 안 풀린다).
      if (!isAddrInUse(e)) throw e;

      const elapsed = now() - start;
      if (elapsed >= windowMs) {
        throw new BindInUseError(host, opts.port, elapsed, attempt + 1);
      }

      // 마지막 값(8초)을 계속 쓴다. 남은 창보다 길게 자지 않는다 —
      // 그러면 창을 넘겨 놓고도 한 번 더 시도할 기회를 잃는다.
      const step = BIND_BACKOFF_MS[Math.min(attempt, BIND_BACKOFF_MS.length - 1)] ?? 8_000;
      const waitMs = Math.min(step, windowMs - elapsed);
      attempt += 1;
      opts.onRetry?.({ attempt, waitMs, elapsedMs: elapsed });
      await sleep(waitMs);
    }
  }
}
