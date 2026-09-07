import { describe, it, expect, afterEach } from 'vitest';

import {
  createFakeChzzkbot,
  loadJsonFixture,
  CHZZKBOT_TOKEN_HEADER,
  LIVE_EVENT_PAYLOAD_VERSION,
  MIN_TOKEN_LENGTH,
  type FakeChzzkbot,
  type LiveApiResponse,
  type LiveStartedEvent,
} from './harness/fake-chzzkbot.js';
import { createFakeDiscord } from './harness/fake-discord.js';
import { createGatewayCounter, RECONNECT_COUNTED_EVENT } from '../../src/discord/client.js';
import {
  createWebServer,
  listenWithRetry,
  type Route,
  type WebServer,
} from '../../src/web/server.js';

/**
 * 하니스 자체의 계약 (계획 §S3 · §9.3).
 *
 * ★ *"하니스 2종이 전제다. 둘 다 §S3 산출물이며, 없으면 이 계층은 실행되지 않는다."*
 *   그 전제가 실제로 서 있는지를 여기서 판정한다 — 이 파일이 깨지면 S4~S7 의
 *   e2e 시나리오가 전부 판정 불가가 된다.
 */

const TOKEN = 'f'.repeat(MIN_TOKEN_LENGTH * 2);

let upstream: FakeChzzkbot | undefined;
let web: WebServer | undefined;

afterEach(async () => {
  await upstream?.close();
  upstream = undefined;
  await web?.close();
  web = undefined;
});

