// 출처: chzzkbot src/web/session.ts — 1회 소모 · nonce 쿠키 대조 · 상수 시간 비교 ·
//       MAX_PENDING 폐기 규율을 그대로 옮겼다 (계획 §14). 우리 것으로 바꾼 것은 셋이다:
//       ① state 가 **발급 유저에 귀속**된다 (AC-3) ② 저장소가 DB 다 (§8)
//       ③ 상한 도달을 **조용히 폐기하지 않고 경보한다** (§5.6.2).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { AlertKind } from '../runtime/alerts/types.js';
import type { Clock } from '../runtime/clock.js';
import type {
  VerificationSessionRepo,
  VerificationSessionRow,
} from '../store/repos/verification-session-repo.js';

/**
 * 인증 세션 — **두 가지 위조를 두 겹으로 막는다** (AC-2 · AC-3).
 *
 * ① **로그인 CSRF.** 콜백이 `code` 를 그대로 받아 교환하면 공격자가 자기 인가 코드를
 *    피해자 브라우저에 밀어넣을 수 있다. `state` 를 서버가 발급하고 **1회용**으로 둔다.
 *
 * ② **그것만으로는 부족하다.** 공격자도 자기 디스코드 계정으로 인증 버튼을 눌러
 *    **유효한 state 를 얻을 수 있다.** 그래서 그물을 둘 건다:
 *
 *    **그물 A — 발급 유저 귀속.** state 에는 `discordUserId` 가 붙어 있고,
 *    역할·연동은 **그 사람에게** 간다. 콜백을 누가 열었는지는 판정에 쓰지 않는다.
 *
 *    **그물 B — nonce 쿠키.** `/oauth/start` 가 브라우저에 nonce 를 심고 콜백에서
 *    서버가 기억한 해시와 대조한다. 공격자의 state 에 딸린 쿠키는 **공격자
 *    브라우저**에 있으므로 피해자 브라우저에서는 통과하지 못한다.
 *
 * ★ **nonce 원문을 저장하지 않는다.** DB 에는 sha256 해시만 남고 원문은 쿠키에만 있다
 *   (§8 스키마 주석). 그래서 `인증` 이 돌려주는 URL 에도 nonce 가 없다 —
 *   nonce 는 `/oauth/start` 가 그 자리에서 만들어 심고 해시를 **회전**시킨다.
 *
 * ★ `issue()` 직후의 `nonce_hash` 는 **아무도 프리이미지를 모르는 값**이다.
 *   `/oauth/start` 를 건너뛰고 콜백으로 바로 온 요청은 어떤 쿠키를 들고 와도
 *   대조에 실패한다 — fail-closed 가 기본값이다.
 *
 * ★★ **상한 도달은 경보한다** (§5.6.2). rev.2 는 "가장 오래된 것부터 폐기" 만 했는데
 *   **조용히 폐기하면 공격을 관측할 수 없다.** 폐기는 그대로 하되(가용성) 경보를
 *   함께 낸다(관측성) — `auth_pending_max`.
 */

/**
 * ★ 상한 도달 시 낼 경보 종류 (§5.6.2).
 *
 * 여기서 이름을 못 박는 이유: 조립부가 `raise('...')` 에 문자열을 직접 적으면
 * `alert_state` 의 CHECK 목록과 어긋난 값이 들어갈 수 있고, 그 INSERT 실패는
 * **하필 경보를 보내려던 순간**에 일어나 아무도 모르게 경보가 사라진다
 * (`runtime/alerts/types.ts` 가 적어둔 그 사고다). `AlertKind` 로 타입을 박아
 * 오타가 컴파일에서 걸리게 한다.
 */
export const AUTH_PENDING_MAX_ALERT: AlertKind = 'auth_pending_max';

/** 소모 표식. `verification_sessions.result` 어휘를 여기서 확정한다 (§8 주석) */
export const VERIFICATION_RESULTS = [
  /** 콜백이 state 를 소모했고 아직 판정 전 */
  'consumed',
  /** 팔로워 확인 → 연동·역할 부여까지 성공 */
  'linked',
  /** AC-12(a) — 이미 연동돼 있어 안내만 했다 */
  'already-linked',
  /** 팔로워가 아니다 (판정표 4·5) */
  'not-follower',
  /** ★ 판정 불가 — **`not-follower` 로 접지 않는다** (판정표 0·0-b·1·2) */
  'unknown',
  /** AC-7 — 이 치지직 채널이 다른 디스코드 계정에 묶여 있다 */
  'duplicate-channel',
  /** 토큰 교환 실패 · 주인 확인 실패 */
  'exchange-failed',
  /** 역할 부여 실패 (닉네임 실패는 여기 오지 않는다 — AC-11) */
  'gate-failed',
  /** 길드 설정을 찾지 못했다 */
  'no-guild',
] as const;
export type VerificationResult = (typeof VERIFICATION_RESULTS)[number];

