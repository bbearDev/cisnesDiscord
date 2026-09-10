import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

import {
  LIVE_EVENT_PAYLOAD_VERSION,
  parseLiveStartedBody,
  parseLiveStartedEvent,
} from '../../src/chzzk/live-event-schema.js';
import { loadJsonFixture } from '../e2e/harness/fake-chzzkbot.js';

/**
 * 웹훅 페이로드 계약 (계획 §S5 · AC-14).
 *
 * ★ 이 파일의 요점은 **`version !== 1` 을 조용히 무시하지 않는다** 는 것이다.
 *   무시하면 상류가 계약을 바꾼 사실을 아무도 못 알아채고, 그동안 방송 공지가
 *   통째로 사라진다 — 침묵하는 누락(§3-a 2위)의 전형이다.
 */

const OK = 'chzzkbot/webhook-live-started.json';

describe('parseLiveStartedEvent — 정상 페이로드', () => {
  it('실제 픽스처를 통과시키고 계약 필드를 그대로 보존한다', () => {
    const r = parseLiveStartedEvent(loadJsonFixture(OK));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event).toMatchObject({
      event: 'live.started',
      version: 1,
      channelId: 'c3355ea2b3bea6c646789510796379d6',
      openDate: '2026-09-07 03:56:39',
      openedAt: '2026-09-06T18:56:39.000Z',
      liveHash: 'df09256e',
      liveTitle: '오늘은 잡담방송',
    });
  });

  it('★ liveHash 는 받은 값 그대로다 — 테스트만 재계산해 대조한다', () => {
    const r = parseLiveStartedEvent(loadJsonFixture(OK));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const recomputed = createHash('sha256')
      .update(`${r.event.channelId} ${r.event.openDate.trim()}`)
      .digest('hex')
      .slice(0, 8);
    expect(r.event.liveHash).toBe(recomputed);
  });

  it('★ 웹훅 계약에는 confirmed 칸이 없다 (폴링 전용 검사다)', () => {
    const r = parseLiveStartedEvent(loadJsonFixture(OK));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('confirmed' in r.event).toBe(false);
  });

  it('★ 이미지 두 칸은 **없어도 통과한다** — 값이 없으면 키 자체가 오지 않는다', () => {
    const base = loadJsonFixture(OK) as Record<string, unknown>;
    delete base['liveImageUrl'];
    delete base['channelImageUrl'];
    const r = parseLiveStartedEvent(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.liveImageUrl).toBeUndefined();
    expect(r.event.channelImageUrl).toBeUndefined();
  });

  it('★★ 그림 주소가 이상해도 페이로드를 거절하지 않는다 — 거절하면 그 방송 공지가 통째로 사라진다', () => {
    const base = loadJsonFixture(OK) as Record<string, unknown>;
    const r = parseLiveStartedEvent({ ...base, liveImageUrl: '깨진 주소' });
    expect(r.ok).toBe(true);
  });

  it('상류가 필드를 더해도 거부하지 않는다 (줄어드는 것만 막는다)', () => {
    const base = loadJsonFixture(OK) as Record<string, unknown>;
    const r = parseLiveStartedEvent({ ...base, brandNewField: 'whatever' });
    expect(r.ok).toBe(true);
  });

  it('선택 필드가 전부 빠져도 통과한다', () => {
    const r = parseLiveStartedEvent({
      event: 'live.started',
      version: 1,
      channelId: 'c3355ea2b3bea6c646789510796379d6',
      openDate: '2026-09-07 03:56:39',
      openedAt: '2026-09-06T18:56:39.000Z',
      liveHash: 'df09256e',
      detectedAt: '2026-09-06T18:57:31.000Z',
    });
    expect(r.ok).toBe(true);
  });
});

describe('★★ version 검증 — 계약 변경을 조용히 넘기지 않는다', () => {
  it('version: 2 픽스처는 reason=version 으로 거절된다', () => {
    const r = parseLiveStartedEvent(loadJsonFixture('chzzkbot/webhook-version2.json'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('version');
    // 운영 기록 문구가 실제 값을 실어야 사람이 무엇이 바뀌었는지 안다.
    expect(r.detail).toContain('version=2');
  });

  it('version: 0 도 거절된다 (숫자면 통과가 아니다)', () => {
    const base = loadJsonFixture(OK) as Record<string, unknown>;
    const r = parseLiveStartedEvent({ ...base, version: 0 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('version');
  });

  it('★ 모양 검증이 버전 검증보다 먼저다 — {"version":1} 한 줄이 통과하지 않는다', () => {
    const r = parseLiveStartedEvent({ version: LIVE_EVENT_PAYLOAD_VERSION });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('schema');
  });
});

describe('parseLiveStartedEvent — 계약 위반은 schema 로 갈린다', () => {
  const required = ['event', 'channelId', 'openDate', 'openedAt', 'liveHash', 'detectedAt'];

  it.each(required)('필수 필드 %s 가 빠지면 거절한다', (field) => {
    const { [field]: _dropped, ...withoutField } = loadJsonFixture(OK) as Record<string, unknown>;
    const r = parseLiveStartedEvent(withoutField);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('schema');
    expect(r.detail).toContain(field);
  });

  it('event 이름이 다르면 거절한다', () => {
    const base = loadJsonFixture(OK) as Record<string, unknown>;
    const r = parseLiveStartedEvent({ ...base, event: 'live.ended' });
    expect(r.ok).toBe(false);
  });

  it('★ openedAt 이 ISO-8601 로 해석되지 않으면 거절한다 (시각 계산의 출발점이다)', () => {
    const base = loadJsonFixture(OK) as Record<string, unknown>;
    const r = parseLiveStartedEvent({ ...base, openedAt: '2026-09-07 03:56:39' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.detail).toContain('openedAt');
  });

  it('★★ openDate 에는 ISO 검사를 걸지 않는다 — 시간대 없는 KST 원문이 정상이다', () => {
    const base = loadJsonFixture(OK) as Record<string, unknown>;
    const r = parseLiveStartedEvent({ ...base, openDate: '2026-09-07 03:56:39' });
    expect(r.ok).toBe(true);
  });
});

describe('parseLiveStartedBody — 본문 버퍼', () => {
  it('JSON 이 아니면 reason=body 로 거절한다', () => {
    const r = parseLiveStartedBody(Buffer.from('<html>nope</html>'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('body');
  });

  it('빈 본문도 던지지 않고 거절값을 준다', () => {
    const r = parseLiveStartedBody(Buffer.alloc(0));
    expect(r.ok).toBe(false);
  });

  it('정상 본문은 통과한다', () => {
    const r = parseLiveStartedBody(Buffer.from(JSON.stringify(loadJsonFixture(OK))));
    expect(r.ok).toBe(true);
  });
});
