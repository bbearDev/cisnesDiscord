import { describe, it, expect } from 'vitest';

import type { FollowerLookup } from '../../src/chzzk/follower-check.js';
import {
  FOLLOW_DAYS_COMMAND,
  FOLLOW_DAYS_COMMAND_NAME,
  createFollowDaysCommand,
  followDays,
} from '../../src/discord/commands/follow-days.js';
import type { CommandContext } from '../../src/discord/commands/types.js';
import { OPTION_TYPE_USER } from '../../src/discord/commands/types.js';
import { ManualClock } from '../../src/runtime/clock.js';
import type { AccountLink, LinkRepo } from '../../src/store/repos/link-repo.js';

/**
 * `/팔로우` (운영자 전용).
 *
 * ★★ 이 파일이 지키는 문장:
 *   ① **운영자만** 실행한다 — 디스코드의 표시 제어는 관리자가 UI 로 덮을 수 있다
 *   ② 연동이 없으면 상류에 묻지 않는다 — 치지직 채널을 모르는데 물을 수 없다
 *   ③ `unknown` 을 **"미팔로우" 로 적지 않는다** — 게이트가 지키는 문장을 운영자 명령이 깨면
 *      운영자가 그 오해로 사람을 내보낸다
 *   ④ 일수는 KST 날짜 경계로 세고 오늘이 1일째다 — 상류 `!팔로우` 와 같은 숫자
 *   ⑤ 어떤 경우에도 던지지 않는다
 */

const OPERATOR: CommandContext = { guildId: 'g1', userId: 'op', isOperator: true, targetUserId: 'u1' };
const MEMBER: CommandContext = { guildId: 'g1', userId: 'u2', isOperator: false, targetUserId: 'u1' };

/** 2026-09-21 12:00 KST */
const NOW = Date.parse('2026-09-21T03:00:00.000Z');
const CACHED_AT = '2026-09-21T02:55:00.000Z';

const LINK: AccountLink = {
  discordUserId: 'u1',
  guildId: 'g1',
  chzzkChannelId: 'aaaa1111bbbb2222cccc3333dddd4444',
  chzzkChannelName: '시청자',
  linkedAt: '2026-09-20T00:00:00.000Z',
};

function links(rows: AccountLink[]): LinkRepo {
  return {
    get: (guildId, userId) => rows.find((r) => r.guildId === guildId && r.discordUserId === userId),
    link: () => {
      throw new Error('not used');
    },
    getByChannel: () => undefined,
    unlink: () => undefined,
    opsEvents: () => [],
    count: () => rows.length,
  };
}

function make(opts: { lookup?: FollowerLookup; links?: AccountLink[]; throws?: boolean } = {}) {
  const clock = new ManualClock(NOW);
  const asked: string[] = [];
  const logs: { message: string; extra?: Record<string, unknown> }[] = [];
  const cmd = createFollowDaysCommand({
    links: links(opts.links ?? [LINK]),
    followers: {
      inspect: (viewerChannelId) => {
        asked.push(viewerChannelId);
        if (opts.throws === true) return Promise.reject(new Error('판정기가 죽었다'));
        return Promise.resolve(
          opts.lookup ?? { verdict: 'yes', cachedAt: CACHED_AT, snapshotAgeSec: 300, followedAt: '2026-09-11T07:20:46.000Z' },
        );
      },
    },
    clock,
    onLog: (message, extra) => {
      logs.push(extra === undefined ? { message } : { message, extra });
    },
  });
  return { cmd, clock, asked, logs };
}

describe('정의', () => {
  it('운영자에게만 보이고 DM 에서는 안 쓰며, 대상은 필수다', () => {
    expect(FOLLOW_DAYS_COMMAND.name).toBe(FOLLOW_DAYS_COMMAND_NAME);
    expect(FOLLOW_DAYS_COMMAND.dm_permission).toBe(false);
    expect(FOLLOW_DAYS_COMMAND.default_member_permissions).toBe('32');
    // ★ 조립부가 `TARGET_OPTION_NAME`('대상') 하나로 대상을 뽑는다 — 이름이 다르면 대상이 영영 비어 온다
    expect(FOLLOW_DAYS_COMMAND.options).toEqual([
      expect.objectContaining({ type: OPTION_TYPE_USER, name: '대상', required: true }),
    ]);
  });

  it('★ defer 다 — 상류 조회 회당 타임아웃이 3초라 상호작용 창을 넘길 수 있다', () => {
    expect(make().cmd.defer).toBe(true);
  });
});

