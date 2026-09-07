import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * 가짜 chzzkbot — **실제 HTTP 서버** (계획 §9.3 하니스 표).
 *
 * 패턴은 chzzkbot `test/e2e/harness/fake-chzzk.ts` 에서 가져왔다(라우팅을 한 곳에
 * 두고 실패 주입 문을 하나만 여는 모양). 다만 상류의 그것은 `HttpClient` 층의
 * 가짜라 **포트가 없다.** 우리는 두 방향을 다 재현해야 한다:
 *
 *   ① chzzkbot → 우리 : 계약대로 `POST /hooks/chzzkbot/live` 웹훅을 쏜다
 *   ② 우리 → chzzkbot : `GET /api/live` 를 답한다
 *
 *   ②가 실제 소켓이어야 하는 이유는 §9.3 의 **"아웃바운드 행 걸림"** 행이다 —
 *   *"가짜 치지직이 응답을 영영 안 줌 → 각 호출이 타임아웃에 끊기고 `unknown` 반환.
 *   이벤트 루프가 살아 있어 다른 기능이 정상 동작"*. 인메모리 더블에는 매달릴
 *   소켓이 없어서 그 판정을 낼 수 없다.
 *
 * ★ 계약 형태는 상류 소스에서 그대로 옮긴 것이다 (`src/live/live-event-payload.ts`,
 *   `src/web/live-api.ts`). **필드명·선택성을 한 글자도 바꾸지 않는다** (계획 §14).
 */

// ══════════════════════════════════════════════════════════════════
//  계약 — 상류 타입 정의 그 자체
// ══════════════════════════════════════════════════════════════════

export const LIVE_EVENT_PAYLOAD_VERSION = 1;

/** 헤더 이름. 상류의 `LIVE_EVENT_TOKEN_HEADER` === `LIVE_API_TOKEN_HEADER` */
export const CHZZKBOT_TOKEN_HEADER = 'x-chzzkbot-token';

/** 상류 `MIN_TOKEN_LENGTH`. 없거나 짧으면 **404** (401 아님 — 존재를 흘리지 않는다) */
export const MIN_TOKEN_LENGTH = 16;

/** `POST /hooks/chzzkbot/live` 로 들어오는 본문 */
export interface LiveStartedEvent {
  event: 'live.started';
  version: number;
  channelId: string;
  channelName?: string;
  /** 치지직 원문 KST, 시간대 표기 없음. ★ `new Date()` 에 넣지 않는다 */
  openDate: string;
  /** ISO-8601 UTC. ★ 시각 계산은 이쪽 */
  openedAt: string;
  /** sha256(`${channelId} ${openDate.trim()}`) 앞 8자 */
  liveHash: string;
  liveId?: number;
  /** ★ 웹훅에만 있다. 폴링 응답에는 없다 */
  liveTitle?: string;
  categoryValue?: string;
  concurrentUserCount?: number;
  detectedAt: string;
}

/** `GET /api/live` 응답 */
export interface LiveApiResponse {
  version: number;
  generatedAt: string;
  channels: LiveApiChannel[];
}

export interface LiveApiChannel {
  channelId: string;
  channelName?: string;
  /** 활성 세션이 있고 `status === 'running'` 일 때만 true */
  live: boolean;
  /** `live && openDate` 로 신원 확보됨 */
  confirmed: boolean;
  openDate?: string;
  openedAt?: string;
  liveHash?: string;
  liveId?: number;
  /** ★ `liveTitle` 칸은 의도적으로 없다 — 상류가 안 싣는다 */
  categoryValue?: string;
  uptimeMs?: number;
  exact: boolean;
  sessionStartedAt?: string;
  status?: string;
  socketState?: string;
}

// ══════════════════════════════════════════════════════════════════
//  픽스처
// ══════════════════════════════════════════════════════════════════

const HERE = dirname(fileURLToPath(import.meta.url));

