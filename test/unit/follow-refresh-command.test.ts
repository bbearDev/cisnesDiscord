import { describe, it, expect } from 'vitest';

import type { FollowerSyncResult } from '../../src/chzzk/follower-check.js';
import {
  FOLLOW_REFRESH_COMMAND,
  FOLLOW_REFRESH_COMMAND_NAME,
  createFollowRefreshCommand,
} from '../../src/discord/commands/follow-refresh.js';
import type { CommandContext } from '../../src/discord/commands/types.js';

/**
 * `/팔로우갱신` (운영자 전용).
 *
 * ★★ 이 파일이 지키는 문장:
 *   ① **운영자만** 실행한다 — 거부되면 상류를 두드리지 않는다
 *   ② 상류 응답 갈래마다 운영자가 할 일이 다르다 — 갈래마다 문장이 따로 있다
 *   ③ 타임아웃·형태 불량을 **"실패" 로 적지 않는다** — 상류 동기화는 계속 돌 수 있다
 *   ④ 어떤 경우에도 던지지 않는다
 */

const OPERATOR: CommandContext = { guildId: 'g1', userId: 'op', isOperator: true };
const MEMBER: CommandContext = { guildId: 'g1', userId: 'u2', isOperator: false };

function make(result: FollowerSyncResult | Error) {
  let calls = 0;
  const logs: { message: string; extra?: Record<string, unknown> }[] = [];
  const cmd = createFollowRefreshCommand({
    followers: {
      requestSync: () => {
        calls += 1;
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      },
    },
    onLog: (message, extra) => {
      logs.push(extra === undefined ? { message } : { message, extra });
    },
  });
  return { cmd, logs, calls: () => calls };
}

describe('정의', () => {
  it('운영자에게만 보이고 DM 에서는 안 쓰며, 옵션이 없다', () => {
    expect(FOLLOW_REFRESH_COMMAND.name).toBe(FOLLOW_REFRESH_COMMAND_NAME);
    expect(FOLLOW_REFRESH_COMMAND.dm_permission).toBe(false);
    expect(FOLLOW_REFRESH_COMMAND.default_member_permissions).toBe('32');
    expect(FOLLOW_REFRESH_COMMAND.options).toBeUndefined();
  });

  it('★ defer 다 — 상류는 전수가 끝난 뒤에 답한다', () => {
    expect(make({ outcome: 'unauthorized' }).cmd.defer).toBe(true);
  });
});

describe('★★ 운영자만 실행한다', () => {
  it('일반 멤버는 거부되고 상류를 두드리지 않는다', async () => {
    const m = make({ outcome: 'unauthorized' });
    const r = await m.cmd.execute(MEMBER);
    expect(r.content).toBe('이 명령은 서버 관리 권한(`Manage Guild`)이 있는 운영자만 사용할 수 있습니다.');
    expect(r.ephemeral).toBe(true);
    expect(m.calls(), '거부됐는데 상류를 두드렸다').toBe(0);
  });

  it('isOperator 가 없으면(미상) 거부한다', async () => {
    const m = make({ outcome: 'unauthorized' });
    await m.cmd.execute({ guildId: 'g1', userId: 'u3' });
    expect(m.calls()).toBe(0);
  });
});