describe('fake-chzzkbot — GET /api/live (우리 → 상류)', () => {
  it('픽스처를 계약 그대로 답한다', async () => {
    const up = createFakeChzzkbot({ token: TOKEN });
    upstream = up;
    const base = await up.start();
    up.loadLiveFixture('chzzkbot/api-live-announce.json');

    const res = await fetch(`${base}/api/live`, { headers: { [CHZZKBOT_TOKEN_HEADER]: TOKEN } });
    const body = (await res.json()) as LiveApiResponse;

    expect(res.status).toBe(200);
    expect(body.version).toBe(LIVE_EVENT_PAYLOAD_VERSION);
    // 픽스처를 손대지 않고 그대로 낸다 — 하니스가 계약을 재해석하면 안 된다.
    expect(body).toEqual(loadJsonFixture('chzzkbot/api-live-announce.json'));
    expect(up.requests.map((r) => r.path)).toEqual(['/api/live']);
  });

  it('★ 토큰이 없거나 짧거나 틀리면 404 다 (상류 규칙 — 401 이 아니다)', async () => {
    const up = createFakeChzzkbot({ token: TOKEN });
    upstream = up;
    const base = await up.start();

    // "여기 뭔가 있다" 를 흘리지 않는다. ⚠️ 우리 **수신** 엔드포인트는 401 이다 —
    // 그건 우리 계약이고 이건 상류 것이다. 혼동하면 S5 의 토큰 테스트가 갈린다.
    expect((await fetch(`${base}/api/live`)).status).toBe(404);
    expect(
      (await fetch(`${base}/api/live`, { headers: { [CHZZKBOT_TOKEN_HEADER]: 'short' } })).status,
    ).toBe(404);
    expect(
      (await fetch(`${base}/api/live`, { headers: { [CHZZKBOT_TOKEN_HEADER]: 'g'.repeat(32) } }))
        .status,
    ).toBe(404);
  });

  it('401 · 404 · 500 을 강제할 수 있다 (§9.3 "조회 API 장애")', async () => {
    const up = createFakeChzzkbot({ token: TOKEN });
    upstream = up;
    const base = await up.start();

    for (const status of [401, 404, 500]) {
      up.setStatus(status);
      const res = await fetch(`${base}/api/live`, { headers: { [CHZZKBOT_TOKEN_HEADER]: TOKEN } });
      expect(res.status).toBe(status);
      await res.text();
    }
  });

  it('응답을 늦출 수 있다 (FM1 부하 구간용 300ms 지연)', async () => {
    const up = createFakeChzzkbot({ token: TOKEN });
    upstream = up;
    const base = await up.start();
    up.setDelayMs(60);

    const started = Date.now();
    const res = await fetch(`${base}/api/live`, { headers: { [CHZZKBOT_TOKEN_HEADER]: TOKEN } });
    await res.text();

    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('★★ 응답을 영영 주지 않을 수 있다 — 호출부 타임아웃 배선의 유일한 검증 수단', async () => {
    const up = createFakeChzzkbot({ token: TOKEN });
    upstream = up;
    const base = await up.start();
    up.setHang(true);

    const ac = new AbortController();
    const timer = setTimeout(() => {
      ac.abort();
    }, 80);
    try {
      await expect(
        fetch(`${base}/api/live`, {
          headers: { [CHZZKBOT_TOKEN_HEADER]: TOKEN },
          signal: ac.signal,
        }),
      ).rejects.toThrow();
    } finally {
      clearTimeout(timer);
    }

    // 매달아 둔 응답이 있어도 close 가 끝난다 — 안 그러면 이 테스트가 멈춘다.
    await up.close();
    upstream = undefined;
  });
});

describe('fake-chzzkbot — POST 웹훅 (상류 → 우리)', () => {
  it('★ 계약대로 쏘고, 받는 쪽 응답 시간을 잰다', async () => {
    const received: { token: string | undefined; body: string }[] = [];
    const hook: Route = {
      method: 'POST',
      path: '/hooks/chzzkbot/live',
      handle: (req) => {
        const raw = req.headers[CHZZKBOT_TOKEN_HEADER];
        received.push({
          token: Array.isArray(raw) ? raw[0] : raw,
          body: req.body.toString('utf-8'),
        });
        return { status: 204, body: '' };
      },
    };
    const w = createWebServer({ routes: [hook] });
    web = w;
    const bound = await listenWithRetry(w, { port: 0 });

    const up = createFakeChzzkbot({ token: TOKEN });
    upstream = up;
    await up.start();

    const event = loadJsonFixture('chzzkbot/webhook-live-started.json') as LiveStartedEvent;
    const out = await up.postLiveStarted(
      `http://127.0.0.1:${String(bound.port)}/hooks/chzzkbot/live`,
      event,
    );

    expect(out.status).toBe(204);
    expect(received).toHaveLength(1);
    expect(received[0]?.token).toBe(TOKEN);
    expect(JSON.parse(received[0]?.body ?? '{}')).toEqual(event);
    expect(out.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('토큰을 빼거나 바꿔 쏠 수 있다 (AC-14 의 4종 중 둘)', async () => {
    const tokens: (string | undefined)[] = [];
    const hook: Route = {
      method: 'POST',
      path: '/hooks/chzzkbot/live',
      handle: (req) => {
        const raw = req.headers[CHZZKBOT_TOKEN_HEADER];
        tokens.push(Array.isArray(raw) ? raw[0] : raw);
        return { status: 204, body: '' };
      },
    };
    const w = createWebServer({ routes: [hook] });
    web = w;
    const bound = await listenWithRetry(w, { port: 0 });
    const url = `http://127.0.0.1:${String(bound.port)}/hooks/chzzkbot/live`;

    const up = createFakeChzzkbot({ token: TOKEN });
    upstream = up;
    await up.start();
    const event = loadJsonFixture('chzzkbot/webhook-live-started.json') as LiveStartedEvent;

    await up.postLiveStarted(url, event, { token: null });
    await up.postLiveStarted(url, event, { token: 'wrong-token-value-0123456789' });
    // 계약 위반 페이로드도 그대로 보낼 수 있다 (version:2 · 깨진 JSON).
    await up.postRaw(url, '{ not json');

    expect(tokens).toEqual([undefined, 'wrong-token-value-0123456789', TOKEN]);
  });
});

describe('fake-discord — 4종 능력 (계획 §S3 B-2)', () => {
  it('① 발송을 캡처한다 — 내용 · 대상 채널 · 호출 횟수 · 순서', async () => {
    const fake = createFakeDiscord();
    await fake.send('chan-a', { content: '첫째' });
    await fake.send('chan-b', { content: '둘째' });

    expect(fake.sent.map((s) => [s.channelId, s.payload.content, s.seq])).toEqual([
      ['chan-a', '첫째', 1],
      ['chan-b', '둘째', 2],
    ]);
  });

  it('★★ ② 재연결을 주입하고, 프로덕션과 **같은 규칙**으로 센다 (AC-P3 (a))', () => {
    const fake = createFakeDiscord();
    expect(fake.reconnectCount).toBe(0);

    fake.simulateReconnect();
    fake.simulateReconnect();

    // 프로덕션 카운터와 같은 값이 나와야 한다 — 둘이 갈리면 테스트가 통과해도
    // 운영 지표 discord_gateway_reconnects 가 다른 것을 본다.
    const reference = createGatewayCounter();
    for (const e of fake.gatewayEvents) reference.record(e.name, e.at);
    expect(fake.reconnectCount).toBe(reference.reconnectCount);
    expect(fake.reconnectCount).toBe(2);

    // 세는 이벤트는 하나뿐이다.
    const counted = fake.gatewayEvents.filter((e) => e.name === RECONNECT_COUNTED_EVENT);
    expect(counted).toHaveLength(2);
    expect(fake.gatewayEvents).toHaveLength(6);
  });

  it('③ 역할 부여·닉네임 변경 호출을 성공/실패까지 기록한다 (AC-6 · AC-11 · AC-12)', async () => {
    const fake = createFakeDiscord();
    await fake.addRole('guild-1', 'user-1', 'role-verified');

    fake.failNext({ kind: 'forbidden' });
    await expect(fake.setNickname('guild-1', 'user-1', '시스네팬')).rejects.toThrow();

    expect(fake.roleGrants).toEqual([
      { guildId: 'guild-1', userId: 'user-1', roleId: 'role-verified', ok: true, at: expect.any(Number) },
    ]);
    // ★ 실패한 호출도 남는다 — AC-11(닉네임 실패 격리)은 "불렀는데 실패했다" 를
    //   봐야 판정되고, 기록이 없으면 "아예 안 불렀다" 와 구분되지 않는다.
    expect(fake.nicknames[0]).toMatchObject({ ok: false, nickname: '시스네팬' });
  });

  it('④ 429 · 403 · 5xx 를 주입한다', async () => {
    const fake = createFakeDiscord();

    fake.failNext({ kind: 'rate-limited', retryAfterMs: 1_500 });
    await expect(fake.send('c', {})).rejects.toMatchObject({
      kind: 'rate-limited',
      status: 429,
      retryAfterMs: 1_500,
    });

    fake.failNext({ kind: 'forbidden' });
    await expect(fake.send('c', {})).rejects.toMatchObject({ kind: 'forbidden', status: 403 });

    fake.failNext({ kind: 'server', status: 502 });
    await expect(fake.send('c', {})).rejects.toMatchObject({ kind: 'server', status: 502 });

    // 주입이 소진되면 다시 정상이다.
    await expect(fake.send('c', {})).resolves.toMatchObject({ id: 'fake-msg-1' });
  });

  it('④ 무응답은 AbortSignal 로만 끊긴다', async () => {
    const fake = createFakeDiscord();
    fake.failAlways({ kind: 'hang' });

    const ac = new AbortController();
    const timer = setTimeout(() => {
      ac.abort();
    }, 30);
    try {
      await expect(fake.send('c', {}, { signal: ac.signal })).rejects.toMatchObject({
        kind: 'timeout',
      });
    } finally {
      clearTimeout(timer);
    }
    expect(fake.sent).toHaveLength(0);
  });

  it('reset 은 발송 기록만 비우고 재연결 누적은 남긴다', async () => {
    const fake = createFakeDiscord();
    await fake.send('c', {});
    fake.simulateReconnect();

    fake.reset();
    expect(fake.sent).toHaveLength(0);
    // 운영 지표가 프로세스 생애 누적값이므로 여기서 리셋하면 축이 달라진다.
    expect(fake.reconnectCount).toBe(1);
  });

  it('login / destroy 를 기록한다', async () => {
    const fake = createFakeDiscord();
    await fake.login();
    expect(fake.loginCount).toBe(1);
    await fake.destroy();
    expect(fake.destroyed).toBe(true);
  });
});
