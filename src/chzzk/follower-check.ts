import { z } from 'zod';

import { UPSTREAM_FOLLOWER_CACHE_MIN } from '../config/schema.js';
import type { Clock, Disposable } from '../runtime/clock.js';
import type { HttpBudget, OutboundResult } from '../runtime/http-budget.js';

/**
 * ★★ 팔로워 판정 — **이 스토리의 심장** (계획 §5.2-b).
 *
 * chzzkbot 조회 API 를 **인증당 정확히 1회** 부르고, 응답을 §5.2-b 판정표대로
 * `yes` / `no` / `unknown` 3상태로 접는다.
 *
 *   GET {chzzkbot.baseUrl}/api/followers/:channelId/:viewerChannelId
 *   x-chzzkbot-token: <LIVE_API_TOKEN>
 *
 * ★★ **`unknown` 을 `no` 로 접지 않는다.**
 *   `unknown` 은 *"모른다 — 잠시 후 다시"* 이고 `no` 는 *"팔로우한 뒤 다시"* 다.
 *   사용자가 해야 할 일이 다르고, 접는 순간 §3-a 3위(**틀리게 보내기**)로 떨어진다.
 *   그래서 4xx·5xx·타임아웃·**예산 초과**가 전부 `unknown` 이다.
 *
 * ★★ **신선도 게이트(판정표 2)가 `isFollower` 판정보다 항상 먼저다.**
 *   상류의 `ever_synced` 는 `MAX(ever_synced, @ever)` 라 **한 번 켜지면 내려가지
 *   않는다**(`follower-repo.ts:86`). 상류의 `!팔로우` 안내에는 옳은 판단이지만,
 *   우리 게이트에서는 **낡은 캐시가 그 사이 팔로우한 신규 멤버를 잘못 거부**한다.
 *   게이트를 아래로 내리면 낡은 캐시가 `no` 를 확정하고 AD-2 가 그 거부를 한 번 더
 *   굳힌다 — 그래서 순서가 계약의 핵심이다.
 *
 * ★ **`?channel=` 도 목록도 없다.** 판정은 상류에서 끝나고 우리는 단건만 묻는다(R1).
 *   전량 페이징을 되살리는 순간 rev.6 이 지운 조회 예산 계층 R 이 통째로 돌아온다.
 *   `test/integration/no-direct-follower-api.test.ts` 가 그 경로가 생기는 것을 막는다.
 */

/** 상류 계약 §4 — 조회 API·웹훅·팔로워 API 공통 */
export const CHZZKBOT_TOKEN_HEADER = 'x-chzzkbot-token';


/**
 * AD-2 재조회 여유(ε).
 *
 * 재조회 시점은 `cachedAt + followerCacheMin + ε` 다. ε 이 0 이면 상류가 캐시를
 * 갱신하는 바로 그 순간에 물어 **갱신 전 세대를 한 번 더 받는다** — 재조회 1회를
 * 통째로 낭비하고 거부를 굳힌다.
 */
export const RECHECK_EPSILON_MS = 30_000;

// ══════════════════════════════════════════════════════════════════
//  3상태 계약
// ══════════════════════════════════════════════════════════════════

export type FollowerVerdict = 'yes' | 'no' | 'unknown';

/**
 * `follower_lookup_unknown_total{reason}` 의 라벨 (§9.4).
 *
 * ★ **목록을 늘리지 않는다.** `stale` 은 §13 `scopes-이상` 이 *"스코프 상실·동기화
 *   중단을 관측하는 유일한 축"* 으로 지정한 값이라, 라벨이 갈리면 그 축을 잃는다.
 */
export const FOLLOWER_UNKNOWN_REASONS = [
  /** 판정표 1 — `everSynced:false`. **미팔로우가 아니라 "아직 모른다"** */
  'not-synced',
  /** 판정표 2 — 신선도 게이트 */
  'stale',
  /** 판정표 0 — 4xx (401·404·429 소진 포함) */
  'http-4xx',
  /** 판정표 0 — 5xx */
  'http-5xx',
  /** 판정표 0 — 회당 타임아웃 · 작업 예산 초과 · 네트워크 무응답 */
  'timeout',
  /** 판정표 0 — R5. 응답 `channelId` 가 우리 채널이 아니다 */
  'wrong-channel',
  /** 판정표 0-b — zod 실패 · 필수 필드 누락 · `cachedAt` 부재/null/파싱 불가 */
  'bad-shape',
] as const;
export type FollowerUnknownReason = (typeof FOLLOWER_UNKNOWN_REASONS)[number];