describe('★★ 운영자만 실행한다', () => {
  it('일반 멤버는 거부되고 상류에 묻지 않는다', async () => {
    const { cmd, asked } = make();
    const r = await cmd.execute(MEMBER);
    expect(r.ephemeral).toBe(true);
    expect(r.content).toContain('운영자만');
    expect(asked, '거부됐는데 상류를 두드렸다').toHaveLength(0);
  });

  it('isOperator 가 없으면(미상) 거부한다 — 모르면 막는 쪽이다', async () => {
    const { cmd, asked } = make();
    const r = await cmd.execute({ guildId: 'g1', userId: 'u3', targetUserId: 'u1' });
    expect(r.content).toContain('운영자만');
    expect(asked).toHaveLength(0);
  });
});

describe('★ 연동이 없으면 상류에 묻지 않는다', () => {
  it('대상이 비었으면 지정을 요청한다', async () => {
    const { cmd, asked } = make();
    const r = await cmd.execute({ guildId: 'g1', userId: 'op', isOperator: true });
    expect(r.content).toContain('대상');
    expect(asked).toHaveLength(0);
  });

  it('연동 행이 없으면 그 사실을 말하고 끝난다 — 치지직 채널을 모른다', async () => {
    const { cmd, asked } = make({ links: [] });
    const r = await cmd.execute(OPERATOR);
    expect(r.content).toContain('연동돼 있지 않습니다');
    expect(r.content).toContain('<@u1>');
    expect(asked).toHaveLength(0);
  });

  it('다른 길드의 연동은 보지 않는다', async () => {
    const { cmd, asked } = make({ links: [{ ...LINK, guildId: 'g-other' }] });
    const r = await cmd.execute(OPERATOR);
    expect(r.content).toContain('연동돼 있지 않습니다');
    expect(asked).toHaveLength(0);
  });
});

describe('판정별 답', () => {
  it('yes + followedAt → 며칠째인지와 시작 시각(KST)·스냅샷 시각을 싣는다', async () => {
    const { cmd, asked } = make();
    const r = await cmd.execute(OPERATOR);
    // 연동 행의 치지직 채널로 물었다
    expect(asked).toEqual([LINK.chzzkChannelId]);
    expect(r.ephemeral).toBe(true);
    expect(r.content).toContain('<@u1>');
    expect(r.content).toContain('**시청자**');
    // 2026-09-11 16:20 KST 팔로우 · 지금 2026-09-21 12:00 KST → 11일째
    expect(r.content).toContain('**11일째**');
    expect(r.content).toContain('2026-09-11 16:20 KST');
    expect(r.content).toContain('팔로워 목록 스냅샷 기준: 2026-09-21 11:55 KST');
  });

  it('yes 인데 followedAt 이 없으면 "팔로우 중, 시작일 미상" — 옛 판 상류에서도 명령이 값을 낸다', async () => {
    const { cmd } = make({ lookup: { verdict: 'yes', cachedAt: CACHED_AT, snapshotAgeSec: 300 } });
    const r = await cmd.execute(OPERATOR);
    expect(r.content).toContain('**팔로우 중**');
    expect(r.content).toContain('시작일은 확인하지 못했습니다');
    expect(r.content).not.toContain('일째');
  });

  it('★ 시간대 없는 followedAt 은 시작일 미상으로 답한다 — 서버 시간대로 읽어 하루 어긋나느니 모른다고 한다', async () => {
    const { cmd } = make({
      lookup: { verdict: 'yes', cachedAt: CACHED_AT, snapshotAgeSec: 300, followedAt: '2026-09-11 16:20:46' },
    });
    const r = await cmd.execute(OPERATOR);
    expect(r.content).toContain('시작일은 확인하지 못했습니다');
    expect(r.content).not.toContain('일째');
  });

  it('±HH:MM 오프셋도 시간대다 — KST 표기 원문이면 그대로 센다', async () => {
    const { cmd } = make({
      lookup: { verdict: 'yes', cachedAt: CACHED_AT, snapshotAgeSec: 300, followedAt: '2026-09-11T16:20:46+09:00' },
    });
    const r = await cmd.execute(OPERATOR);
    expect(r.content).toContain('**11일째**');
    expect(r.content).toContain('2026-09-11 16:20 KST');
  });

  it('no → 팔로워로 확인되지 않았다', async () => {
    const { cmd } = make({ lookup: { verdict: 'no', cachedAt: CACHED_AT, snapshotAgeSec: 300 } });
    const r = await cmd.execute(OPERATOR);
    expect(r.content).toContain('팔로워로 확인되지 않았습니다');
    expect(r.content).not.toContain('일째');
  });

  it('★★ unknown → 사유를 적되 "미팔로우" 로 읽히지 않게 한다', async () => {
    const { cmd } = make({ lookup: { verdict: 'unknown', reason: 'stale', cachedAt: CACHED_AT, snapshotAgeSec: 9000 } });
    const r = await cmd.execute(OPERATOR);
    expect(r.content).toContain('**확인하지 못했습니다**');
    expect(r.content).toContain('최신이 아닙니다');
    expect(r.content).toContain('팔로우하지 않았다는 뜻이 아닙니다');
    expect(r.content).not.toContain('확인되지 않았습니다');
  });

  it('unknown 인데 cachedAt 이 없으면(형태 불량) 스냅샷 줄이 그 사실을 말한다', async () => {
    const { cmd } = make({ lookup: { verdict: 'unknown', reason: 'bad-shape' } });
    const r = await cmd.execute(OPERATOR);
    expect(r.content).toContain('해석하지 못했습니다');
    expect(r.content).toContain('스냅샷 시각: 확인하지 못했습니다');
  });
});