describe('응답 갈래', () => {
  it('200 — 명수 · 기준 시각(KST) · 걸린 시간 · 다시 시도 안내', async () => {
    const m = make({ outcome: 'synced', count: 612, cachedAt: '2026-10-04T03:00:00.000Z', durationMs: 8_400 });
    const r = await m.cmd.execute(OPERATOR);
    expect(r.content).toContain('**612명**');
    expect(r.content).toContain('2026-10-04 12:00 KST');
    expect(r.content).toContain('8.4초');
    expect(r.content).toContain('인증을 다시 시도');
    expect(m.logs).toEqual([
      { message: '팔로워 목록 수동 갱신', extra: { by: 'op', outcome: 'synced', count: 612, durationMs: 8_400 } },
    ]);
  });

  it('★ 200 joined — 합류했으니 아직 안 보이면 한 번 더 누르라고 덧붙인다', async () => {
    const m = make({ outcome: 'synced', count: 658, cachedAt: '2026-10-04T03:00:00.000Z', durationMs: 20_000, joined: true });
    const r = await m.cmd.execute(OPERATOR);
    expect(r.content).toContain('**658명**');
    expect(r.content).toContain('진행 중이던 동기화에 합류했습니다');
    expect(r.content).toContain('한 번 더 눌러 주십시오');
    expect(r.content).toContain('쿨다운이 걸리지 않습니다');
    expect(m.logs[0]?.extra).toEqual({ by: 'op', outcome: 'synced', count: 658, durationMs: 20_000, joined: true });
  });

  it('200 joined 없음 — 합류 문구가 없다', async () => {
    const r = await make({ outcome: 'synced', count: 1, cachedAt: '2026-10-04T03:00:00.000Z', durationMs: 1 }).cmd.execute(
      OPERATOR,
    );
    expect(r.content).not.toContain('합류');
  });

  it('429 — 남은 초와 지금 목록 시각', async () => {
    const r = await make({ outcome: 'cooldown', retryAfterSec: 42, cachedAt: '2026-10-04T03:00:00.000Z' }).cmd.execute(
      OPERATOR,
    );
    expect(r.content).toContain('방금 갱신됐습니다');
    expect(r.content).toContain('42초 뒤에');
    expect(r.content).toContain('2026-10-04 12:00 KST');
  });

  it('429 — 숫자가 없으면 지어내지 않는다', async () => {
    const r = await make({ outcome: 'cooldown' }).cmd.execute(OPERATOR);
    expect(r.content).toContain('잠시 뒤에');
    expect(r.content).not.toMatch(/\d+초/);
    expect(r.content).not.toContain('기준 시각');
  });

  it('502 — 상류가 목록을 못 받았고 기존 목록은 유지된다', async () => {
    const r = await make({ outcome: 'sync-failed', lastError: 'HTTP 503' }).cmd.execute(OPERATOR);
    expect(r.content).toContain('치지직에서 팔로워 목록을 받지 못했습니다');
    expect(r.content).toContain('기존 목록은 그대로');
    expect(r.content).toContain('HTTP 503');
  });

  it('401 — 토큰 불일치(LIVE_API_TOKEN)', async () => {
    const r = await make({ outcome: 'unauthorized' }).cmd.execute(OPERATOR);
    expect(r.content).toContain('토큰 불일치');
    expect(r.content).toContain('LIVE_API_TOKEN');
  });

  it('404/405 — 꺼짐 또는 옛 판, 구분 불가라고 말하고 업데이트를 안내한다', async () => {
    for (const status of [404, 405]) {
      const r = await make({ outcome: 'unsupported', status }).cmd.execute(OPERATOR);
      expect(r.content).toContain(`HTTP ${String(status)}`);
      expect(r.content).toContain('꺼져 있거나');
      expect(r.content).toContain('구분되지 않습니다');
      expect(r.content).toContain('업데이트');
    }
  });

  it('404 channel_not_found — 상류에 우리 채널이 없다', async () => {
    const r = await make({ outcome: 'channel-not-found' }).cmd.execute(OPERATOR);
    expect(r.content).toContain('등록돼 있지 않습니다');
  });

  it('★★ 미확인은 "실패" 가 아니다 — 상류 동기화는 계속 돌 수 있다', async () => {
    const m = make({ outcome: 'unconfirmed', detail: '제한 시간 초과' });
    const r = await m.cmd.execute(OPERATOR);
    expect(r.content).toContain('확인하지 못했습니다');
    expect(r.content).toContain('제한 시간 초과');
    expect(r.content).toContain('실패했다는 뜻이 아닙니다');
    expect(r.content).toContain('계속 진행 중일 수 있습니다');
    expect(m.logs[0]?.extra).toEqual({ by: 'op', outcome: 'unconfirmed', detail: '제한 시간 초과' });
  });
});

describe('닿지 못함', () => {
  it('★ 네트워크 오류는 "진행 중일 수 있다" 가 아니라 상류가 떠 있는지 보라고 한다', async () => {
    const m = make({ outcome: 'unreachable', detail: 'ECONNREFUSED' });
    const r = await m.cmd.execute(OPERATOR);
    expect(r.content).toContain('닿지 못했습니다');
    expect(r.content).toContain('ECONNREFUSED');
    expect(r.content).toContain('떠 있는지 확인');
    expect(r.content).not.toContain('진행 중일 수 있습니다');
    expect(m.logs[0]?.extra).toEqual({ by: 'op', outcome: 'unreachable', detail: 'ECONNREFUSED' });
  });
});

describe('★ 던지지 않는다', () => {
  it('포트가 던져도 사람 말로 답한다', async () => {
    const m = make(new Error('클라이언트가 죽었다'));
    const r = await m.cmd.execute(OPERATOR);
    expect(r.content).toContain('오류가 났습니다');
    expect(r.content).toContain('클라이언트가 죽었다');
    expect(m.logs[0]?.message).toBe('팔로워 목록 수동 갱신 실패');
  });
});
