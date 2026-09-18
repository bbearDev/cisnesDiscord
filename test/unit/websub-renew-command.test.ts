import { describe, it, expect } from 'vitest';

import {
  WEBSUB_RENEW_COMMAND,
  WEBSUB_RENEW_COOLDOWN_MS,
  createWebSubRenewCommand,
  type WebSubRenewPort,
} from '../../src/discord/commands/websub-renew.js';
import type { CommandContext } from '../../src/discord/commands/types.js';
import { ManualClock } from '../../src/runtime/clock.js';

/**
 * `/구독갱신` (운영자 전용).
 *
 * ★★ 이 파일이 지키는 문장:
 *   ① **운영자만** 실행한다 — 디스코드의 표시 제어는 관리자가 UI 로 덮을 수 있다
 *   ② **연타로 허브를 두드리지 않는다** — 쿨다운과 겹침 가드
 *   ③ 실패해도 **잠기지 않는다** — 예외가 나도 다음 호출이 된다
 */

const OPERATOR: CommandContext = { guildId: 'g1', userId: 'u1', isOperator: true };
const MEMBER: CommandContext = { guildId: 'g1', userId: 'u2', isOperator: false };

function port(over: Partial<WebSubRenewPort> = {}): WebSubRenewPort & { calls: number } {
  const p = {
    calls: 0,
    renewNow: (): Promise<{ checked: number; renewed: number; renewFailed: number }> => {
      p.calls += 1;
      return Promise.resolve({ checked: 2, renewed: 2, renewFailed: 0 });
    },
    leaseRatios: (): { channelId: string; ratio: number }[] => [
      { channelId: 'UC_A', ratio: 0.93 },
      { channelId: 'UC_B', ratio: 0.08 },
    ],
    ...over,
  };
  return p;
}

function make(over: Partial<WebSubRenewPort> = {}) {
  const clock = new ManualClock(Date.parse('2026-09-18T10:00:00.000Z'));
  const websub = port(over);
  const cmd = createWebSubRenewCommand({
    websub,
    clock,
    labelFor: (id) => (id === 'UC_A' ? '시스네' : undefined),
  });
  return { cmd, clock, websub };
}

describe('정의', () => {
  it('운영자에게만 보이고 DM 에서는 안 쓴다', () => {
    expect(WEBSUB_RENEW_COMMAND.dm_permission).toBe(false);
    expect(WEBSUB_RENEW_COMMAND.default_member_permissions).toBeDefined();
  });

  it('★ defer 다 — 갱신 1건 예산이 45초라 3초 창을 반드시 넘긴다', () => {
    expect(make().cmd.defer).toBe(true);
  });
});

describe('★★ 운영자만 실행한다', () => {
  it('일반 멤버는 거부되고 갱신이 돌지 않는다', async () => {
    const { cmd, websub } = make();
    const r = await cmd.execute(MEMBER);
    expect(r.content).toContain('운영자만');
    expect(websub.calls, '거부됐는데 허브를 두드렸다').toBe(0);
  });

  it('isOperator 가 없으면(미상) 거부한다 — 모르면 막는 쪽이다', async () => {
    const { cmd, websub } = make();
    await cmd.execute({ guildId: 'g1', userId: 'u3' });
    expect(websub.calls).toBe(0);
  });
});

