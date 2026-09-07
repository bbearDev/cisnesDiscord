import { describe, it, expect } from 'vitest';

import { ManualClock } from '../../src/runtime/clock.js';
import {
  createOpsAlertService,
  createMemoryAlertState,
  createSwappableAlertState,
  type AlertEvent,
} from '../../src/runtime/alerts/ops-alert-service.js';
import { SYSTEM_SCOPE } from '../../src/runtime/alerts/types.js';
import {
  createDiscordNotifier,
  WEBHOOK_MAX_CONTENT,
  type Notifier,
  type WebhookSendResult,
} from '../../src/runtime/alerts/discord-webhook.js';

/**
 * 운영 경보 서비스 (계획 Principle 2 · §S2 수용 기준).
 *
 * 판정 축 셋:
 *   ① **어떤 경우에도 throw 하지 않는다** — 전송이 reject 해도, onEvent 가 던져도
 *   ② `(scope, kind)` 디바운스 — **다른 scope 는 서로를 삼키지 않는다**
 *   ③ 실패는 markSent 하지 않는다 — 다음 시도가 디바운스에 막히면 안 된다
 */

function recordingNotifier(result: WebhookSendResult = 'sent'): Notifier & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    send(message: string): Promise<WebhookSendResult> {
      sent.push(message);
      return Promise.resolve(result);
    },
  };
}

function make(opts: { notifier: Notifier; minIntervalMin?: number; enabled?: boolean }) {
  const clock = new ManualClock(0);
  const events: AlertEvent[] = [];
  const svc = createOpsAlertService({
    notifier: opts.notifier,
    state: createMemoryAlertState(),
    clock,
    scope: SYSTEM_SCOPE,
    minIntervalMin: opts.minIntervalMin ?? 30,
    ...(opts.enabled === undefined ? {} : { enabled: opts.enabled }),
    onEvent: (e) => events.push(e),
  });
  return { svc, clock, events };
}

describe('격리 — 절대 throw 하지 않는다', () => {
  it('★ 전송이 reject 해도 던지지 않고 failed 를 돌려준다', async () => {
    const exploding: Notifier = {
      send: () => Promise.reject(new Error('전송 계층이 터졌다')),
    };
    const { svc } = make({ notifier: exploding });

    await expect(svc.raise('live_api_unknown', '조회 실패')).resolves.toBe('failed');
  });

  it('★ 전송이 동기로 throw 해도 던지지 않는다', async () => {
    const exploding: Notifier = {
      send: () => {
        throw new Error('동기 폭발');
      },
    };
    const { svc } = make({ notifier: exploding });

    await expect(svc.raise('rss_fail', 'RSS 실패')).resolves.toBe('failed');
  });

  it('진단 로그(onEvent)가 던져도 경보를 죽이지 않는다', async () => {
    const clock = new ManualClock(0);
    const svc = createOpsAlertService({
      notifier: recordingNotifier(),
      state: createMemoryAlertState(),
      clock,
      scope: SYSTEM_SCOPE,
      minIntervalMin: 30,
      onEvent: () => {
        throw new Error('로그가 터졌다');
      },
    });
    await expect(svc.raise('heartbeat_stale', '하트비트 노후')).resolves.toBe('sent');
  });

  it('★ 실패는 markSent 하지 않는다 — 다음 시도가 디바운스에 막히면 안 된다', async () => {
    const { svc } = make({ notifier: recordingNotifier('failed') });
    expect(await svc.raise('discord_send_failed', '1차')).toBe('failed');
    // 시간이 전혀 흐르지 않았는데도 억제되지 않아야 한다.
    expect(await svc.raise('discord_send_failed', '2차')).toBe('failed');
  });
});