describe('★ 던지지 않는다', () => {
  it('판정기가 던져도 사람 말로 답하고 로그를 남긴다', async () => {
    const { cmd, logs } = make({ throws: true });
    const r = await cmd.execute(OPERATOR);
    expect(r.ephemeral).toBe(true);
    expect(r.content).toContain('오류가 났습니다');
    expect(r.content).toContain('판정기가 죽었다');
    expect(logs.some((l) => l.message.includes('실패'))).toBe(true);
  });

  it('로그 훅이 던져도 명령은 답한다', async () => {
    const cmd = createFollowDaysCommand({
      links: links([LINK]),
      followers: { inspect: () => Promise.resolve({ verdict: 'no' }) },
      clock: new ManualClock(NOW),
      onLog: () => {
        throw new Error('logger down');
      },
    });
    const r = await cmd.execute(OPERATOR);
    expect(r.content).toContain('팔로워로 확인되지 않았습니다');
  });
});

describe('★ followDays — KST 날짜 경계, 오늘이 1일째 (상류 `!팔로우` 와 같은 규칙)', () => {
  /** 2026-09-21 00:00 KST */
  const KST_MIDNIGHT = Date.parse('2026-09-20T15:00:00.000Z');

  it('오늘 팔로우했으면 1 이다 — 0일이 아니다', () => {
    expect(followDays(Date.parse('2026-09-21T02:59:00.000Z'), NOW)).toBe(1);
  });

  it('★ 경계는 KST 자정이다 — UTC 로 세면 하루가 어긋난다', () => {
    // 팔로우 23:59:59 KST(전날) · 지금 00:00:00 KST → 2일째
    expect(followDays(KST_MIDNIGHT - 1_000, KST_MIDNIGHT)).toBe(2);
    // 팔로우 00:00:00 KST · 지금 같은 날 → 1일째
    expect(followDays(KST_MIDNIGHT, KST_MIDNIGHT)).toBe(1);
    // 같은 두 시각을 UTC 날짜로 보면 둘 다 09-20 이라 하루 차이가 안 난다 — 그 함정을 피했다
    expect(new Date(KST_MIDNIGHT - 1_000).toISOString().slice(0, 10)).toBe('2026-09-20');
    expect(new Date(KST_MIDNIGHT).toISOString().slice(0, 10)).toBe('2026-09-20');
  });

  it('열흘 전이면 11 이다', () => {
    expect(followDays(Date.parse('2026-09-11T07:20:46.000Z'), NOW)).toBe(11);
  });

  it('미래 시각(시계 어긋남)은 1 로 접는다 — 음수를 답하지 않는다', () => {
    expect(followDays(Date.parse('2026-12-01T00:00:00.000Z'), NOW)).toBe(1);
  });
});
