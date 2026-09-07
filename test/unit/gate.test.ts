import { describe, it, expect } from 'vitest';

import { DiscordSendError } from '../../src/discord/client.js';
import { applyGate, clampNickname, MAX_NICKNAME_LENGTH, type GateGateway } from '../../src/discord/gate.js';

/**
 * ★★ AC-11 — **`setNickname` 실패는 인증 성공을 취소하지 않는다.**
 *
 * 상위 역할을 가진 멤버(스트리머 본인 등)에게는 봇이 닉네임을 못 바꾼다. 그것을
 * 인증 실패로 처리하면 **정확히 그 사람만 서버에 못 들어온다.**
 *
 * 그리고 AC-12(c) — 역할은 `cache.has` 로 먼저 본다.
 */

/**
 * 비-Error 예외를 주입하기 위한 캐스팅.
 *
 * ★ 프로덕션이 실제로 받는 것이 `Error` 라는 보장이 없다 — 라이브러리는 문자열도
 *   평범한 객체도 던진다. `toDiscordSendError` 가 그것을 접는지가 이 테스트의 대상이라
 *   **일부러** 그런 값을 넣는다.
 */
const asThrown = (value: unknown): Error => value as Error;

interface Recorder {
  gw: GateGateway;
  roleCalls: string[];
  nickCalls: (string | null)[];
}

function gateway(opts: {
  roleError?: Error;
  nickError?: Error;
  cached?: boolean | undefined;
}): Recorder {
  const roleCalls: string[] = [];
  const nickCalls: (string | null)[] = [];
  const gw: GateGateway = {
    addRole(guildId, userId, roleId): Promise<void> {
      roleCalls.push(`${guildId}:${userId}:${roleId}`);
      return opts.roleError === undefined ? Promise.resolve() : Promise.reject(opts.roleError);
    },
    setNickname(_g, _u, nickname): Promise<void> {
      if (opts.nickError !== undefined) return Promise.reject(opts.nickError);
      nickCalls.push(nickname);
      return Promise.resolve();
    },
    hasRole: () => opts.cached,
  };
  return { gw, roleCalls, nickCalls };
}

describe('★ AC-11 — 닉네임 실패는 인증을 취소하지 않는다', () => {
  it('403 으로 닉네임을 못 바꿔도 인증은 성공이고, 실패는 1건 기록된다', async () => {
    const r = gateway({ nickError: new DiscordSendError('forbidden', '권한 없음', 403), cached: undefined });
    const out = await applyGate(r.gw, {
      guildId: 'g',
      userId: 'u',
      roleId: 'role',
      nickname: '시스네',
    });

    expect(out.verified).toBe(true); // ★ 인증 성공
    expect(out.roleGranted).toBe(true);
    expect(out.nicknameApplied).toBe(false);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toMatchObject({ part: 'nickname', kind: 'forbidden' });
  });

  it('역할 부여가 실패하면 인증은 실패다 (닉네임과 달리)', async () => {
    const r = gateway({ roleError: new DiscordSendError('forbidden', '권한 없음', 403) });
    const out = await applyGate(r.gw, { guildId: 'g', userId: 'u', roleId: 'role' });
    expect(out.verified).toBe(false);
    expect(out.failures[0]?.part).toBe('role');
  });

  it('★ 두 동작은 독립이다 — 역할이 실패해도 닉네임을 시도한다', async () => {
    const r = gateway({ roleError: new Error('boom') });
    const out = await applyGate(r.gw, {
      guildId: 'g',
      userId: 'u',
      roleId: 'role',
      nickname: '시스네',
    });
    expect(out.nicknameApplied).toBe(true);
    expect(r.nickCalls).toEqual(['시스네']);
    expect(out.failures.map((f) => f.part)).toEqual(['role']);
  });

  it('분류되지 않는 예외도 삼켜 판정으로 바꾼다 — 호출부로 던지지 않는다', async () => {
    const r = gateway({ roleError: asThrown('string 예외'), nickError: asThrown({ weird: true }) });
    await expect(
      applyGate(r.gw, { guildId: 'g', userId: 'u', roleId: 'role', nickname: 'x' }),
    ).resolves.toMatchObject({ verified: false });
  });
});

describe('★ AC-12(c) — 역할은 캐시로 먼저 본다', () => {
  it('이미 갖고 있으면 REST 를 부르지 않는다', async () => {
    const r = gateway({ cached: true });
    const out = await applyGate(r.gw, { guildId: 'g', userId: 'u', roleId: 'role' });
    expect(out.roleGranted).toBe(true);
    expect(out.roleAlreadyHeld).toBe(true);
    expect(r.roleCalls).toHaveLength(0);
  });

  it('캐시가 "없다"고 하면 부른다', async () => {
    const r = gateway({ cached: false });
    const out = await applyGate(r.gw, { guildId: 'g', userId: 'u', roleId: 'role' });
    expect(out.roleAlreadyHeld).toBe(false);
    expect(r.roleCalls).toEqual(['g:u:role']);
  });

  it('★ 캐시가 모른다(undefined)면 부른다 — false 로 접지 않는다', async () => {
    const r = gateway({ cached: undefined });
    await applyGate(r.gw, { guildId: 'g', userId: 'u', roleId: 'role' });
    expect(r.roleCalls).toEqual(['g:u:role']);
  });

  it('캐시 조회를 제공하지 않는 게이트웨이도 동작한다', async () => {
    const roleCalls: string[] = [];
    const gw: GateGateway = {
      addRole: (g, u, r) => {
        roleCalls.push(`${g}:${u}:${r}`);
        return Promise.resolve();
      },
      setNickname: () => Promise.resolve(),
    };
    const out = await applyGate(gw, { guildId: 'g', userId: 'u', roleId: 'role' });
    expect(out.verified).toBe(true);
    expect(roleCalls).toHaveLength(1);
  });
});

describe('닉네임', () => {
  it('요청하지 않으면 건드리지 않는다 (가정 6 — 재동기화 잡 없음)', async () => {
    const r = gateway({});
    const out = await applyGate(r.gw, { guildId: 'g', userId: 'u', roleId: 'role' });
    expect(out.nicknameApplied).toBe(false);
    expect(r.nickCalls).toHaveLength(0);
  });

  it('null 을 주면 초기화한다', async () => {
    const r = gateway({});
    await applyGate(r.gw, { guildId: 'g', userId: 'u', roleId: 'role', nickname: null });
    expect(r.nickCalls).toEqual([null]);
  });

  it('32자를 넘으면 자른다 — 넘겨 보내면 400 이다', async () => {
    const long = 'ㄱ'.repeat(50);
    expect(clampNickname(long)).toHaveLength(MAX_NICKNAME_LENGTH);
    const r = gateway({});
    await applyGate(r.gw, { guildId: 'g', userId: 'u', roleId: 'role', nickname: long });
    expect(r.nickCalls[0]).toHaveLength(MAX_NICKNAME_LENGTH);
  });
});
