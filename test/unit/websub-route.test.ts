import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

import {
  CHANNEL_PARAM,
  SIGNATURE_FAILURE_METRIC,
  SIGNATURE_HEADER,
  UNKNOWN_CHANNEL_LABEL,
  WEBSUB_PATH,
  createSignatureFailureCounter,
  createWebSubRoutes,
  verifySignature,
  type SignatureFailure,
  type WebSubRouteDeps,
  type WebSubVerifyInput,
} from '../../src/web/routes/websub.js';
import type { Route, RouteRequest } from '../../src/web/server.js';

/**
 * 계획 §S6 — WebSub 수신구 (AC-20 · **AC-P5**).
 *
 * ★★ AC-P5 의 전부: *"서명 검증 실패는 계약대로 조용히 202 로 답하되
 *   `websub_signature_failures{channel}` 를 반드시 증가시킨다."*
 *   지표가 없으면 "시크릿 불일치"와 "허브가 안 보냄"이 겉으로는 똑같이
 *   **공지가 안 나온다**로만 보인다.
 */

const CHANNEL = 'UCcisnesTest0000000001';
const SECRET = 'cisnes-secret-0123456789abcdef';

function sign(secret: string, body: string, algo = 'sha1'): string {
  return `${algo}=${createHmac(algo, secret).update(Buffer.from(body, 'utf8')).digest('hex')}`;
}

interface Harness {
  routes: Route[];
  get: Route;
  post: Route;
  counter: ReturnType<typeof createSignatureFailureCounter>;
  pushes: { channelId: string; xml: string }[];
  verifications: WebSubVerifyInput[];
  failures: { channel: string; reason: SignatureFailure }[];
  /** 검증을 거절하도록 만든다 */
  rejectVerify: boolean;
  /** 시크릿을 모르는 채널로 만든다 */
  knownChannels: Set<string>;
}

function harness(): Harness {
  // ★ 스프레드로 복사본을 돌려주면 `rejectVerify` 같은 원시값 토글이
  //   클로저가 붙든 원본에 반영되지 않는다. **같은 객체**를 돌려준다.
  const h = {
    counter: createSignatureFailureCounter(),
    pushes: [] as { channelId: string; xml: string }[],
    verifications: [] as WebSubVerifyInput[],
    failures: [] as { channel: string; reason: SignatureFailure }[],
    rejectVerify: false,
    knownChannels: new Set([CHANNEL]),
  } as Harness;

  const deps: WebSubRouteDeps = {
    secretFor: (c) => (h.knownChannels.has(c) ? SECRET : undefined),
    verify(input) {
      h.verifications.push(input);
      return h.rejectVerify ? { accepted: false, reason: '거절' } : { accepted: true };
    },
    onPush(channelId, xml) {
      h.pushes.push({ channelId, xml });
      return Promise.resolve();
    },
    onSignatureFailure(channel, reason) {
      h.counter.record(channel, reason);
      h.failures.push({ channel, reason });
    },
  };

  const routes = createWebSubRoutes(deps);
  const get = routes.find((r) => r.method === 'GET');
  const post = routes.find((r) => r.method === 'POST');
  if (get === undefined || post === undefined) throw new Error('라우트가 없습니다');
  h.routes = routes;
  h.get = get;
  h.post = post;
  return h;
}

