import { describe, it, expect } from 'vitest';

import { createAuthGuard, type AuthGuard } from '../../src/discord/commands/guard.js';
import { ManualClock } from '../../src/runtime/clock.js';

/**
 * §5.6.2 진입 리밋 — 사용자당 쿨다운 30초 + 길드 전역 동시 8건.
 *
 * ★ 이 둘이 막는 것은 서로 다르다. 쿨다운은 **한 사람의 반복 클릭**, 동시 상한은
 *   **30명이 동시에 누르는 것**(Pre-mortem 3-b)이다. 하나만으로는 다른 쪽이 그대로 뚫린다.
 */

const START = Date.parse('2026-09-07T00:00:00.000Z');
const COOLDOWN_SEC = 30;
const MAX_FLOWS = 8;

function harness(): { guard: AuthGuard; clock: ManualClock; rejects: string[] } {
  const clock = new ManualClock(START);
  const rejects: string[] = [];
  const guard = createAuthGuard({
    clock,
    cooldownSec: COOLDOWN_SEC,
    maxConcurrentFlows: MAX_FLOWS,
    onReject: (r) => rejects.push(r),
  });
  return { guard, clock, rejects };
}

describe('사용자당 쿨다운', () => {
  it('★ 같은 사용자가 30초 안에 4번 눌러도 통과는 1회다', () => {
    const h = harness();
    const results = [0, 1, 2, 3].map(() =>
      h.guard.tryEnter({ guildId: 'g', userId: 'u', pendingInGuild: 0 }),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
    expect(h.guard.rejected.cooldown).toBe(3);
  });

  it('쿨다운이 지나면 다시 통과한다', () => {
    const h = harness();
    expect(h.guard.tryEnter({ guildId: 'g', userId: 'u', pendingInGuild: 0 }).ok).toBe(true);
    h.clock.advance(COOLDOWN_SEC * 1_000 - 1);
    expect(h.guard.tryEnter({ guildId: 'g', userId: 'u', pendingInGuild: 0 }).ok).toBe(false);
    h.clock.advance(1);
    expect(h.guard.tryEnter({ guildId: 'g', userId: 'u', pendingInGuild: 0 }).ok).toBe(true);
  });

  it('남은 시간을 초 단위로 알려준다 — 안내 문구가 그 값을 쓴다', () => {
    const h = harness();
    h.guard.tryEnter({ guildId: 'g', userId: 'u', pendingInGuild: 0 });
    h.clock.advance(10_000);
    const r = h.guard.tryEnter({ guildId: 'g', userId: 'u', pendingInGuild: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterSec).toBe(20);
    expect(h.guard.cooldownRemainingSec('g', 'u')).toBe(20);
  });

  it('쿨다운은 사용자별이다 — 한 사람이 다른 사람을 막지 않는다', () => {
    const h = harness();
    h.guard.tryEnter({ guildId: 'g', userId: 'u1', pendingInGuild: 0 });
    expect(h.guard.tryEnter({ guildId: 'g', userId: 'u2', pendingInGuild: 0 }).ok).toBe(true);
  });

  it('길드가 다르면 같은 사용자라도 별개다', () => {
    const h = harness();
    h.guard.tryEnter({ guildId: 'g1', userId: 'u', pendingInGuild: 0 });
    expect(h.guard.tryEnter({ guildId: 'g2', userId: 'u', pendingInGuild: 0 }).ok).toBe(true);
  });
});

describe('길드 전역 동시 상한', () => {
  it('진행 중이 상한에 닿으면 새 진입을 거절한다', () => {
    const h = harness();
    const r = h.guard.tryEnter({ guildId: 'g', userId: 'u', pendingInGuild: MAX_FLOWS });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('max-concurrent');
    expect(h.guard.rejected['max-concurrent']).toBe(1);
  });

  it('상한 미만이면 통과한다', () => {
    const h = harness();
    expect(
      h.guard.tryEnter({ guildId: 'g', userId: 'u', pendingInGuild: MAX_FLOWS - 1 }).ok,
    ).toBe(true);
  });

  it('★ 동시 상한에 걸린 사용자는 쿨다운을 소비하지 않는다 — 곧바로 다시 시도할 수 있다', () => {
    const h = harness();
    expect(h.guard.tryEnter({ guildId: 'g', userId: 'u', pendingInGuild: MAX_FLOWS }).ok).toBe(false);
    // 자리가 나면 바로 통과해야 한다
    expect(h.guard.tryEnter({ guildId: 'g', userId: 'u', pendingInGuild: 0 }).ok).toBe(true);
  });

  it('★ 쿨다운이 동시 상한보다 먼저다 — 한 사람이 전역 상한을 소진하지 못한다', () => {
    const h = harness();
    h.guard.tryEnter({ guildId: 'g', userId: 'u', pendingInGuild: 0 });
    const r = h.guard.tryEnter({ guildId: 'g', userId: 'u', pendingInGuild: MAX_FLOWS });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('cooldown');
  });
});

describe('지표 auth_flow_rejected{reason}', () => {
  it('사유별로 갈린다', () => {
    const h = harness();
    h.guard.tryEnter({ guildId: 'g', userId: 'u', pendingInGuild: 0 });
    h.guard.tryEnter({ guildId: 'g', userId: 'u', pendingInGuild: 0 }); // cooldown
    h.guard.tryEnter({ guildId: 'g', userId: 'v', pendingInGuild: MAX_FLOWS }); // max-concurrent
    h.guard.countPendingMax();

    expect(h.guard.rejected).toEqual({ cooldown: 1, 'max-concurrent': 1, 'pending-max': 1 });
    expect(h.rejects).toEqual(['cooldown', 'max-concurrent', 'pending-max']);
  });

  it('지표 콜백이 던져도 판정이 죽지 않는다 (Principle 2)', () => {
    const clock = new ManualClock(START);
    const guard = createAuthGuard({
      clock,
      cooldownSec: COOLDOWN_SEC,
      maxConcurrentFlows: MAX_FLOWS,
      onReject: () => {
        throw new Error('지표 실패');
      },
    });
    guard.tryEnter({ guildId: 'g', userId: 'u', pendingInGuild: 0 });
    expect(() => guard.tryEnter({ guildId: 'g', userId: 'u', pendingInGuild: 0 })).not.toThrow();
  });
});
