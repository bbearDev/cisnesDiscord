import type { Clock } from '../../runtime/clock.js';

/**
 * `인증` 진입 리밋 — §5.6.2 (FM4) · Pre-mortem 3-b.
 *
 * ★ 막는 표면이 무엇인지 분명히 해 둔다. `/oauth/callback` 은 **state-먼저 검증**이라
 *   외부인은 토큰 교환까지 도달하지 못한다. 남는 표면은 **길드 멤버가 인증 버튼 반복으로
 *   FM1(이벤트 루프 포화)을 스스로 유발하는 것**이고, 그것이 초대 링크가 유출돼
 *   30명이 동시에 누르는 Pre-mortem 3-b 와 **정확히 같은 표면**이다.
 *
 * | 방어 | 값 | 막는 것 |
 * |---|---|---|
 * | 사용자당 쿨다운 | `auth.commandCooldownSec` 30초 | 한 사람의 반복 클릭. **rev.6 이후 우리 쪽 유일한 사용자별 상한** |
 * | 길드 전역 동시 진행 | `auth.maxConcurrentFlows` 8 | 30명 동시 클릭이 그대로 상류 팬아웃이 되는 것 |
 *
 * ★★ **동시 진행 수를 따로 세지 않는다.** "진행 중" 은 곧 *"만료되지 않은 미소모
 *   state 가 있다"* 이므로 `verification_sessions` 의 대기 수가 그대로 그 값이다.
 *   별도 카운터를 두면 콜백이 안 돌아온 흐름(사용자가 브라우저를 닫았다)이
 *   **영원히 자리를 점유**하고, 그 누수는 아무도 못 본다. 세션 TTL 이 그 자리를
 *   자동으로 돌려주게 하는 편이 옳다.
 *
 * ⚠️ `auth.maxConcurrentFlows`(8) 와 `http.maxConcurrent`(8) 는 **다른 것이다.**
 *   여기는 `인증` **진입**의 동시 수, 저기는 **나가는 HTTP** 의 동시 수다 (§5.6.1).
 */

export const AUTH_REJECT_REASONS = ['cooldown', 'max-concurrent', 'pending-max'] as const;
/** 지표 `auth_flow_rejected{reason}` 의 라벨 (§9.4) */
export type AuthRejectReason = (typeof AUTH_REJECT_REASONS)[number];

export type AuthGuardResult =
  | { ok: true }
  | { ok: false; reason: AuthRejectReason; retryAfterSec: number };

export interface AuthGuardOptions {
  clock: Clock;
  /** `auth.commandCooldownSec` */
  cooldownSec: number;
  /** `auth.maxConcurrentFlows` */
  maxConcurrentFlows: number;
  /** 지표 배선점. 던지면 안 된다 */
  onReject?: (reason: AuthRejectReason) => void;
}

export interface TryEnterInput {
  guildId: string;
  userId: string;
  /** 이 길드에서 진행 중인 흐름 수 = 만료되지 않은 미소모 state 수 */
  pendingInGuild: number;
}

export interface AuthGuard {
  /** 통과하면 그 순간 쿨다운이 시작된다 */
  tryEnter(input: TryEnterInput): AuthGuardResult;
  /** `MAX_PENDING` 도달로 거절했다 — 세션 저장소가 경보를 내고 여기는 세기만 한다 */
  countPendingMax(): void;
  /** 남은 쿨다운(초). 0 이면 지금 가능 */
  cooldownRemainingSec(guildId: string, userId: string): number;
  /** 지표 `auth_flow_rejected{reason}` */
  readonly rejected: Readonly<Record<AuthRejectReason, number>>;
  /** 테스트·재기동용 */
  reset(): void;
}

/**
 * ★ 구분자는 NUL 이다. 길드 id·유저 id 어디에도 나올 수 없는 바이트라
 *   `('a','b:c')` 와 `('a:b','c')` 가 같은 키가 되는 사고를 막는다
 *   (`ops-alert-service.ts` · `stuck-watch.ts` 가 같은 이유로 같은 선택을 했다).
 */
const SEP = '\u0000';

function emptyCounts(): Record<AuthRejectReason, number> {
  const out = {} as Record<AuthRejectReason, number>;
  for (const r of AUTH_REJECT_REASONS) out[r] = 0;
  return out;
}

export function createAuthGuard(opts: AuthGuardOptions): AuthGuard {
  const cooldownMs = opts.cooldownSec * 1_000;
  const lastEntry = new Map<string, number>();
  const rejected = emptyCounts();

  const key = (guildId: string, userId: string): string => `${guildId}${SEP}${userId}`;

  /** 지난 쿨다운 기록을 치운다. 안 치우면 길드 인원수만큼 무한히 자란다 */
  function prune(at: number): void {
    if (lastEntry.size < 1_000) return;
    for (const [k, v] of lastEntry) {
      if (at - v >= cooldownMs) lastEntry.delete(k);
    }
  }

  function reject(reason: AuthRejectReason, retryAfterSec: number): AuthGuardResult {
    rejected[reason] += 1;
    try {
      opts.onReject?.(reason);
    } catch {
      /* 지표가 명령을 죽이면 안 된다 (Principle 2) */
    }
    return { ok: false, reason, retryAfterSec };
  }

  return {
    get rejected(): Readonly<Record<AuthRejectReason, number>> {
      return { ...rejected };
    },

    cooldownRemainingSec(guildId, userId): number {
      const last = lastEntry.get(key(guildId, userId));
      if (last === undefined) return 0;
      const remain = cooldownMs - (opts.clock.now() - last);
      return remain <= 0 ? 0 : Math.ceil(remain / 1_000);
    },

    tryEnter(input): AuthGuardResult {
      const at = opts.clock.now();
      prune(at);

      // ★ 쿨다운을 먼저 본다. 동시 상한보다 앞이어야 한 사람의 반복 클릭이
      //   길드 전역 상한을 먼저 소진하는 일이 없다 — 그러면 한 사람이
      //   나머지 전원을 막을 수 있다.
      const k = key(input.guildId, input.userId);
      const last = lastEntry.get(k);
      if (last !== undefined && at - last < cooldownMs) {
        return reject('cooldown', Math.ceil((cooldownMs - (at - last)) / 1_000));
      }

      if (input.pendingInGuild >= opts.maxConcurrentFlows) {
        // 자리는 세션 TTL 이 돌려준다. 그래서 재시도 안내가 "잠시 후" 로 성립한다.
        return reject('max-concurrent', opts.cooldownSec);
      }

      lastEntry.set(k, at);
      return { ok: true };
    },

    countPendingMax(): void {
      rejected['pending-max'] += 1;
      try {
        opts.onReject?.('pending-max');
      } catch {
        /* 지표가 명령을 죽이면 안 된다 */
      }
    },

    reset(): void {
      lastEntry.clear();
      for (const r of AUTH_REJECT_REASONS) rejected[r] = 0;
    },
  };
}