function req(query: string, opts: { body?: string; headers?: Record<string, string> } = {}): RouteRequest {
  return {
    method: opts.body === undefined ? 'GET' : 'POST',
    url: new URL(`http://localhost${WEBSUB_PATH}${query}`),
    headers: opts.headers ?? {},
    body: Buffer.from(opts.body ?? '', 'utf8'),
  };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe('verifySignature — HMAC-SHA1', () => {
  const body = Buffer.from('<feed/>', 'utf8');

  it('맞는 서명을 통과시킨다', () => {
    expect(verifySignature(SECRET, body, sign(SECRET, '<feed/>'))).toEqual({ ok: true });
  });

  it('★ 시크릿이 다르면 실패한다', () => {
    expect(verifySignature(SECRET, body, sign('다른시크릿', '<feed/>'))).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('본문이 한 바이트만 달라도 실패한다', () => {
    expect(verifySignature(SECRET, Buffer.from('<feed />', 'utf8'), sign(SECRET, '<feed/>'))).toEqual(
      { ok: false, reason: 'mismatch' },
    );
  });

  it('헤더가 없거나 모양이 다르면 실패한다 — 던지지 않는다', () => {
    expect(verifySignature(SECRET, body, undefined)).toEqual({ ok: false, reason: 'missing-header' });
    expect(verifySignature(SECRET, body, '')).toEqual({ ok: false, reason: 'missing-header' });
    expect(verifySignature(SECRET, body, 'garbage')).toEqual({
      ok: false,
      reason: 'malformed-header',
    });
    expect(verifySignature(SECRET, body, 'sha1=zzzz')).toEqual({
      ok: false,
      reason: 'malformed-header',
    });
  });

  it('★ 길이가 다른 다이제스트에 timingSafeEqual 이 던지지 않는다', () => {
    expect(verifySignature(SECRET, body, 'sha1=abcd')).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('★ 허용 목록 밖의 알고리즘은 거절한다', () => {
    expect(verifySignature(SECRET, body, sign(SECRET, '<feed/>', 'md5'))).toEqual({
      ok: false,
      reason: 'unsupported-algo',
    });
  });

  it('sha256 도 받는다 (허브가 올라가도 깨지지 않는다)', () => {
    expect(verifySignature(SECRET, body, sign(SECRET, '<feed/>', 'sha256'))).toEqual({ ok: true });
  });
});

describe('GET — hub.challenge 에코', () => {
  it('★ 챌린지를 그대로 돌려준다 (감싸지 않는다)', async () => {
    const out = await h.get.handle(
      req(
        `?${CHANNEL_PARAM}=${CHANNEL}&hub.mode=subscribe&hub.topic=T&hub.challenge=CHAL-123&hub.lease_seconds=432000`,
      ),
    );
    expect(out.status).toBe(200);
    expect(out.body).toBe('CHAL-123');
    expect(out.contentType).toBe('text/plain; charset=utf-8');
    expect(h.verifications[0]).toEqual({
      channelId: CHANNEL,
      mode: 'subscribe',
      topic: 'T',
      leaseSecondsRaw: '432000',
    });
  });

  it('lease_seconds 가 없으면 그 필드를 넘기지 않는다', async () => {
    await h.get.handle(
      req(`?${CHANNEL_PARAM}=${CHANNEL}&hub.mode=subscribe&hub.topic=T&hub.challenge=C`),
    );
    expect(h.verifications[0]).not.toHaveProperty('leaseSecondsRaw');
  });

  it('★ 요청한 적 없는 구독은 404 다 (명세 요구)', async () => {
    h.rejectVerify = true;
    const out = await h.get.handle(
      req(`?${CHANNEL_PARAM}=UCother&hub.mode=subscribe&hub.topic=T&hub.challenge=C`),
    );
    expect(out.status).toBe(404);
  });

  it.each([
    ['채널 없음', '?hub.mode=subscribe&hub.topic=T&hub.challenge=C'],
    ['mode 없음', `?${CHANNEL_PARAM}=${CHANNEL}&hub.topic=T&hub.challenge=C`],
    ['topic 없음', `?${CHANNEL_PARAM}=${CHANNEL}&hub.mode=subscribe&hub.challenge=C`],
    ['challenge 없음', `?${CHANNEL_PARAM}=${CHANNEL}&hub.mode=subscribe&hub.topic=T`],
  ])('필수 파라미터가 빠지면 404 — %s', async (_n, q) => {
    const out = await h.get.handle(req(q));
    expect(out.status).toBe(404);
    expect(h.verifications).toHaveLength(0);
  });
});

describe('POST — 푸시 (AC-P5)', () => {
  const XML = '<feed><entry><yt:videoId>V1</yt:videoId></entry></feed>';

  it('서명이 맞으면 202 + 본문을 넘긴다', async () => {
    const out = await h.post.handle(
      req(`?${CHANNEL_PARAM}=${CHANNEL}`, {
        body: XML,
        headers: { [SIGNATURE_HEADER]: sign(SECRET, XML) },
      }),
    );
    expect(out.status).toBe(202);
    expect(h.pushes).toEqual([{ channelId: CHANNEL, xml: XML }]);
    expect(h.counter.total).toBe(0);
  });

  it('★★ 틀린 시크릿 → 202 + 푸시 처리 0건 + 지표 +1 (AC-P5)', async () => {
    const out = await h.post.handle(
      req(`?${CHANNEL_PARAM}=${CHANNEL}`, {
        body: XML,
        headers: { [SIGNATURE_HEADER]: sign('공격자시크릿', XML) },
      }),
    );

    // 계약대로 조용히 받아 준다 — 4xx 를 주면 허브가 구독을 끊는다.
    expect(out.status).toBe(202);
    expect(h.pushes).toHaveLength(0);
    // ★ 그러나 지표는 반드시 올라간다. 이것이 없으면 원인 특정이 불가능하다.
    expect(h.counter.count(CHANNEL)).toBe(1);
    expect(h.counter.total).toBe(1);
    expect(h.failures).toEqual([{ channel: CHANNEL, reason: 'mismatch' }]);
  });

  it('서명 헤더 자체가 없어도 202 + 지표 +1', async () => {
    const out = await h.post.handle(req(`?${CHANNEL_PARAM}=${CHANNEL}`, { body: XML }));
    expect(out.status).toBe(202);
    expect(h.counter.count(CHANNEL)).toBe(1);
    expect(h.failures[0]?.reason).toBe('missing-header');
  });

  it('★ 모르는 채널은 한 버킷으로 접는다 (지표 카디널리티 방어)', async () => {
    for (const c of ['UCa', 'UCb', 'UCc']) {
      await h.post.handle(
        req(`?${CHANNEL_PARAM}=${c}`, { body: XML, headers: { [SIGNATURE_HEADER]: sign(SECRET, XML) } }),
      );
    }
    expect(h.counter.count(UNKNOWN_CHANNEL_LABEL)).toBe(3);
    expect(h.counter.snapshot()).toEqual([{ channel: UNKNOWN_CHANNEL_LABEL, count: 3 }]);
    expect(h.pushes).toHaveLength(0);
  });

  it('채널 파라미터가 아예 없어도 202 다', async () => {
    const out = await h.post.handle(req('', { body: XML }));
    expect(out.status).toBe(202);
    expect(h.failures[0]).toEqual({ channel: UNKNOWN_CHANNEL_LABEL, reason: 'missing-channel' });
  });

  it('배열로 들어온 헤더의 첫 값을 쓴다', async () => {
    const out = await h.post.handle({
      method: 'POST',
      url: new URL(`http://localhost${WEBSUB_PATH}?${CHANNEL_PARAM}=${CHANNEL}`),
      headers: { [SIGNATURE_HEADER]: [sign(SECRET, XML), 'sha1=deadbeef'] },
      body: Buffer.from(XML, 'utf8'),
    });
    expect(out.status).toBe(202);
    expect(h.pushes).toHaveLength(1);
  });
});

describe('지표 카운터', () => {
  it('이름이 계획의 것과 같다', () => {
    expect(SIGNATURE_FAILURE_METRIC).toBe('websub_signature_failures');
  });

  it('채널별로 격리된다 — 한 채널의 실패가 다른 채널을 오염시키지 않는다', () => {
    const c = createSignatureFailureCounter();
    c.record('UCa', 'mismatch');
    c.record('UCa', 'mismatch');
    c.record('UCb', 'missing-header');
    expect(c.count('UCa')).toBe(2);
    expect(c.count('UCb')).toBe(1);
    expect(c.count('UCc')).toBe(0);
    expect(c.total).toBe(3);
  });
});

describe('라우트 표', () => {
  it('경로 하나에 GET · POST 둘이다', () => {
    expect(h.routes.map((r) => r.path)).toEqual([WEBSUB_PATH, WEBSUB_PATH]);
    expect(h.routes.map((r) => r.method).sort()).toEqual(['GET', 'POST']);
  });
});
