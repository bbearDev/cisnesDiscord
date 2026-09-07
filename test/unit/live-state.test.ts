import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

import {
  LiveApiResponseSchema,
  type LiveApiChannel,
  type LiveApiFailure,
} from '../../src/chzzk/live-api-schema.js';
import { selectChannel } from '../../src/chzzk/live-api-client.js';
import {
  isConfirmedStuck,
  isUnknown,
  judgeLiveState,
  type LiveJudgment,
  type LiveState,
} from '../../src/live/live-state.js';
import { loadJsonFixture } from '../e2e/harness/fake-chzzkbot.js';

/**
 * ★★★ 3상태 판정기 — **유일한 판정 지점** (계획 §5.1 · DD-2 · AC-31).
 *
 * 이 파일이 지키는 문장은 하나다:
 *   **`unknown` 은 `ended` 로도 `announce` 로도 접히지 않는다.**
 * 접는 순간 AC-31 의 판정 근거가 무너진다 — "모름"을 "꺼짐"으로 읽으면 진행 중인
 * 방송을 놓치고, "켜짐"으로 읽으면 끝난 방송에 시작 공지가 나간다.
 */

const OURS = 'c3355ea2b3bea6c646789510796379d6';
const FOREIGN = '3594a5258433f765b6247dfe05e5fb33';

function channel(over: Partial<LiveApiChannel> = {}): LiveApiChannel {
  return {
    channelId: OURS,
    live: false,
    confirmed: false,
    exact: false,
    status: 'running',
    ...over,
  };
}

const STATUSES: (string | undefined)[] = ['running', 'starting', 'failed', 'stopped', undefined];
const ALL_FAILURES: LiveApiFailure[] = [
  'timeout',
  'network',
  'budget',
  'http',
  'bad-body',
  'schema',
];

/** 계획이 정의한 판정식 그대로. 구현과 **독립적으로** 기대값을 만든다 */
function expected(live: boolean, confirmed: boolean, status: string | undefined, hash: boolean): LiveState {
  if (live && confirmed && hash) return 'announce';
  if (!live && status === 'running') return 'ended';
  return 'unknown';
}

describe('judgeLiveState — live × confirmed × status × liveHash 전수 행렬', () => {
  it('★ 40가지 조합이 전부 정확히 세 상태 중 하나로만 접힌다', () => {
    const seen: Record<LiveState, number> = { announce: 0, ended: 0, unknown: 0 };

    for (const live of [true, false]) {
      for (const confirmed of [true, false]) {
        for (const status of STATUSES) {
          for (const hash of [true, false]) {
            const ch = channel({
              live,
              confirmed,
              exact: confirmed,
              ...(status === undefined ? {} : { status }),
              ...(hash ? { liveHash: 'df09256e', openDate: '2026-09-07 03:56:39' } : {}),
            });
            // status: undefined 를 명시적으로 지운다 (스프레드로는 키가 남는다)
            if (status === undefined) delete (ch as { status?: string }).status;

            const j = judgeLiveState({ kind: 'channel', channel: ch });
            const want = expected(live, confirmed, status, hash);
            expect(
              j.state,
              `live=${String(live)} confirmed=${String(confirmed)} status=${String(status)} hash=${String(hash)}`,
            ).toBe(want);
            seen[j.state] += 1;
          }
        }
      }
    }

    // 세 상태가 전부 실제로 나왔다 — 행렬이 한쪽으로 쏠려 있지 않다는 증거다.
    expect(seen.announce).toBeGreaterThan(0);
    expect(seen.ended).toBeGreaterThan(0);
    expect(seen.unknown).toBeGreaterThan(0);
    expect(seen.announce + seen.ended + seen.unknown).toBe(2 * 2 * 5 * 2);
  });

  it('★★ status !== running 에서는 ended 가 단 한 번도 나오지 않는다', () => {
    for (const status of ['starting', 'failed', 'stopped']) {
      for (const live of [true, false]) {
        for (const confirmed of [true, false]) {
          const j = judgeLiveState({
            kind: 'channel',
            channel: channel({ live, confirmed, exact: confirmed, status }),
          });
          expect(j.state, `status=${status}`).not.toBe('ended');
        }
      }
    }
  });

  it('status 필드가 아예 없어도 ended 로 접지 않는다', () => {
    const ch = channel();
    delete (ch as { status?: string }).status;
    expect(judgeLiveState({ kind: 'channel', channel: ch })).toEqual({
      state: 'unknown',
      reason: 'status-not-running',
    });
  });
});

describe('judgeLiveState — 세 상태의 정의', () => {
  it('announce ⟸ live && confirmed && liveHash 존재', () => {
    const j = judgeLiveState({
      kind: 'channel',
      channel: channel({ live: true, confirmed: true, exact: true, liveHash: 'df09256e' }),
    });
    expect(j.state).toBe('announce');
    expect(j).toMatchObject({ liveHash: 'df09256e' });
  });

  it('★ live && confirmed 인데 liveHash 가 없으면 announce 가 아니라 unknown 이다', () => {
    // 공지할 키가 없다. 키 없이 보내면 중복을 막을 수단이 사라진다.
    expect(
      judgeLiveState({
        kind: 'channel',
        channel: channel({ live: true, confirmed: true, exact: true }),
      }),
    ).toEqual({ state: 'unknown', reason: 'no-identity' });
  });

  it('liveHash 가 빈 문자열이어도 unknown 이다', () => {
    expect(
      judgeLiveState({
        kind: 'channel',
        channel: channel({ live: true, confirmed: true, exact: true, liveHash: '' }),
      }),
    ).toEqual({ state: 'unknown', reason: 'no-identity' });
  });

  it('★★ DD-2 — live:true, confirmed:false 는 unknown 이며 절대 공지 대상이 아니다', () => {
    const j = judgeLiveState({
      kind: 'channel',
      channel: channel({ live: true, confirmed: false, liveHash: 'df09256e' }),
    });
    expect(j).toEqual({ state: 'unknown', reason: 'unconfirmed' });
    expect(isConfirmedStuck(j)).toBe(true);
  });

  it('★ rev.5 실측 평상시 응답(!live, status:running)은 ended 이며 정상이다', () => {
    const j = judgeLiveState({ kind: 'channel', channel: channel() });
    expect(j.state).toBe('ended');
    // 경보 축 어디에도 걸리지 않는다 — 방송이 없는 하루 대부분이 이 상태다.
    expect(isUnknown(j)).toBe(false);
    expect(isConfirmedStuck(j)).toBe(false);
  });
});

