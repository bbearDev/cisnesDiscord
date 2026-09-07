import { describe, it, expect } from 'vitest';

import {
  createAnnouncer,
  buildAnnouncementEmbed,
  ANNOUNCE_BACKOFF_MS,
  MAX_RETRY_AFTER_MS,
} from '../../src/discord/announcer.js';
import {
  createGatewayCounter,
  RECONNECT_COUNTED_EVENT,
  GATEWAY_EVENTS,
  REQUIRED_INTENTS,
  toDiscordSendError,
  DiscordSendError,
} from '../../src/discord/client.js';
import {
  createOpsAlertService,
  createMemoryAlertState,
} from '../../src/runtime/alerts/ops-alert-service.js';
import { SYSTEM_SCOPE } from '../../src/runtime/alerts/types.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { createFakeDiscord, type FakeFailure } from '../e2e/harness/fake-discord.js';

/**
 * 공지 발송기 (계획 §S3 · Principle 2 · §5.6.1).
 *
 * 판정하는 것: **호출자에게 예외가 0건**이라는 것, 3회 소진 시 운영 채널에
 * **정확히 1건**이 남는다는 것, `Retry-After` 가 백오프를 이긴다는 것,
 * 타임아웃이 실제로 `AbortSignal` 로 걸려 있다는 것.
 */

const START = Date.parse('2026-09-07T00:00:00.000Z');

function harness(opts: { failure?: FakeFailure; times?: number; timeoutMs?: number } = {}) {
  const clock = new ManualClock(START);
  const gateway = createFakeDiscord({ now: () => clock.now() });
  const sentAlerts: string[] = [];
  const alerts = createOpsAlertService({
    notifier: {
      send: (m) => {
        sentAlerts.push(m);
        return Promise.resolve('sent');
      },
    },
    state: createMemoryAlertState(),
    clock,
    scope: SYSTEM_SCOPE,
    minIntervalMin: 0,
  });
  const slept: number[] = [];
  const announcer = createAnnouncer({
    gateway,
    alerts,
    clock,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  });
  if (opts.failure) gateway.failNext(opts.failure, opts.times ?? 1);
  return { clock, gateway, alerts, announcer, sentAlerts, slept };
}

const request = {
  channelId: '111222333',
  label: 'live_start df09256e',
  payload: { embeds: [buildAnnouncementEmbed({ title: '방송 시작', detectedVia: 'webhook' })] },
};

describe('announcer — 정상 발송', () => {
  it('한 번에 나가면 재시도도 백오프도 없다', async () => {
    const h = harness();
    const out = await h.announcer.announce(request);

    expect(out).toEqual({ ok: true, messageId: 'fake-msg-1', attempts: 1 });
    expect(h.gateway.sent).toHaveLength(1);
    expect(h.gateway.sent[0]?.channelId).toBe('111222333');
    expect(h.slept).toEqual([]);
    expect(h.sentAlerts).toEqual([]);
  });

  it('임베드 푸터에 detected_via 를 싣는다 (사람이 눈으로 웹훅 고장을 알아챈다)', () => {
    const embed = buildAnnouncementEmbed({
      title: '방송 시작',
      timestamp: '2026-08-28T03:56:39.000Z',
      detectedVia: 'api-poll',
    });
    expect(embed.footer).toEqual({ text: '감지: api-poll' });
    // ★ 타임스탬프는 openedAt 이다 — 수신 시각이 아니다 (§S5).
    expect(embed.timestamp).toBe('2026-08-28T03:56:39.000Z');
  });

  it('선택 필드를 주지 않으면 임베드에 그 키가 아예 없다', () => {
    expect(buildAnnouncementEmbed({ title: '제목만' })).toEqual({ title: '제목만' });
  });
});