export type ConsumeFailure =
  /** 모르는 state */
  | 'unknown-state'
  /** ★ 이미 소모됐다. 재생 공격의 정확한 형태다 */
  | 'already-used'
  /** TTL 초과 */
  | 'expired'
  /** ★ 그물 B — 쿠키가 없거나 다르다 */
  | 'nonce-mismatch'
  /** ★ 그물 A — 이 흐름의 주인이 아니다 */
  | 'owner-mismatch';

export interface ConsumedSession {
  state: string;
  /** ★ 역할·연동은 **이 사람에게** 간다. 콜백을 연 브라우저의 주인이 아니다 */
  discordUserId: string;
  /** 인증 버튼을 누른 시각(epoch ms). 판정표 4 의 "클릭 시각" 이 이 값이다 */
  clickedAt: number;
}

export type ConsumeResult =
  | { ok: true; session: ConsumedSession }
  | { ok: false; reason: ConsumeFailure };

export interface PendingSession {
  state: string;
  discordUserId: string;
  createdAt: number;
  expiresAt: number;
}

export interface IssuedSession {
  state: string;
  expiresAt: number;
}

export type AttachNonceResult =
  | { ok: true; nonce: string }
  | { ok: false; reason: 'unknown-state' | 'already-used' | 'expired' };

export interface VerificationSessionStoreOptions {
  repo: VerificationSessionRepo;
  clock: Clock;
  /** `auth.sessionTtlMin` */
  sessionTtlMin: number;
  /** `auth.maxPending` */
  maxPending: number;
  /**
   * ★ 상한 도달. 호출부가 `auth_pending_max` 경보를 낸다.
   *
   * **던지면 안 된다.** 경보 한 번에 인증이 죽으면 안 된다 (Principle 2).
   */
  onPendingMax?: (info: { pending: number; maxPending: number; dropped: number }) => void;
}

export interface VerificationSessionStore {
  /** `인증` — state 발급. 발급 유저에 귀속된다 (AC-3 그물 A) */
  issue(discordUserId: string): IssuedSession;
  /** AC-12(b) — 진행 중인 흐름. 있으면 **같은 URL 을 재제시**한다 */
  findPending(discordUserId: string): PendingSession | undefined;
  /** `/oauth/start` — 브라우저에 심을 nonce 를 만들고 해시를 회전시킨다 */
  attachNonce(state: string): AttachNonceResult;
  /**
   * `/oauth/callback` — **1회 소모 + 두 그물 대조.**
   *
   * ★ 성공하든 실패하든 그 state 는 사라진다. 재사용 가능한 state 가
   *   재생 공격의 입구다.
   */
  consume(
    state: string | undefined,
    nonceCookie: string | undefined,
    opts?: { expectDiscordUserId?: string | undefined },
  ): ConsumeResult;
  /** 흐름의 최종 결과를 남긴다. `isFollower` 의 `undefined` 가 `unknown` 이다 */
  finish(state: string, result: VerificationResult, isFollower?: boolean): void;
  pendingCount(): number;
  prune(): void;
}

/** 256비트. state 는 URL 로 흐르고 nonce 는 쿠키로 흐른다 — 둘 다 추측 불가여야 한다 */
function token(): string {
  return randomBytes(32).toString('base64url');
}

export function hashNonce(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf8').digest('hex');
}

