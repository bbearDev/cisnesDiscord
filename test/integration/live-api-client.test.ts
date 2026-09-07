import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  createLiveApiClient,
  CHZZKBOT_TOKEN_HEADER,
  LIVE_API_PATH,
  type LiveApiClient,
} from '../../src/chzzk/live-api-client.js';
import { createHttpBudget, CALL_TIMEOUT_MS } from '../../src/runtime/http-budget.js';
import { judgeLiveState } from '../../src/live/live-state.js';
import type { LiveApiFailure } from '../../src/chzzk/live-api-schema.js';
import {
  createFakeChzzkbot,
  loadJsonFixture,
  MIN_TOKEN_LENGTH,
  type FakeChzzkbot,
} from '../e2e/harness/fake-chzzkbot.js';

/**
 * `GET /api/live` 클라이언트 — **실제 소켓**으로 검증한다 (계획 §9.3).
 *
 * ★ 인메모리 더블로는 판정할 수 없는 것이 둘 있다:
 *   ① `?channel=` 을 실제로 안 붙였는가 (요청 URL 은 서버만 안다)
 *   ② 무응답 소켓에 매달리지 않는가 (매달릴 소켓이 있어야 검증된다)
 */

const OURS = 'c3355ea2b3bea6c646789510796379d6';
const FOREIGN = '3594a5258433f765b6247dfe05e5fb33';
const TOKEN = 'f'.repeat(MIN_TOKEN_LENGTH * 2);

let fake: FakeChzzkbot;
let client: LiveApiClient;

beforeEach(async () => {
  fake = createFakeChzzkbot({ token: TOKEN });
  const baseUrl = await fake.start();
  client = createLiveApiClient({
    baseUrl,
    token: TOKEN,
    channelId: OURS,
    http: createHttpBudget(),
  });
});

afterEach(async () => {
  await fake.close();
});

describe('★★ 무필터 호출 — ?channel= 을 붙이지 않는다', () => {
  it('경로 상수에 쿼리 문자열이 없다', () => {
    expect(LIVE_API_PATH).toBe('/api/live');
    expect(LIVE_API_PATH).not.toContain('?');
  });

  it('실제 요청 URL 에도 쿼리가 없다', async () => {
    fake.loadLiveFixture('chzzkbot/api-live-2channels-idle.json');
    await client.fetch();

    expect(client.url).not.toContain('?');
    expect(new URL(client.url).search).toBe('');
    expect(fake.requests.map((r) => r.path)).toEqual(['/api/live']);
  });

  it('★ 무필터라야 남의 채널이 응답에 보이고, 그래야 보호 목록 (b) 가 발화한다', async () => {
    fake.loadLiveFixture('chzzkbot/api-live-2channels-idle.json');
    const r = await client.fetch();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // `?channel=` 을 붙였다면 이 배열이 영영 비어 있고 unknown_channel 이 죽는다.
    expect(r.unknownChannelIds).toEqual([FOREIGN]);
  });
});

describe('토큰', () => {
  it('x-chzzkbot-token 헤더로 싣는다', async () => {
    await client.fetch();
    expect(fake.requests[0]?.token).toBe(TOKEN);
    expect(CHZZKBOT_TOKEN_HEADER).toBe('x-chzzkbot-token');
  });

  it('★ 토큰이 틀리면 상류가 404 를 준다 — 우리는 그것을 unknown 으로 접는다', async () => {
    const wrong = createLiveApiClient({
      baseUrl: fake.baseUrl,
      token: 'x'.repeat(MIN_TOKEN_LENGTH * 2),
      channelId: OURS,
      http: createHttpBudget(),
    });
    const r = await wrong.fetch();
    expect(r).toMatchObject({ ok: false, failure: 'http', status: 404 });
    if (r.ok) return;
    expect(judgeLiveState({ kind: 'failure', failure: r.failure }).state).toBe('unknown');
  });
});