describe('디바운스 키 = (scope, kind)', () => {
  it('같은 (scope, kind) 는 창 안에서 억제된다', async () => {
    const notifier = recordingNotifier();
    const { svc, clock } = make({ notifier, minIntervalMin: 30 });

    expect(await svc.raise('rss_fail', '1차')).toBe('sent');
    clock.advance(29 * 60_000);
    expect(await svc.raise('rss_fail', '2차')).toBe('suppressed');
    clock.advance(1 * 60_000 + 1);
    expect(await svc.raise('rss_fail', '3차')).toBe('sent');
    expect(notifier.sent).toHaveLength(2);
  });

  it('★★ 다른 scope 는 서로를 삼키지 않는다 — 이 키잉이 고치려던 결함', async () => {
    const notifier = recordingNotifier();
    const { svc } = make({ notifier, minIntervalMin: 30 });

    const a = svc.forScope('UCchannelAAAA');
    const b = svc.forScope('UCchannelBBBB');

    expect(await a.raise('rss_fail', 'A 실패')).toBe('sent');
    // 채널 A 가 방금 냈다고 채널 B 의 같은 경보가 30분간 삼켜지면 안 된다.
    expect(await b.raise('rss_fail', 'B 실패')).toBe('sent');
    // 같은 채널의 반복만 억제된다.
    expect(await a.raise('rss_fail', 'A 재발')).toBe('suppressed');
    expect(notifier.sent).toHaveLength(2);
  });

  it('같은 scope 의 다른 kind 도 서로를 삼키지 않는다', async () => {
    const notifier = recordingNotifier();
    const { svc } = make({ notifier, minIntervalMin: 30 });
    expect(await svc.raise('rss_fail', 'a')).toBe('sent');
    expect(await svc.raise('websub_lease', 'b')).toBe('sent');
  });

  it('★ 구분자가 NUL 이라 ("a:b","c") 와 ("a","b:c") 가 섞이지 않는다', async () => {
    const notifier = recordingNotifier();
    const { svc } = make({ notifier, minIntervalMin: 30 });
    // scope 에 콜론이 들어가도 kind 경계를 침범하지 않는다.
    expect(await svc.forScope('guild:123').raise('rss_fail', 'x')).toBe('sent');
    expect(await svc.forScope('guild').raise('rss_fail', 'y')).toBe('sent');
  });

  it('억제된 건수를 다음 발송에 함께 싣는다', async () => {
    const notifier = recordingNotifier();
    const { svc, clock } = make({ notifier, minIntervalMin: 30 });

    await svc.raise('rss_fail', '1차');
    await svc.raise('rss_fail', '2차');
    await svc.raise('rss_fail', '3차');
    clock.advance(31 * 60_000);
    await svc.raise('rss_fail', '4차');

    expect(notifier.sent[1]).toContain('억제된 동일 경보 2건');
  });

  it('minIntervalMin 이 0 이면 디바운스를 끈다', async () => {
    const notifier = recordingNotifier();
    const { svc } = make({ notifier, minIntervalMin: 0 });
    expect(await svc.raise('rss_fail', 'a')).toBe('sent');
    expect(await svc.raise('rss_fail', 'b')).toBe('sent');
  });

  it('enabled:false 면 발송하지 않는다', async () => {
    const notifier = recordingNotifier();
    const { svc } = make({ notifier, enabled: false });
    expect(await svc.raise('rss_fail', 'a')).toBe('disabled');
    expect(notifier.sent).toHaveLength(0);
  });

  it('전역 경보에는 [시스템] 머리말이 붙는다', async () => {
    const notifier = recordingNotifier();
    const { svc } = make({ notifier });
    await svc.raise('downtime_detected', '중단됨');
    expect(notifier.sent[0]).toContain('[시스템]');
  });
});

describe('createSwappableAlertState', () => {
  it('갈아끼우면 이후 판정이 새 저장소를 본다', () => {
    const first = createMemoryAlertState();
    const swappable = createSwappableAlertState(first);
    swappable.markSent('s', 'rss_fail', 1_000);
    expect(swappable.lastSentAt('s', 'rss_fail')).toBe(1_000);

    // 갈아끼운 뒤에는 **옮기지 않는다** — 그 구간의 경보는 곧바로 종료로 이어진다.
    swappable.swap(createMemoryAlertState());
    expect(swappable.lastSentAt('s', 'rss_fail')).toBeUndefined();
  });

  it('억제 카운터를 올리고 비운다', () => {
    const s = createMemoryAlertState();
    expect(s.bumpSuppressed('x', 'rss_fail')).toBe(1);
    expect(s.bumpSuppressed('x', 'rss_fail')).toBe(2);
    expect(s.suppressedCount('x', 'rss_fail')).toBe(2);
    s.clearSuppressed('x', 'rss_fail');
    expect(s.suppressedCount('x', 'rss_fail')).toBe(0);
  });
});

describe('discord-webhook — 발송기', () => {
  it('URL 이 없으면 조용히 건너뛴다 (미설정은 오류가 아니다)', async () => {
    const n = createDiscordNotifier({});
    expect(await n.send('아무거나')).toBe('skipped-no-url');
  });

  it('★ 1900자로 자른다 — 디스코드 2000자 상한을 넘기면 400 이 난다', async () => {
    let body = '';
    const n = createDiscordNotifier({
      url: 'https://example.invalid/hook',
      fetchImpl: ((_u: string, init: RequestInit) => {
        body = init.body as string;
        return Promise.resolve(new Response(null, { status: 204 }));
      }) as unknown as typeof fetch,
    });
    await n.send('가'.repeat(5_000));
    const parsed = JSON.parse(body) as { content: string };
    expect(parsed.content).toHaveLength(WEBHOOK_MAX_CONTENT);
  });

  it('★ 타임아웃에서도 throw 하지 않고 failed 를 돌려준다', async () => {
    const reasons: string[] = [];
    const n = createDiscordNotifier({
      url: 'https://example.invalid/hook',
      timeoutMs: 5,
      onError: (r) => reasons.push(r),
      fetchImpl: ((_u: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener('abort', () => {
            rej(new Error('AbortError'));
          });
        })) as unknown as typeof fetch,
    });
    await expect(n.send('느린 요청')).resolves.toBe('failed');
    expect(reasons).toHaveLength(1);
  });

  it('2xx 가 아니면 failed 를 돌려주고 사유를 기록한다', async () => {
    const reasons: string[] = [];
    const n = createDiscordNotifier({
      url: 'https://example.invalid/hook',
      onError: (r) => reasons.push(r),
      fetchImpl: (() =>
        Promise.resolve(new Response(null, { status: 429 }))) as unknown as typeof fetch,
    });
    expect(await n.send('x')).toBe('failed');
    expect(reasons[0]).toContain('429');
  });
});