/** `test/fixtures/` 아래 상대 경로. 예: `chzzkbot/api-live-announce.json` */
export function fixturePath(rel: string): string {
  return join(HERE, '..', '..', 'fixtures', rel);
}

/** 호출부가 계약 타입으로 캐스팅한다 — 하니스는 픽스처를 해석하지 않는다 */
export function loadJsonFixture(rel: string): unknown {
  return JSON.parse(readFileSync(fixturePath(rel), 'utf-8'));
}

export function loadTextFixture(rel: string): string {
  return readFileSync(fixturePath(rel), 'utf-8');
}

// ══════════════════════════════════════════════════════════════════
//  하니스
// ══════════════════════════════════════════════════════════════════

export interface FakeRequestRecord {
  method: string;
  path: string;
  /** 받은 토큰 헤더 (있으면). **값 자체를 단언하지 말고 일치 여부만 본다** */
  token: string | undefined;
  at: number;
}

export interface WebhookPostResult {
  status: number;
  body: string;
  /** 요청을 보내고 응답을 받기까지 걸린 시간 (ms). "2xx 타이밍" 판정 축이다 */
  elapsedMs: number;
}

export interface FakeChzzkbotOptions {
  /** 우리가 `x-chzzkbot-token` 으로 보낼 것과 같은 값 */
  token?: string;
  now?: () => number;
}

export interface FakeChzzkbot {
  /** `http://127.0.0.1:<열린 포트>` — `chzzkbot.baseUrl` 에 그대로 넣는다 */
  readonly baseUrl: string;
  /** 이 서버가 받은 모든 요청 (시간순) */
  readonly requests: readonly FakeRequestRecord[];

  start(): Promise<string>;
  close(): Promise<void>;

  /** `GET /api/live` 가 답할 본문 */
  setLiveResponse(body: unknown): void;
  /** 픽스처로 답한다. 예: `chzzkbot/api-live-announce.json` */
  loadLiveFixture(rel: string): void;
  /** 401 · 404 · 500 등을 강제한다. `undefined` 로 해제 */
  setStatus(status?: number): void;
  /** 응답을 이만큼 늦춘다 */
  setDelayMs(ms: number): void;
  /**
   * ★ **응답을 영영 주지 않는다.** 연결은 열린 채로 둔다 —
   *   호출부의 `AbortSignal` 타임아웃이 실제로 걸려 있는지는 이걸로만 검증된다.
   */
  setHang(on: boolean): void;
  /** 기록을 비운다 */
  reset(): void;

  /** ① 계약대로 웹훅을 쏜다. 받는 쪽 주소를 준다 */
  postLiveStarted(url: string, event: LiveStartedEvent, opts?: PostOptions): Promise<WebhookPostResult>;
  /** 임의 본문(계약 위반 페이로드 등)을 그대로 쏜다 */
  postRaw(url: string, body: string, opts?: PostOptions): Promise<WebhookPostResult>;
}

export interface PostOptions {
  /** 기본은 하니스의 토큰. `null` 을 주면 헤더를 아예 붙이지 않는다 */
  token?: string | null;
  contentType?: string;
}

