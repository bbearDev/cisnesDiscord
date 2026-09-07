import { describe, it, expect } from 'vitest';

import { ManualClock } from '../../src/runtime/clock.js';
import { createMemoryVerificationSessionRepo } from '../../src/store/repos/verification-session-repo.js';
import {
  createVerificationSessionStore,
  hashNonce,
  safeEqual,
  type VerificationSessionStore,
} from '../../src/web/session.js';

/**
 * ★★ AC-3 — **두 그물**.
 *
 *   그물 A: `state` 는 발급 유저(`discordUserId`)에 귀속된다
 *   그물 B: nonce 쿠키를 서버가 기억한 해시와 대조한다
 *
 * 그리고 AC-2 의 나머지: **1회 소모** · TTL · `MAX_PENDING` 도달 시 **경보**.
 */

const START = Date.parse('2026-09-07T00:00:00.000Z');
const TTL_MIN = 10;

interface Harness {
  store: VerificationSessionStore;
  clock: ManualClock;
  pendingMax: { pending: number; maxPending: number; dropped: number }[];
}

function harness(maxPending = 512): Harness {
  const clock = new ManualClock(START);
  const pendingMax: { pending: number; maxPending: number; dropped: number }[] = [];
  const store = createVerificationSessionStore({
    repo: createMemoryVerificationSessionRepo(),
    clock,
    sessionTtlMin: TTL_MIN,
    maxPending,
    onPendingMax: (info) => pendingMax.push(info),
  });
  return { store, clock, pendingMax };
}

/** `/oauth/start` 를 거친 정상 흐름 — 브라우저가 들고 오는 쿠키 값을 준다 */
function startFlow(store: VerificationSessionStore, userId: string): { state: string; nonce: string } {
  const issued = store.issue(userId);
  const attached = store.attachNonce(issued.state);
  if (!attached.ok) throw new Error(`attachNonce 실패: ${attached.reason}`);
  return { state: issued.state, nonce: attached.nonce };
}

describe('발급 · 소모', () => {
  it('정상 흐름은 통과하고 발급 유저를 그대로 돌려준다', () => {
    const h = harness();
    const { state, nonce } = startFlow(h.store, 'user-A');
    const r = h.store.consume(state, nonce);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.session.discordUserId).toBe('user-A');
      expect(r.session.clickedAt).toBe(START);
    }
  });

  it('★ 1회 소모다. 같은 state 를 두 번 쓰면 두 번째는 거부된다', () => {
    const h = harness();
    const { state, nonce } = startFlow(h.store, 'user-A');
    expect(h.store.consume(state, nonce).ok).toBe(true);
    const second = h.store.consume(state, nonce);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('already-used');
  });

  it('★ 실패한 소모도 state 를 태운다 — 재생 공격의 입구를 남기지 않는다', () => {
    const h = harness();
    const { state, nonce } = startFlow(h.store, 'user-A');
    const bad = h.store.consume(state, 'not-the-nonce');
    expect(bad.ok).toBe(false);
    // 올바른 nonce 로 다시 와도 이미 소모됐다
    const retry = h.store.consume(state, nonce);
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.reason).toBe('already-used');
  });

  it('모르는 state 는 unknown-state 다', () => {
    const h = harness();
    const r = h.store.consume('nope', 'x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown-state');
  });

  it('TTL 을 넘기면 expired — unknown-state 와 구분된다', () => {
    const h = harness();
    const { state, nonce } = startFlow(h.store, 'user-A');
    h.clock.advance(TTL_MIN * 60_000);
    const r = h.store.consume(state, nonce);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('expired');
  });
});

describe('★★ AC-3 — A 의 state 를 B 가 쓰면 거부된다', () => {
  it('그물 B — B 브라우저의 쿠키는 A 의 nonce 와 다르다', () => {
    const h = harness();
    const a = startFlow(h.store, 'user-A');
    const b = startFlow(h.store, 'user-B');

    // B 가 A 의 state 를 들고 콜백에 온다. 쿠키는 B 자신의 것뿐이다.
    const r = h.store.consume(a.state, b.nonce);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('nonce-mismatch');
  });

  it('쿠키가 아예 없으면 통과하지 못한다', () => {
    const h = harness();
    const a = startFlow(h.store, 'user-A');
    const r = h.store.consume(a.state, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('nonce-mismatch');
  });

  it('★ 그물 A — state 는 발급 유저에 귀속된다. 결과는 언제나 A 에게 간다', () => {
    const h = harness();
    const a = startFlow(h.store, 'user-A');
    // 쿠키를 훔쳤다고 가정해도(그물 B 통과) 소유자 대조가 남는다.
    const mismatched = h.store.consume(a.state, a.nonce, { expectDiscordUserId: 'user-B' });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.reason).toBe('owner-mismatch');
  });

  it('★ nonce 를 심기 전(= /oauth/start 를 건너뛴) 콜백은 어떤 쿠키로도 통과하지 못한다', () => {
    const h = harness();
    const issued = h.store.issue('user-A');
    // attachNonce 를 부르지 않았다 — 저장된 해시의 프리이미지를 아무도 모른다.
    for (const guess of ['', 'x', 'nonce', hashNonce('nonce')]) {
      const store = createVerificationSessionStore({
        repo: createMemoryVerificationSessionRepo(),
        clock: h.clock,
        sessionTtlMin: TTL_MIN,
        maxPending: 512,
      });
      const s = store.issue('user-A');
      const r = store.consume(s.state, guess);
      expect(r.ok).toBe(false);
    }
    expect(issued.state).not.toBe('');
  });
});