describe('★★ 연타로 허브를 두드리지 않는다', () => {
  it('쿨다운 안에서는 갱신을 다시 돌리지 않는다', async () => {
    const { cmd, clock, websub } = make();
    await cmd.execute(OPERATOR);
    expect(websub.calls).toBe(1);

    clock.advance(WEBSUB_RENEW_COOLDOWN_MS - 1_000);
    const r = await cmd.execute(OPERATOR);
    expect(r.content).toContain('초 뒤에');
    expect(websub.calls, '쿨다운 중인데 또 돌았다').toBe(1);
  });

  it('쿨다운이 지나면 다시 돈다', async () => {
    const { cmd, clock, websub } = make();
    await cmd.execute(OPERATOR);
    clock.advance(WEBSUB_RENEW_COOLDOWN_MS + 1_000);
    await cmd.execute(OPERATOR);
    expect(websub.calls).toBe(2);
  });

  it('★ 도는 중에 또 부르면 "돌고 있다" 고 답한다 — 쿨다운 문구가 아니다', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { cmd } = make({
      renewNow: async () => {
        await gate;
        return { checked: 1, renewed: 1, renewFailed: 0 };
      },
    });

    const first = cmd.execute(OPERATOR);
    const second = await cmd.execute(OPERATOR);
    expect(second.content).toContain('이미 갱신을 시도하는 중');
    release?.();
    await first;
  });
});

describe('★★ 예외가 나도 던지지 않고, 잠기지도 않는다', () => {
  it('★★ renewNow 가 던져도 execute 는 던지지 않는다 — Command 계약이다', async () => {
    const { cmd } = make({ renewNow: () => Promise.reject(new Error('boom')) });
    const r = await cmd.execute(OPERATOR);
    expect(r.content).toContain('오류가 났습니다');
    expect(r.content, '자동 재시도가 돈다는 사실을 안 알렸다').toContain('자동 재시도');
    expect(r.content).toContain('boom');
  });

  it('예외 뒤에도 다음 호출이 된다 (겹침 플래그가 풀린다)', async () => {
    let shouldThrow = true;
    let calls = 0;
    const { cmd, clock } = make({
      renewNow: () => {
        calls += 1;
        if (shouldThrow) return Promise.reject(new Error('boom'));
        return Promise.resolve({ checked: 1, renewed: 1, renewFailed: 0 });
      },
    });

    await cmd.execute(OPERATOR);
    shouldThrow = false;
    clock.advance(WEBSUB_RENEW_COOLDOWN_MS + 1_000);
    await cmd.execute(OPERATOR);
    expect(calls, '예외 뒤 겹침 플래그가 켜진 채 남았다').toBe(2);
  });
});

describe('응답 문구', () => {
  it('성공하면 건수와 채널별 잔여를 싣는다 (라벨이 있으면 라벨로)', async () => {
    const { cmd } = make();
    const r = await cmd.execute(OPERATOR);
    expect(r.content).toContain('성공 2건');
    expect(r.content).toContain('시스네 — 잔여 93%');
    expect(r.content).toContain('UC_B — 잔여 8%');
    expect(r.ephemeral).toBe(true);
  });

  it('★★ 갱신할 게 없으면 "없다" 고 한다 — "성공 0건" 은 실패처럼 읽힌다', async () => {
    // 잔여 50% 초과이거나 재구독 쿨다운 안이면 스윕은 시도 자체를 안 하고 checked 만 올린다.
    // 아무 문제 없는 상태인데 "성공 0건" 이라 적으면 운영자가 실패로 읽고 다시 누른다.
    const { cmd } = make({
      renewNow: () => Promise.resolve({ checked: 2, renewed: 0, renewFailed: 0 }),
    });
    const r = await cmd.execute(OPERATOR);
    expect(r.content).toContain('갱신할 구독이 없습니다');
    expect(r.content, '멀쩡한 상태에 허브 장애 안내를 붙였다').not.toContain('허브');
  });

  it('★★ 실패하면 "눌러도 같다" 를 말한다 — 안 적으면 장애 중에 연타한다', async () => {
    const { cmd } = make({
      renewNow: () => Promise.resolve({ checked: 2, renewed: 0, renewFailed: 2 }),
    });
    const r = await cmd.execute(OPERATOR);
    expect(r.content).toContain('2건이 실패');
    expect(r.content).toContain('허브');
    expect(r.content, '자동 재시도가 돈다는 사실을 안 알렸다').toContain('자동 재시도');
  });
});