describe('judgeLiveState — 조회 실패는 전부 unknown 이다', () => {
  it('★ timeout · network · budget · http · bad-body · schema 가 하나도 빠짐없이 unknown', () => {
    for (const failure of ALL_FAILURES) {
      const j = judgeLiveState({ kind: 'failure', failure });
      expect(j.state, failure).toBe('unknown');
      expect(isUnknown(j)).toBe(true);
    }
  });

  it('401 · 404 · 5xx 는 전부 http 실패이고 ended 가 아니다', () => {
    // chzzkbot 이 죽었거나 토큰이 틀렸다 — "방송이 끝났다" 가 아니다.
    const j = judgeLiveState({ kind: 'failure', failure: 'http', detail: 'status 500' });
    expect(j).toMatchObject({ state: 'unknown', reason: 'transport', detail: 'status 500' });
  });

  it('스키마 불일치는 schema 이유로 unknown 이다', () => {
    expect(judgeLiveState({ kind: 'failure', failure: 'schema' })).toMatchObject({
      state: 'unknown',
      reason: 'schema',
    });
  });

  it('응답에 우리 채널이 없으면 unknown(channel-missing) 이다', () => {
    expect(judgeLiveState({ kind: 'channel-missing' })).toEqual({
      state: 'unknown',
      reason: 'channel-missing',
    });
  });

  it('★★ 어떤 입력으로도 unknown 이 ended/announce 로 새지 않는다', () => {
    const unknowns: LiveJudgment[] = [
      ...ALL_FAILURES.map((failure) => judgeLiveState({ kind: 'failure', failure })),
      judgeLiveState({ kind: 'channel-missing' }),
      judgeLiveState({ kind: 'channel', channel: channel({ live: true }) }),
      judgeLiveState({ kind: 'channel', channel: channel({ status: 'starting' }) }),
      judgeLiveState({ kind: 'channel', channel: channel({ live: true, confirmed: true, exact: true }) }),
    ];
    for (const j of unknowns) {
      expect(j.state).toBe('unknown');
    }
  });
});

describe('★ 채널 필터 — 실측 2채널 픽스처 (§5.1 rev.5)', () => {
  it('평상시 2채널 응답: 우리 채널만 판정하고 남의 채널은 목록에 남는다', () => {
    const parsed = LiveApiResponseSchema.parse(
      loadJsonFixture('chzzkbot/api-live-2channels-idle.json'),
    );
    const { target, unknownChannelIds } = selectChannel(parsed, OURS);
    expect(target?.channelId).toBe(OURS);
    expect(unknownChannelIds).toEqual([FOREIGN]);
    expect(judgeLiveState({ kind: 'channel', channel: target! }).state).toBe('ended');
  });

  it('★★ 남의 채널만 방송 중이면 우리 판정은 ended 다 — 공지 대상이 아니다', () => {
    const parsed = LiveApiResponseSchema.parse(
      loadJsonFixture('chzzkbot/api-live-foreign-channel-live.json'),
    );
    const { target, unknownChannelIds } = selectChannel(parsed, OURS);
    expect(unknownChannelIds).toEqual([FOREIGN]);
    expect(judgeLiveState({ kind: 'channel', channel: target! }).state).toBe('ended');

    // 필터를 빠뜨렸다면 아이곰이 announce 로 판정된다 — 그게 이 픽스처가 막는 회귀다.
    const foreign = parsed.channels.find((c) => c.channelId === FOREIGN)!;
    expect(judgeLiveState({ kind: 'channel', channel: foreign }).state).toBe('announce');
  });

  it('announce 픽스처: liveHash 를 재계산해 대조한다 (우리가 계산하지 않는다는 것의 검증)', () => {
    const parsed = LiveApiResponseSchema.parse(loadJsonFixture('chzzkbot/api-live-announce.json'));
    const { target } = selectChannel(parsed, OURS);
    const j = judgeLiveState({ kind: 'channel', channel: target! });
    expect(j.state).toBe('announce');

    const recomputed = createHash('sha256')
      .update(`${target!.channelId} ${target!.openDate!.trim()}`)
      .digest('hex')
      .slice(0, 8);
    expect(recomputed).toBe('df09256e');
    expect(j).toMatchObject({ liveHash: recomputed });
  });

  it('unconfirmed 픽스처 → unknown, status-starting 픽스처 → unknown', () => {
    for (const [file, reason] of [
      ['chzzkbot/api-live-unconfirmed.json', 'unconfirmed'],
      ['chzzkbot/api-live-status-starting.json', 'status-not-running'],
    ] as const) {
      const parsed = LiveApiResponseSchema.parse(loadJsonFixture(file));
      const { target } = selectChannel(parsed, OURS);
      expect(judgeLiveState({ kind: 'channel', channel: target! }), file).toEqual({
        state: 'unknown',
        reason,
      });
    }
  });
});