export function createFakeChzzkbot(opts: FakeChzzkbotOptions = {}): FakeChzzkbot {
  const now = opts.now ?? Date.now;
  const token = opts.token ?? 'a'.repeat(MIN_TOKEN_LENGTH * 2);

  const requests: FakeRequestRecord[] = [];
  /** 매달아 둔 응답 — close 할 때 풀어 준다 */
  const hung = new Set<ServerResponse>();

  let liveBody: unknown = {
    version: LIVE_EVENT_PAYLOAD_VERSION,
    generatedAt: new Date(now()).toISOString(),
    channels: [],
  } satisfies LiveApiResponse;
  let forcedStatus: number | undefined;
  let delayMs = 0;
  let hang = false;
  let server: Server | undefined;
  let baseUrl = '';

  function headerToken(req: IncomingMessage): string | undefined {
    const raw = req.headers[CHZZKBOT_TOKEN_HEADER];
    // 헤더가 중복되면 node 가 배열로 준다. 첫 값만 본다 —
    // 합치면 정상 토큰과 덧붙인 값이 섞인 문자열이 만들어진다 (상류의 같은 규율).
    return Array.isArray(raw) ? raw[0] : raw;
  }

  function json(res: ServerResponse, status: number, body: unknown): void {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(text);
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const got = headerToken(req);
    requests.push({ method: req.method ?? 'GET', path: url.pathname, token: got, at: now() });

    if (url.pathname !== '/api/live') {
      json(res, 404, { error: 'not_found' });
      return;
    }

    // ★ 토큰이 없거나 짧으면 **404** 다 (상류 규칙). 401 을 주면
    //   "여기 뭔가 있다" 가 새고, 그건 이 경로를 안 쓰는 배포에서 열어둘 이유가 없다.
    //   ⚠️ 우리 **수신** 엔드포인트는 401 이다 — 그건 우리 계약이고 이건 상류 것이다.
    if (got === undefined || got.length < MIN_TOKEN_LENGTH || got !== token) {
      json(res, 404, { error: 'not_found' });
      return;
    }

    const respond = (): void => {
      if (forcedStatus !== undefined && forcedStatus >= 400) {
        json(res, forcedStatus, { error: 'forced' });
        return;
      }
      json(res, forcedStatus ?? 200, liveBody);
    };

    if (hang) {
      // 응답을 만들지 않는다. 소켓만 열어 둔다.
      hung.add(res);
      res.on('close', () => hung.delete(res));
      return;
    }
    if (delayMs > 0) {
      setTimeout(respond, delayMs).unref();
      return;
    }
    respond();
  };

  async function post(url: string, body: string, postOpts?: PostOptions): Promise<WebhookPostResult> {
    const headers: Record<string, string> = {
      'Content-Type': postOpts?.contentType ?? 'application/json',
    };
    const t = postOpts?.token === undefined ? token : postOpts.token;
    if (t !== null) headers[CHZZKBOT_TOKEN_HEADER] = t;

    const started = now();
    const res = await fetch(url, { method: 'POST', headers, body });
    const text = await res.text();
    return { status: res.status, body: text, elapsedMs: now() - started };
  }

  return {
    get baseUrl() {
      return baseUrl;
    },
    get requests() {
      return requests;
    },

    start(): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const s = createServer(handler);
        s.once('error', reject);
        // 포트 0 = 임의 포트. 고정 포트를 쓰면 테스트끼리 EADDRINUSE 로 부딪힌다.
        s.listen(0, '127.0.0.1', () => {
          s.removeListener('error', reject);
          const addr = s.address();
          const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
          server = s;
          baseUrl = `http://127.0.0.1:${String(port)}`;
          resolve(baseUrl);
        });
      });
    },

    close(): Promise<void> {
      // ★ 매달아 둔 응답을 먼저 끊는다. 안 그러면 close 가 영영 안 끝난다 —
      //   무응답 주입을 쓴 테스트가 그대로 멈춘다.
      for (const res of hung) res.destroy();
      hung.clear();
      const s = server;
      server = undefined;
      if (s === undefined) return Promise.resolve();
      return new Promise((resolve) => {
        s.closeAllConnections();
        s.close(() => {
          resolve();
        });
      });
    },

    setLiveResponse(body): void {
      liveBody = body;
    },

    loadLiveFixture(rel): void {
      liveBody = loadJsonFixture(rel);
    },

    setStatus(status): void {
      forcedStatus = status;
    },

    setDelayMs(ms): void {
      delayMs = ms;
    },

    setHang(on): void {
      hang = on;
    },

    reset(): void {
      requests.length = 0;
      forcedStatus = undefined;
      delayMs = 0;
      hang = false;
    },

    postLiveStarted(url, event, postOpts): Promise<WebhookPostResult> {
      return post(url, JSON.stringify(event), postOpts);
    },

    postRaw(url, body, postOpts): Promise<WebhookPostResult> {
      return post(url, body, postOpts);
    },
  };
}
