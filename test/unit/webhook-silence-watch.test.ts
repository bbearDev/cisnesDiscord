import { describe, it, expect, beforeEach } from 'vitest';

import { ManualClock } from '../../src/runtime/clock.js';
import {
  createWebhookSilenceWatch,
  RECEIPT_RETENTION_FACTOR,
  type WebhookSilenceEvent,
  type WebhookSilenceWatch,
} from '../../src/live/webhook-silence-watch.js';
import { createFakeOpsAlerts, type FakeOpsAlerts } from '../helpers/ops-alerts.js';

/**
 * ★ AC-P6 — 웹훅 침묵 감시 (계획 §S5).
 *
 * ★★ **유예창을 양방향으로 본다.**
 *   - 창을 넘겨 웹훅이 안 오면 → 경보 **1건**
 *   - 창 **안**에 오면 → 경보 **0건**
 *
 *   두 번째가 더 중요하다. *"우리가 ≤ 7분 다운 → chzzkbot 재시도 큐가 메운다"* 는
 *   **정상 시퀀스**이고, 그 사이 폴링이 먼저 방송을 찾는다. 여기서 경보하면
 *   웹훅이 멀쩡한데 오경보가 뜨고 **그 오경보가 진짜 신호를 덮는다.**
 */

const GRACE_MS = 10 * 60_000; // live.webhookSilenceGraceMin 기본 10분
const HASH = 'df09256e';

let clock: ManualClock;
let alerts: FakeOpsAlerts;
let events: WebhookSilenceEvent[];
let watch: WebhookSilenceWatch;

beforeEach(() => {
  clock = new ManualClock(1_000_000);
  alerts = createFakeOpsAlerts('c3355ea2b3bea6c646789510796379d6');
  events = [];
  watch = createWebhookSilenceWatch({
    clock,
    alerts: alerts.service,
    graceMs: GRACE_MS,
    onEvent: (e) => events.push(e),
  });
});

describe('유예창을 넘긴 침묵', () => {
  it('★ 선점 후 10분이 지나도 웹훅이 없으면 경보 정확히 1건', () => {
    watch.noteClaim(HASH);
    expect(watch.armed).toBe(1);

    clock.advance(GRACE_MS);
    expect(alerts.countOf('webhook_silence')).toBe(1);
    expect(watch.armed).toBe(0);
  });

  it('★ 9분 59초에서는 0건 (경계에서 앞서 울지 않는다)', () => {
    watch.noteClaim(HASH);
    clock.advance(GRACE_MS - 1_000);
    expect(alerts.countOf('webhook_silence')).toBe(0);
  });

  it('경보를 낸 뒤 시간이 더 흘러도 도배하지 않는다 (방송 하나에 경보 하나)', () => {
    watch.noteClaim(HASH);
    clock.advance(GRACE_MS * 10);
    expect(alerts.countOf('webhook_silence')).toBe(1);
  });

  it('경보 문구에 확인 절차가 실린다', () => {
    watch.noteClaim(HASH);
    clock.advance(GRACE_MS);
    const msg = alerts.raised[0]!.message;
    expect(msg).toContain(HASH);
    expect(msg).toContain('LIVE_EVENT_WEBHOOK_TOKEN');
    expect(msg).toContain('10분');
  });
});

describe('★★ 유예창 안에 도착한 웹훅 — 경보 0건', () => {
  it('선점 5분 뒤 웹훅이 오면 경보가 나지 않는다 ("다운 ≤ 7분" 정상 시퀀스)', () => {
    watch.noteClaim(HASH);
    clock.advance(5 * 60_000);
    watch.noteWebhook(HASH);

    clock.advance(GRACE_MS * 3);
    expect(alerts.countOf('webhook_silence')).toBe(0);
    expect(watch.armed).toBe(0);
    expect(events.find((e) => e.type === 'matched')?.waitedMs).toBe(5 * 60_000);
  });

  it('경계 직전(9분 59초)에 도착해도 경보 0건', () => {
    watch.noteClaim(HASH);
    clock.advance(GRACE_MS - 1_000);
    watch.noteWebhook(HASH);
    clock.advance(GRACE_MS);
    expect(alerts.countOf('webhook_silence')).toBe(0);
  });

  it('★ 웹훅이 선점보다 **먼저** 오면 감시를 아예 걸지 않는다 (웹훅 경로 자기 선점)', () => {
    watch.noteWebhook(HASH);
    watch.noteClaim(HASH);
    expect(watch.armed).toBe(0);
    clock.advance(GRACE_MS * 2);
    expect(alerts.countOf('webhook_silence')).toBe(0);
  });

  it('다른 liveHash 의 웹훅은 이 방송의 침묵을 지우지 않는다', () => {
    watch.noteClaim(HASH);
    watch.noteWebhook('deadbeef');
    clock.advance(GRACE_MS);
    expect(alerts.countOf('webhook_silence')).toBe(1);
  });
});

describe('그 밖의 규율', () => {
  it('늦게 도착한 웹훅은 경보를 취소하지 않고 late 로 기록된다', () => {
    watch.noteClaim(HASH);
    clock.advance(GRACE_MS);
    expect(alerts.countOf('webhook_silence')).toBe(1);

    clock.advance(60_000);
    watch.noteWebhook(HASH);
    const late = events.find((e) => e.type === 'late');
    expect(late?.liveHash).toBe(HASH);
    expect(alerts.countOf('webhook_silence')).toBe(1);
  });

  it('같은 liveHash 로 두 번 선점해도 타이머는 하나다', () => {
    watch.noteClaim(HASH);
    watch.noteClaim(HASH);
    expect(watch.armed).toBe(1);
    clock.advance(GRACE_MS);
    expect(alerts.countOf('webhook_silence')).toBe(1);
  });

  it('방송이 여러 건이면 각각 별개로 센다', () => {
    watch.noteClaim('aaaa1111');
    watch.noteClaim('bbbb2222');
    clock.advance(GRACE_MS / 2);
    watch.noteWebhook('aaaa1111');
    clock.advance(GRACE_MS);
    expect(alerts.countOf('webhook_silence')).toBe(1);
    expect(alerts.raised[0]!.message).toContain('bbbb2222');
  });

  it('★ 수신 기록이 무한히 쌓이지 않는다 (유예창의 4배가 지나면 정리된다)', () => {
    for (let i = 0; i < 50; i++) {
      watch.noteWebhook(`hash-${String(i)}`);
      clock.advance(GRACE_MS);
    }
    // 오래된 기록이 정리됐으므로, 그 시절 해시로 선점하면 감시가 **걸린다**.
    watch.noteClaim('hash-0');
    expect(watch.armed).toBe(1);
    // 최근 기록은 살아 있어 감시가 걸리지 않는다.
    watch.noteClaim('hash-49');
    expect(watch.armed).toBe(1);
    expect(RECEIPT_RETENTION_FACTOR).toBeGreaterThan(1);
  });

  it('dispose 하면 타이머가 남지 않고 이후 경보도 없다', () => {
    watch.noteClaim(HASH);
    expect(clock.pending).toBe(1);
    watch.dispose();
    expect(clock.pending).toBe(0);
    clock.advance(GRACE_MS * 2);
    expect(alerts.countOf('webhook_silence')).toBe(0);

    // dispose 뒤의 호출은 조용히 무시된다 (종료 중에 던지면 안 된다).
    watch.noteClaim(HASH);
    watch.noteWebhook(HASH);
    expect(watch.armed).toBe(0);
  });
});