describe('★ 응답 재필터 (R5)', () => {
  it('우리 채널만 target 이 되고 나머지는 unknownChannelIds 로 간다', async () => {
    fake.loadLiveFixture('chzzkbot/api-live-foreign-channel-live.json');
    const r = await client.fetch();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target?.channelId).toBe(OURS);
    expect(r.unknownChannelIds).toEqual([FOREIGN]);
    // 아이곰이 방송 중이어도 우리 판정은 ended 다.
    expect(judgeLiveState({ kind: 'channel', channel: r.target! }).state).toBe('ended');
  });

  it('우리 채널이 응답에 없으면 target 이 undefined 다', async () => {
    fake.setLiveResponse({
      version: 1,
      generatedAt: '2026-09-06T18:00:00.000Z',
      channels: [
        {
          channelId: FOREIGN,
          live: false,
          confirmed: false,
          exact: false,
          status: 'running',
        },
      ],
    });
    const r = await client.fetch();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target).toBeUndefined();
    expect(judgeLiveState({ kind: 'channel-missing' })).toEqual({
      state: 'unknown',
      reason: 'channel-missing',
    });
  });

  it('announce 픽스처에서 우리 채널의 liveHash 를 그대로 얻는다', async () => {
    fake.loadLiveFixture('chzzkbot/api-live-announce.json');
    const r = await client.fetch();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const j = judgeLiveState({ kind: 'channel', channel: r.target! });
    expect(j).toMatchObject({ state: 'announce', liveHash: 'df09256e' });
  });
});

describe('★★ 실패는 전부 값으로 나온다 (던지지 않는다)', () => {
  it('5xx → http', async () => {
    fake.setStatus(500);
    const r = await client.fetch();
    expect(r).toMatchObject({ ok: false, failure: 'http', status: 500 });
  });

  it('401 → http', async () => {
    fake.setStatus(401);
    await expect(client.fetch()).resolves.toMatchObject({ failure: 'http', status: 401 });
  });

  it('JSON 이 아닌 본문 → bad-body', async () => {
    fake.setLiveResponse('<html>proxy error</html>');
    const r = await client.fetch();
    expect(r).toMatchObject({ ok: false, failure: 'bad-body' });
  });

  it('★ 계약 모양이 아니면 schema (필수 필드 누락)', async () => {
    fake.setLiveResponse({
      version: 1,
      generatedAt: '2026-09-06T18:00:00.000Z',
      channels: [{ channelId: OURS, live: true }],
    });
    const r = await client.fetch();
    expect(r).toMatchObject({ ok: false, failure: 'schema' });
    if (r.ok) return;
    expect(r.detail).toContain('confirmed');
  });

  it('★★ version 이 다르면 모양이 맞아도 schema 로 접는다 (계약 변경)', async () => {
    const base = loadJsonFixture('chzzkbot/api-live-announce.json') as Record<string, unknown>;
    fake.setLiveResponse({ ...base, version: 2 });
    const r = await client.fetch();
    expect(r).toMatchObject({ ok: false, failure: 'schema' });
    if (r.ok) return;
    expect(r.detail).toContain('version=2');
  });

  it('상류가 죽어 있으면 network', async () => {
    await fake.close();
    const r = await client.fetch();
    expect(r).toMatchObject({ ok: false, failure: 'network' });
  });

  it('★ 응답을 영영 주지 않으면 회당 타임아웃(3초)에 끊긴다 — 이벤트 루프가 살아 있다', async () => {
    fake.setHang(true);
    const started = Date.now();
    const r = await client.fetch();
    const elapsed = Date.now() - started;

    expect(r).toMatchObject({ ok: false, failure: 'timeout' });
    expect(CALL_TIMEOUT_MS['live-api']).toBe(3_000);
    expect(elapsed).toBeGreaterThanOrEqual(2_500);
    expect(elapsed).toBeLessThan(6_000);
  });

  it('예산 마감이 이미 지났으면 요청도 보내지 않고 budget 을 준다', async () => {
    const r = await client.fetch({ deadlineAt: Date.now() - 1 });
    expect(r).toMatchObject({ ok: false, failure: 'budget' });
    expect(fake.requests).toHaveLength(0);
  });

  it('★ 실제로 만들어진 실패들이 전부 3상태식에서 unknown 으로 접힌다', async () => {
    const seen: LiveApiFailure[] = [];

    const collect = async (): Promise<void> => {
      const r = await client.fetch();
      expect(r.ok).toBe(false);
      if (r.ok) return;
      seen.push(r.failure);
      expect(judgeLiveState({ kind: 'failure', failure: r.failure }).state).toBe('unknown');
    };

    fake.setStatus(500);
    await collect();

    fake.setStatus(undefined);
    fake.setLiveResponse('nope');
    await collect();

    fake.setLiveResponse({ version: 1, generatedAt: 'x', channels: [{ channelId: 1 }] });
    await collect();

    await fake.close();
    await collect();

    expect(new Set(seen)).toEqual(new Set(['http', 'bad-body', 'schema', 'network']));
  });
});