describe('announcer — 실패 격리 (Principle 2)', () => {
  it('★ 3회 연속 실패 → 운영 채널 1건 · 호출자 예외 0 · 결과값으로만 알린다', async () => {
    const h = harness({ failure: { kind: 'server', status: 503 }, times: 99 });

    // reject 하지 않는다는 것이 이 단언의 전부다.
    const out = await h.announcer.announce(request);

    expect(out.ok).toBe(false);
    expect(out.attempts).toBe(3);
    expect(h.gateway.sent).toHaveLength(0);
    expect(h.sentAlerts).toHaveLength(1);
    expect(h.sentAlerts[0]).toContain('공지 발송 실패');
    expect(h.sentAlerts[0]).toContain('live_start df09256e');
  });

  it('지수 백오프는 1s → 2s 다 (3회째 뒤에는 자지 않는다)', async () => {
    const h = harness({ failure: { kind: 'server' }, times: 99 });
    await h.announcer.announce(request);
    expect(h.slept).toEqual([ANNOUNCE_BACKOFF_MS[0], ANNOUNCE_BACKOFF_MS[1]]);
  });

  it('중간에 회복하면 그 시점에 성공하고 경보는 없다', async () => {
    const h = harness({ failure: { kind: 'server' }, times: 2 });
    const out = await h.announcer.announce(request);

    expect(out).toMatchObject({ ok: true, attempts: 3 });
    expect(h.gateway.sent).toHaveLength(1);
    expect(h.sentAlerts).toEqual([]);
  });

  it('★ 429 는 Retry-After 를 백오프보다 우선한다 (§5.6.1)', async () => {
    const h = harness({ failure: { kind: 'rate-limited', retryAfterMs: 2_500 }, times: 99 });
    await h.announcer.announce(request);
    // 1s/2s 가 아니라 서버가 말한 2.5초를 두 번 잔다.
    expect(h.slept).toEqual([2_500, 2_500]);
  });

  it('★ Retry-After 가 상한을 넘으면 지금 자지 않고 다음 회수 주기로 미룬다', async () => {
    const h = harness({
      failure: { kind: 'rate-limited', retryAfterMs: MAX_RETRY_AFTER_MS + 1 },
      times: 99,
    });
    const out = await h.announcer.announce(request);

    expect(h.slept).toEqual([]); // 아웃박스 한 바퀴를 통째로 붙잡지 않는다
    expect(out.ok).toBe(false);
    expect(h.sentAlerts).toHaveLength(1);
  });

  it('★ 403 은 재시도하지 않는다 — 권한은 4초 안에 생기지 않는다', async () => {
    const h = harness({ failure: { kind: 'forbidden' }, times: 99 });
    const out = await h.announcer.announce(request);

    expect(out).toMatchObject({ ok: false, attempts: 1, permanent: true });
    expect(h.slept).toEqual([]);
    // 그래도 운영 채널 기록은 정확히 1건이다.
    expect(h.sentAlerts).toHaveLength(1);
    expect(h.sentAlerts[0]).toContain('권한 문제로 재시도 중단');
  });

  it('★ 무응답은 AbortSignal 타임아웃으로 끊긴다 (타이머를 남기지 않는다)', async () => {
    const h = harness({ failure: { kind: 'hang' }, times: 99, timeoutMs: 20 });

    const before = process.hrtime.bigint();
    const out = await h.announcer.announce(request);
    const elapsedMs = Number(process.hrtime.bigint() - before) / 1e6;

    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining('timeout') });
    // 3회 × 20ms 가 상한이다. 타임아웃이 안 걸렸으면 여기서 영영 멈춘다.
    expect(elapsedMs).toBeLessThan(2_000);
    expect(h.sentAlerts).toHaveLength(1);
  });

  it('sleep 을 주입하지 않으면 실제 타이머로 잔다 (unref 라 종료를 붙잡지 않는다)', async () => {
    const clock = new ManualClock(START);
    const gateway = createFakeDiscord({ now: () => clock.now() });
    gateway.failNext({ kind: 'server' }, 1);
    const announcer = createAnnouncer({
      gateway,
      alerts: createOpsAlertService({
        notifier: { send: () => Promise.resolve('skipped-no-url') },
        state: createMemoryAlertState(),
        clock,
        scope: SYSTEM_SCOPE,
        minIntervalMin: 0,
      }),
      clock,
      backoffMs: [1],
    });

    await expect(announcer.announce(request)).resolves.toMatchObject({ ok: true, attempts: 2 });
  });

  it('진단 콜백이 던져도 발송을 막지 않는다', async () => {
    const clock = new ManualClock(START);
    const gateway = createFakeDiscord({ now: () => clock.now() });
    const announcer = createAnnouncer({
      gateway,
      alerts: createOpsAlertService({
        notifier: { send: () => Promise.resolve('skipped-no-url') },
        state: createMemoryAlertState(),
        clock,
        scope: SYSTEM_SCOPE,
        minIntervalMin: 0,
      }),
      clock,
      sleep: () => Promise.resolve(),
      onEvent: () => {
        throw new Error('로그 수집기가 죽었다');
      },
    });

    await expect(announcer.announce(request)).resolves.toMatchObject({ ok: true });
  });

  it('경보 발송이 던져도 발송기는 결과를 정상 반환한다', async () => {
    const clock = new ManualClock(START);
    const gateway = createFakeDiscord({ now: () => clock.now() });
    gateway.failAlways({ kind: 'server' });
    const announcer = createAnnouncer({
      gateway,
      // 계약상 raise 는 reject 하지 않지만, 계약을 신뢰하지 않는다.
      alerts: {
        scope: SYSTEM_SCOPE,
        raise: () => Promise.reject(new Error('경보 경로까지 죽었다')),
        forScope: () => {
          throw new Error('쓰지 않는다');
        },
      },
      clock,
      sleep: () => Promise.resolve(),
    });

    await expect(announcer.announce(request)).resolves.toMatchObject({ ok: false });
  });
});

describe('discord/client — 오류 분류와 재연결 계수', () => {
  it('Intents 는 Guilds · GuildMembers · GuildMessages 셋이다', () => {
    expect(REQUIRED_INTENTS).toHaveLength(3);
  });

  it('상태 코드를 우리 어휘로 접는다', () => {
    expect(toDiscordSendError({ status: 429 }).kind).toBe('rate-limited');
    expect(toDiscordSendError({ status: 403 }).kind).toBe('forbidden');
    expect(toDiscordSendError({ status: 500 }).kind).toBe('server');
    expect(toDiscordSendError({ status: 400 }).kind).toBe('unknown');
    expect(toDiscordSendError(new Error('boom')).kind).toBe('unknown');
  });

  it('AbortError 는 timeout 이다', () => {
    const e = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    expect(toDiscordSendError(e).kind).toBe('timeout');
  });

  it('Retry-After 가 초 단위로 와도 ms 로 접는다', () => {
    expect(toDiscordSendError({ status: 429, retryAfter: 3 }).retryAfterMs).toBe(3_000);
    expect(toDiscordSendError({ status: 429, retryAfter: 3_000 }).retryAfterMs).toBe(3_000);
  });

  it('이미 분류된 오류는 그대로 통과시킨다', () => {
    const e = new DiscordSendError('forbidden', '권한 없음', 403);
    expect(toDiscordSendError(e)).toBe(e);
  });

  it('★ 재연결은 shardReconnecting 하나만 센다 — 셋을 다 세면 3배로 부푼다', () => {
    const c = createGatewayCounter();
    for (const name of GATEWAY_EVENTS) c.record(name, 0);

    expect(c.events).toHaveLength(3);
    expect(c.reconnectCount).toBe(1);
    expect(RECONNECT_COUNTED_EVENT).toBe('shardReconnecting');
  });
});