export interface FollowerLookup {
  verdict: FollowerVerdict;
  /** `verdict === 'unknown'` 일 때만 있다 */
  reason?: FollowerUnknownReason;
  /** 상류가 준 스냅샷 시각 원문. **R-4 안내에 그대로 싣는다** */
  cachedAt?: string;
  /** 지표 `follower_snapshot_age_sec` — 안내에 싣는 값과 **같은 값**이다 */
  snapshotAgeSec?: number;
  /**
   * 판정표 4 — AD-2 재조회 예정 시각(epoch ms).
   *
   * ★ `no` 이고 **`cachedAt` 이 클릭 시각보다 앞설 때만** 채워진다.
   *   그 구간에서만 *"이 스냅샷은 그 사람의 팔로우를 볼 수 없었다"* 가
   *   추측이 아니라 **시각 비교로 참**이 된다.
   */
  recheckAt?: number;
}

// ══════════════════════════════════════════════════════════════════
//  응답 스키마
// ══════════════════════════════════════════════════════════════════

/**
 * ★ `cachedAt` 을 `z.unknown()` 으로 둔 것이 의도다.
 *
 *   `z.string()` 으로 좁히면 `cachedAt:null` 이 **zod 단계에서** 걸려
 *   판정표 0(R5 채널 대조)보다 **먼저** 판정된다. 표는 R5 가 0 이고 형태 불량이
 *   0-b 다 — 순서를 뒤집으면 "남의 채널 응답인데 형태 불량으로 보고됐다" 가 되어
 *   R5 회귀가 `bad-shape` 뒤에 숨는다.
 */
const FollowerBody = z.object({
  channelId: z.string().min(1),
  viewerChannelId: z.string().min(1).optional(),
  isFollower: z.boolean(),
  everSynced: z.boolean(),
  cachedAt: z.unknown(),
  /** R3-b — 상류 사유. 진단에만 쓰고 판정에는 쓰지 않는다 */
  lastError: z.string().nullable().optional(),
});

// ══════════════════════════════════════════════════════════════════
//  지표
// ══════════════════════════════════════════════════════════════════

export interface FollowerMetrics {
  /** `follower_lookup_total` — **인증 수와 1:1 이어야 한다** */
  readonly lookups: number;
  /** `follower_lookup_recheck_total` — **인증당 최대 1** */
  readonly rechecks: number;
  /** `follower_lookup_unknown_total{reason}` */
  readonly unknownByReason: Readonly<Record<FollowerUnknownReason, number>>;
  /** `follower_snapshot_age_sec` — 마지막으로 관측한 스냅샷 나이 */
  readonly lastSnapshotAgeSec: number | undefined;
}