/**
 * 길이까지 포함해 상수 시간으로 비교한다.
 *
 * `a === b` 는 첫 다른 바이트에서 멈춰 비교 시간이 값에 따라 달라진다.
 * 대조 대상이 인증 자격이라 비싸지 않은 방어는 그냥 건다.
 * (길이는 어차피 헤더·쿠키에서 보이므로 길이 비교를 먼저 하는 것에 누출이 없다.)
 */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export function createVerificationSessionStore(
  opts: VerificationSessionStoreOptions,
): VerificationSessionStore {
  const { repo, clock } = opts;
  const ttlMs = opts.sessionTtlMin * 60_000;
  const iso = (ms: number): string => new Date(ms).toISOString();

  const toPending = (r: VerificationSessionRow): PendingSession => ({
    state: r.state,
    discordUserId: r.discordUserId,
    createdAt: Date.parse(r.createdAt),
    expiresAt: Date.parse(r.expiresAt),
  });

  return {
    issue(discordUserId): IssuedSession {
      const at = clock.now();
      const nowIso = iso(at);
      repo.pruneExpired(nowIso);

      const pending = repo.pendingCount(nowIso);
      if (pending >= opts.maxPending) {
        // ★ 폐기하되 **알린다.** 자리를 비우지 않으면 상한에 닿는 순간
        //   정상 사용자까지 영구히 막히고(가용성), 알리지 않으면 공격이
        //   지표에도 로그에도 남지 않는다(관측성). 둘 다 한다.
        const dropped = repo.dropOldestPending(nowIso, pending - opts.maxPending + 1);
        try {
          opts.onPendingMax?.({ pending, maxPending: opts.maxPending, dropped });
        } catch {
          /* 경보가 인증을 죽이면 안 된다 (Principle 2) */
        }
      }

      const state = token();
      repo.insert({
        state,
        discordUserId,
        // ★ 프리이미지를 아무도 모르는 값. `/oauth/start` 전에는 어떤 쿠키도 통과 못 한다.
        nonceHash: hashNonce(token()),
        createdAt: nowIso,
        expiresAt: iso(at + ttlMs),
        result: undefined,
        isFollower: undefined,
      });
      return { state, expiresAt: at + ttlMs };
    },

    findPending(discordUserId): PendingSession | undefined {
      const nowIso = iso(clock.now());
      const r = repo.findPending(discordUserId, nowIso);
      return r === undefined ? undefined : toPending(r);
    },

    attachNonce(state): AttachNonceResult {
      const row = repo.get(state);
      if (row === undefined) return { ok: false, reason: 'unknown-state' };
      if (row.result !== undefined) return { ok: false, reason: 'already-used' };
      if (clock.now() >= Date.parse(row.expiresAt)) return { ok: false, reason: 'expired' };

      const nonce = token();
      // 회전에 실패했다면 그 사이에 소모됐다는 뜻이다.
      if (!repo.updateNonceHash(state, hashNonce(nonce))) {
        return { ok: false, reason: 'already-used' };
      }
      return { ok: true, nonce };
    },

    consume(state, nonceCookie, o): ConsumeResult {
      const at = clock.now();
      if (state === undefined || state === '') return { ok: false, reason: 'unknown-state' };

      // ★ 조회를 청소보다 먼저 한다. 반대로 하면 만료된 state 가 쓸려 나간 뒤라
      //   언제나 `unknown-state` 로 보이고 `expired` 분기가 죽은 코드가 된다.
      //   둘은 사용자에게 다른 이야기다 — 다음 행동이 다르다.
      const row = repo.get(state);
      if (row === undefined) {
        repo.pruneExpired(iso(at));
        return { ok: false, reason: 'unknown-state' };
      }

      // ★★ **원자적 1회 소모.** 이 UPDATE 가 통과한 요청 하나만 계속 간다.
      //   조회 후 갱신으로 나누면 같은 state 로 두 콜백이 통과한다.
      if (!repo.consume(state, 'consumed')) return { ok: false, reason: 'already-used' };

      if (at >= Date.parse(row.expiresAt)) return { ok: false, reason: 'expired' };

      // ── 그물 B — nonce 쿠키 ────────────────────────────────────
      if (nonceCookie === undefined || nonceCookie === '') {
        return { ok: false, reason: 'nonce-mismatch' };
      }
      if (!safeEqual(hashNonce(nonceCookie), row.nonceHash)) {
        return { ok: false, reason: 'nonce-mismatch' };
      }

      // ── 그물 A — 발급 유저 귀속 ────────────────────────────────
      // ★ 콜백에는 디스코드 신원이 실리지 않으므로 평소에는 이 대조가 돌지 않는다.
      //   그래서 **귀속의 본질은 대조가 아니라 "결과가 누구에게 가는가"** 다:
      //   아래 `session.discordUserId` 가 역할·연동의 대상이고, 콜백을 연
      //   브라우저의 주인은 판정에 전혀 쓰이지 않는다.
      const expected = o?.expectDiscordUserId;
      if (expected !== undefined && !safeEqual(expected, row.discordUserId)) {
        return { ok: false, reason: 'owner-mismatch' };
      }

      return {
        ok: true,
        session: {
          state: row.state,
          discordUserId: row.discordUserId,
          clickedAt: Date.parse(row.createdAt),
        },
      };
    },

    finish(state, result, isFollower): void {
      repo.finish(state, result, isFollower);
    },

    pendingCount(): number {
      return repo.pendingCount(iso(clock.now()));
    },

    prune(): void {
      repo.pruneExpired(iso(clock.now()));
    },
  };
}