describe('AC-12(b) — 진행 중인 흐름', () => {
  it('같은 사용자의 미소모 state 를 찾아준다', () => {
    const h = harness();
    const issued = h.store.issue('user-A');
    const found = h.store.findPending('user-A');
    expect(found?.state).toBe(issued.state);
  });

  it('소모되면 더 이상 진행 중이 아니다', () => {
    const h = harness();
    const a = startFlow(h.store, 'user-A');
    h.store.consume(a.state, a.nonce);
    expect(h.store.findPending('user-A')).toBeUndefined();
  });

  it('만료되면 더 이상 진행 중이 아니다', () => {
    const h = harness();
    h.store.issue('user-A');
    h.clock.advance(TTL_MIN * 60_000 + 1);
    expect(h.store.findPending('user-A')).toBeUndefined();
  });

  it('다른 사용자의 흐름은 보이지 않는다', () => {
    const h = harness();
    h.store.issue('user-A');
    expect(h.store.findPending('user-B')).toBeUndefined();
  });
});

describe('★ §5.6.2 — MAX_PENDING 도달은 조용히 폐기하지 않는다', () => {
  it('상한에 닿으면 경보를 내고, 가장 오래된 것부터 버려 자리를 만든다', () => {
    const h = harness(3);
    h.store.issue('u1');
    h.clock.advance(1_000);
    const second = h.store.issue('u2');
    h.clock.advance(1_000);
    h.store.issue('u3');
    expect(h.pendingMax).toHaveLength(0);

    h.clock.advance(1_000);
    h.store.issue('u4');

    // ★ 관측 가능해야 한다 — 조용히 버리면 공격을 볼 수 없다
    expect(h.pendingMax).toHaveLength(1);
    expect(h.pendingMax[0]).toMatchObject({ pending: 3, maxPending: 3, dropped: 1 });

    // ★ 그리고 가용성도 지킨다 — 새 사용자는 막히지 않는다
    expect(h.store.pendingCount()).toBe(3);
    expect(h.store.findPending('u1')).toBeUndefined(); // 가장 오래된 것이 나갔다
    expect(h.store.findPending('u4')).toBeDefined();
    expect(h.store.findPending('u2')?.state).toBe(second.state);
  });

  it('경보 콜백이 던져도 인증이 죽지 않는다 (Principle 2)', () => {
    const clock = new ManualClock(START);
    const store = createVerificationSessionStore({
      repo: createMemoryVerificationSessionRepo(),
      clock,
      sessionTtlMin: TTL_MIN,
      maxPending: 1,
      onPendingMax: () => {
        throw new Error('경보 실패');
      },
    });
    store.issue('u1');
    expect(() => store.issue('u2')).not.toThrow();
  });

  it('만료된 대기는 상한에 세지 않는다', () => {
    const h = harness(2);
    h.store.issue('u1');
    h.store.issue('u2');
    h.clock.advance(TTL_MIN * 60_000 + 1);
    h.store.issue('u3');
    expect(h.pendingMax).toHaveLength(0);
    expect(h.store.pendingCount()).toBe(1);
  });
});

describe('보조', () => {
  it('safeEqual — 길이가 다르면 false, 같으면 값 비교', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });

  it('★ nonce 원문은 저장되지 않는다 — 해시만 남는다', () => {
    const repo = createMemoryVerificationSessionRepo();
    const clock = new ManualClock(START);
    const store = createVerificationSessionStore({
      repo,
      clock,
      sessionTtlMin: TTL_MIN,
      maxPending: 512,
    });
    const issued = store.issue('user-A');
    const attached = store.attachNonce(issued.state);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    const row = repo.get(issued.state);
    expect(row?.nonceHash).toBe(hashNonce(attached.nonce));
    expect(JSON.stringify(row)).not.toContain(attached.nonce);
  });

  it('소모된 state 에는 nonce 를 다시 심을 수 없다', () => {
    const h = harness();
    const a = startFlow(h.store, 'user-A');
    h.store.consume(a.state, a.nonce);
    const again = h.store.attachNonce(a.state);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe('already-used');
  });

  it('finish 는 3상태를 그대로 남긴다 — unknown 은 NULL 이다', () => {
    const repo = createMemoryVerificationSessionRepo();
    const clock = new ManualClock(START);
    const store = createVerificationSessionStore({
      repo,
      clock,
      sessionTtlMin: TTL_MIN,
      maxPending: 512,
    });
    const a = store.issue('user-A');
    store.finish(a.state, 'unknown');
    expect(repo.get(a.state)?.isFollower).toBeUndefined();

    const b = store.issue('user-B');
    store.finish(b.state, 'not-follower', false);
    expect(repo.get(b.state)?.isFollower).toBe(false);
  });
});