function emptyReasonCounts(): Record<FollowerUnknownReason, number> {
  const out = {} as Record<FollowerUnknownReason, number>;
  for (const r of FOLLOWER_UNKNOWN_REASONS) out[r] = 0;
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  판정기
// ══════════════════════════════════════════════════════════════════

export interface FollowerCheckerOptions {
  budget: HttpBudget;
  /** `chzzkbot.baseUrl` */
  baseUrl: string;
  /** `LIVE_API_TOKEN`. `x-chzzkbot-token` 으로 싣는다 */
  token: string;
  /** ★ R5 — 우리 채널. 응답의 `channelId` 를 이 값으로 다시 거른다 */
  channelId: string;
  /** `follower.staleAfterMin` (150분 잠정, §2-b) */
  staleAfterMin: number;
  clock: Clock;
  /** 상류 `followerCacheMin`. 테스트 주입점 */
  upstreamCacheMin?: number;
  /** 지표 `follower_lookup_unknown_total{reason}` 배선점 */
  onUnknown?: (reason: FollowerUnknownReason) => void;
  /**
   * 판정 1건이 끝날 때마다. **`stuck-watch` 의 `'follower-stale'` 도메인을 여기 꽂는다.**
   *
   * ★ 그 도메인은 `armed: false` 다 — **세기만 하고 경보하지 않는다.**
   *   `staleAfterMin` 150분은 소스 상수 추론이지 실측이 아니고(§2-b 잠정),
   *   검증 안 된 임계로 경보하면 `stale` 이 지정한 유일한 관측 축이 오탐에 덮인다.
   *   **게이트는 지금 켜고 경보는 S1-J 실측 뒤에 켠다.**
   */
  onLookup?: (lookup: FollowerLookup) => void;
  onLog?: (message: string, extra?: Record<string, unknown>) => void;
}

export interface CheckOptions {
  /** 인증 왕복 10초 예산의 마감 시각 (§5.6.1) */
  deadlineAt?: number | undefined;
}

export interface FollowerChecker {
  /**
   * 상류에 **한 번** 묻고 3상태로 접는다. **절대 던지지 않는다.**
   *
   * @param clickAt `/인증` 을 누른 시각. 판정표 4 의 시각 비교 기준이다
   */
  check(viewerChannelId: string, clickAt: number, opts?: CheckOptions): Promise<FollowerLookup>;
  /**
   * AD-2 — `no` 판정 1회 자동 재조회를 예약한다.
   *
   * ★ **정확히 1회다.** 재조회가 만드는 판정에는 `recheckAt` 이 실리지 않으므로
   *   두 번째 예약은 **구조적으로 불가능**하다. 같은 시청자에 대한 중복 예약도
   *   여기서 막는다.
   *
   * @returns 실제로 예약했으면 `true`
   */
  scheduleRecheck(
    viewerChannelId: string,
    lookup: FollowerLookup,
    onResult: (lookup: FollowerLookup) => void,
  ): boolean;
  /** 예약된 재조회를 전부 취소한다 (종료 경로) */
  dispose(): void;
  readonly metrics: FollowerMetrics;
}

/**
 * 전송 실패를 `unknown` 사유로 접는다.
 *
 * ★ `budget`(작업 예산 초과)과 `network`(무응답·연결 거부)를 `timeout` 으로 접는 것은
 *   **라벨 목록을 늘리지 않기 위한 의도적 선택**이다(§9.4 가 라벨 7종을 확정했다).
 *   셋 다 우리 입장에서는 *"제 시간에 답을 받지 못했다"* 로 같고, 그 셋을 가르는
 *   진단은 `outbound_timeout_total{call}` 과 로그가 이미 한다.
 */
function transportReason(res: Extract<OutboundResult<unknown>, { ok: false }>): FollowerUnknownReason {
  switch (res.kind) {
    case 'http':
      return res.status >= 500 ? 'http-5xx' : 'http-4xx';
    case 'bad-body':
      return 'bad-shape';
    case 'timeout':
    case 'budget':
    case 'network':
      return 'timeout';
  }
}

export function createFollowerChecker(opts: FollowerCheckerOptions): FollowerChecker {
  const staleMs = opts.staleAfterMin * 60_000;
  const cacheMs = (opts.upstreamCacheMin ?? UPSTREAM_FOLLOWER_CACHE_MIN) * 60_000;
  const base = opts.baseUrl.replace(/\/+$/, '');

  const unknownByReason = emptyReasonCounts();
  const scheduled = new Map<string, Disposable>();
  let lookups = 0;
  let rechecks = 0;
  let lastSnapshotAgeSec: number | undefined;

  const log = (message: string, extra?: Record<string, unknown>): void => {
    try {
      opts.onLog?.(message, extra);
    } catch {
      /* 진단 로그가 판정을 죽이면 안 된다 (Principle 2) */
    }
  };

  function finish(lookup: FollowerLookup): FollowerLookup {
    if (lookup.reason !== undefined) {
      unknownByReason[lookup.reason] += 1;
      opts.onUnknown?.(lookup.reason);
    }
    if (lookup.snapshotAgeSec !== undefined) lastSnapshotAgeSec = lookup.snapshotAgeSec;
    try {
      opts.onLookup?.(lookup);
    } catch {
      /* 지표가 판정을 죽이면 안 된다 */
    }
    return lookup;
  }

  async function lookup(
    viewerChannelId: string,
    clickAt: number,
    allowRecheck: boolean,
    o: CheckOptions,
  ): Promise<FollowerLookup> {
    const url =
      `${base}/api/followers/${encodeURIComponent(opts.channelId)}` +
      `/${encodeURIComponent(viewerChannelId)}`;

    lookups += 1;
    const res = await opts.budget.request('follower-lookup', url, {
      method: 'GET',
      headers: { [CHZZKBOT_TOKEN_HEADER]: opts.token, Accept: 'application/json' },
      ...(o.deadlineAt === undefined ? {} : { deadlineAt: o.deadlineAt }),
    });

    // ── 판정표 0 — 전송 실패 ────────────────────────────────────
    if (!res.ok) {
      const reason = transportReason(res);
      log('팔로워 조회 실패 — unknown 으로 접습니다', { reason, kind: res.kind });
      return finish({ verdict: 'unknown', reason });
    }

    const parsed = FollowerBody.safeParse(res.body);
    if (!parsed.success) return finish({ verdict: 'unknown', reason: 'bad-shape' });
    const body = parsed.data;

    // ── 판정표 0 — R5. 토큰 하나가 등록된 **모든 채널**을 연다 ──
    if (body.channelId !== opts.channelId) {
      log('팔로워 조회 응답의 channelId 가 우리 채널이 아닙니다 (R5)', {
        got: body.channelId,
        want: opts.channelId,
      });
      return finish({ verdict: 'unknown', reason: 'wrong-channel' });
    }

    // ── 판정표 0-b — `cachedAt` 부재·null·파싱 불가 ─────────────
    // ★ 이 검사가 없으면 `cachedAt:null` 일 때 나이 비교가 NaN 이 되어
    //   **신선도 게이트를 조용히 통과**한다. rev.8 이 신설한 구멍이다.
    const cachedAtRaw = body.cachedAt;
    if (typeof cachedAtRaw !== 'string' || cachedAtRaw === '') {
      return finish({ verdict: 'unknown', reason: 'bad-shape' });
    }
    const cachedMs = Date.parse(cachedAtRaw);
    if (!Number.isFinite(cachedMs)) return finish({ verdict: 'unknown', reason: 'bad-shape' });

    const at = opts.clock.now();
    // ★ 음수 나이(미래 시각)는 0 으로 접는다. 시계가 어긋났을 때
    //   "-3분 전이라 신선하다" 가 되는 것을 막는다.
    const ageMs = Math.max(0, at - cachedMs);
    const snapshotAgeSec = Math.round(ageMs / 1000);
    const snapshot = { cachedAt: cachedAtRaw, snapshotAgeSec } as const;

    // ── 판정표 1 — `everSynced:false` 는 거부가 아니라 **보류** ──
    if (!body.everSynced) {
      return finish({ verdict: 'unknown', reason: 'not-synced', ...snapshot });
    }

    // ── 판정표 2 — ★★ 신선도 게이트. `isFollower` 를 **보지 않는다** ──
    // ★ 경계는 `>=` 다. 계획 §9.2 가 "149:59 통과 / 150:00 unknown" 으로
    //   못 박았으므로 임계 그 자체가 이미 stale 이다.
    if (ageMs >= staleMs) {
      return finish({ verdict: 'unknown', reason: 'stale', ...snapshot });
    }

    // ── 판정표 3 ───────────────────────────────────────────────
    if (body.isFollower) return finish({ verdict: 'yes', ...snapshot });

    // ── 판정표 4 — AD-2 예약 대상 ──────────────────────────────
    // ★ 게이트를 통과한(= 충분히 신선한) `no` 만 여기 온다. 그 구간에서만
    //   "이 스냅샷은 그 사람의 팔로우를 볼 수 없었다" 가 시각 비교로 참이다.
    // ★ `allowRecheck === false` 는 **재조회가 만든 판정**이다 — 여기서
    //   `recheckAt` 을 채우지 않는 것이 "정확히 1회" 의 구조적 근거다.
    if (allowRecheck && cachedMs < clickAt) {
      return finish({ verdict: 'no', ...snapshot, recheckAt: cachedMs + cacheMs + RECHECK_EPSILON_MS });
    }

    // ── 판정표 5 ───────────────────────────────────────────────
    return finish({ verdict: 'no', ...snapshot });
  }

  return {
    get metrics(): FollowerMetrics {
      return {
        lookups,
        rechecks,
        unknownByReason: { ...unknownByReason },
        lastSnapshotAgeSec,
      };
    },

    check(viewerChannelId, clickAt, o = {}): Promise<FollowerLookup> {
      return lookup(viewerChannelId, clickAt, true, o);
    },

    scheduleRecheck(viewerChannelId, result, onResult): boolean {
      const at = result.recheckAt;
      if (at === undefined) return false;
      // 같은 시청자에 대한 중복 예약을 막는다. 상한이 깨지면
      // `follower_lookup_recheck_total` 이 인증 수를 넘어 즉시 드러난다.
      if (scheduled.has(viewerChannelId)) return false;

      const delay = Math.max(0, at - opts.clock.now());
      const timer = opts.clock.setTimeout(() => {
        scheduled.delete(viewerChannelId);
        rechecks += 1;
        // ★ `allowRecheck: false` — 재조회의 결과는 다시 예약하지 않는다.
        void lookup(viewerChannelId, at, false, {})
          .then((r) => {
            onResult(r);
          })
          .catch((e: unknown) => {
            log('AD-2 재조회 중 예외', { detail: e instanceof Error ? e.message : String(e) });
          });
      }, delay);
      scheduled.set(viewerChannelId, timer);
      return true;
    },

    dispose(): void {
      for (const t of scheduled.values()) t.dispose();
      scheduled.clear();
    },
  };
}
