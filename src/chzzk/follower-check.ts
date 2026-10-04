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
 * **시간대가 명시된**(`Z` · `±HH:MM`) ISO-8601 만 epoch ms 로. 아니면 `undefined`.
 *
 * ★★ `Date.parse` 는 시간대 없는 문자열(`"2026-08-27 16:20:46"` — 하필 상류 DB
 *   `created_date` 원문 형식)도 받는데, 그때는 **서버 시간대**로 읽는다. 상류가 어느 날
 *   변환을 빠뜨리고 원문을 내보내면 UTC 서버에서 9시간이 밀려 KST 00~09시 팔로우가
 *   하루 적게 나오고, `followDays` 도 `formatKst` 도 정상 숫자를 내므로 **아무 데서도
 *   드러나지 않는다** — §3-a 가 제일 나쁘다고 정한 "틀리게 보내기" 다. 시간대가 적힌
 *   값만 받아, 상류가 틀리면 "시작일 미상" 으로 **보이게** 한다.
 *
 * ★ 판정기(`followedAt` 을 싣는 자리)와 `/팔로우`(일수를 세는 자리)가 같은 파서를 쓴다.
 */
export function parseZonedIso(text: string): number | undefined {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(text)) return undefined;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : undefined;
}

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
  /**
   * 팔로우 시작 시각 — 상류가 준 ISO-8601 원문. **`yes` 일 때만** 실린다.
   *
   * ★ 판정에는 쓰지 않는다. `/팔로우` 가 "며칠째" 를 세는 데만 쓴다.
   *   상류(chzzkbot)가 이 필드를 싣기 전 판이거나 치지직이 일자를 안 줬으면 없다 —
   *   그때 명령은 "팔로우 중, 시작일 미상" 으로 답한다. 없다고 `unknown` 으로
   *   접으면 게이트가 상류 배포 순서에 묶인다.
   */
  followedAt?: string;
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
  /**
   * 팔로우 시작 시각(ISO). **선택이다** — 옛 판 상류는 이 키가 없고, 팔로워가
   * 아니거나 일자를 모르면 `null` 이다. 어느 쪽도 판정을 바꾸지 않는다.
   */
  followedAt: z.string().nullable().optional(),
});

// ══════════════════════════════════════════════════════════════════
//  지표
// ══════════════════════════════════════════════════════════════════

export interface FollowerMetrics {
  /**
   * `follower_lookup_total` — 상류 단건 조회 횟수.
   *
   * ★ 인증 1건당 1회 + AD-2 재조회 + 운영자의 `/팔로우`(`inspect`) 다.
   *   뒤의 둘은 드물어 **인증 수와 거의 1:1** 이고, 그 비율이 크게 벗어나면
   *   R1(단건)이 깨진 것이다. 운영자 조회를 따로 세지 않는 이유: "상류를 몇 번
   *   두드렸나" 가 이 지표의 뜻이고, 운영자 조회도 그 한 번이다.
   */
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
   * 운영자 조회(`/팔로우`) — `check` 와 같은 한 번의 질문이지만 **재조회를
   * 예약하지 않는다.** 그래서 `recheckAt` 이 실리지 않는다. 인증이 아니므로
   * "이 스냅샷이 그 사람의 클릭을 못 봤다" 는 비교 자체가 성립하지 않는다.
   * **절대 던지지 않는다.**
   */
  inspect(viewerChannelId: string): Promise<FollowerLookup>;
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
    if (body.isFollower) {
      // ★ 시작 시각은 `yes` 에만 싣고, **시간대가 명시된** 값만 싣는다 (`parseZonedIso`).
      //   못 읽는 원문을 그대로 넘기면 명령이 "NaN일째" 를 적고, 시간대 없는 원문은
      //   조용히 하루 어긋난다. 없어도 판정은 `yes` 그대로다.
      const followedAt =
        typeof body.followedAt === 'string' && parseZonedIso(body.followedAt) !== undefined
          ? body.followedAt
          : undefined;
      return finish({ verdict: 'yes', ...snapshot, ...(followedAt === undefined ? {} : { followedAt }) });
    }

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

    inspect(viewerChannelId): Promise<FollowerLookup> {
      // ★ `allowRecheck: false` — 재조회가 만든 판정과 같은 모양이다. `clickAt` 은
      //   그 분기에서만 읽히므로 지금 시각을 넘겨도 아무것도 바뀌지 않는다.
      return lookup(viewerChannelId, opts.clock.now(), false, {});
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

// ══════════════════════════════════════════════════════════════════
//  전수 동기화 요청 (`/팔로우갱신`)
// ══════════════════════════════════════════════════════════════════

/**
 * 상류에 우리 채널의 팔로워 캐시를 **지금** 전수로 다시 받으라고 한다.
 *
 *   POST {chzzkbot.baseUrl}/api/followers/:channelId/sync
 *   x-chzzkbot-token: <LIVE_API_TOKEN>
 *
 * ★ 이 파일에 두는 이유: `test/integration/no-direct-follower-api.test.ts` 가
 *   `/api/followers/` 를 만드는 파일을 **이 파일 하나로** 못 박는다. 상류에 팔로워를
 *   묻는 경로가 둘로 갈리면 그 검사가 지키는 R1 의 경계가 흐려진다. 판정기와는
 *   **다른 팩토리**다 — 판정기는 3상태로 접고, 이쪽은 상류 응답을 그대로 가른다.
 *
 * ★ 페이징은 상류가 한다. 우리는 한 번 부르고 결과를 받을 뿐이다 (R1 그대로).
 *
 * ★★ 우리 쪽에 무효화할 것이 **없다.** 판정 결과를 저장하지 않는다 — 인증은 매번
 *   상류에 새로 묻는다(인증당 1회). 그래서 동기화가 끝나면 그다음 `인증` 클릭이 곧바로
 *   새 목록을 본다. 이미 예약된 AD-2 재조회는 앞당기지 않는다 — 예약 시각에 돌면 그때도
 *   새 목록을 보고, 그 전에 본인이 다시 누르면 그 클릭이 먼저 통과한다. 앞당기는 장치를
 *   만들면 "정확히 1회" 를 지키는 구조(`scheduleRecheck`)를 건드리게 된다.
 */
export type FollowerSyncResult =
  /**
   * 200 — 상류가 전수를 다시 받았다.
   *
   * ★ `joined` — 이미 돌던 전수에 **합류**했다(상류가 겹친 요청을 하나로 합친다).
   *   그 전수는 멤버가 팔로우하기 **전에** 시작됐을 수 있다. 합류는 상류 쿨다운을
   *   쓰지 않으므로 한 번 더 누르면 새 전수가 돈다. 옛 판 상류는 이 키가 없다.
   */
  | { outcome: 'synced'; count: number; cachedAt: string; durationMs: number; joined?: true }
  /** 429 — 상류 채널별 쿨다운(60초). 값은 상류가 준 것만 싣는다 */
  | { outcome: 'cooldown'; retryAfterSec?: number; cachedAt?: string }
  /** 502 — 상류가 치지직에서 목록을 받지 못했다. **기존 캐시는 그대로다** */
  | { outcome: 'sync-failed'; lastError?: string }
  /** 401 — 토큰 불일치 */
  | { outcome: 'unauthorized' }
  /**
   * 404 `not_found` · 405 — 상류가 기능을 꺼 뒀거나 **이 경로를 모르는 옛 판**이다.
   *
   * ★ 둘을 가를 수 없다. 옛 판 chzzkbot 은 `/api/followers/…` 로 오는 POST 를
   *   경로 판별 **전에** 405 HTML 로 돌려보낸다(상류 `web/server.ts` 의 POST 가드).
   */
  | { outcome: 'unsupported'; status: number }
  /** 404 `channel_not_found` — 상류에 우리 채널이 등록돼 있지 않다 */
  | { outcome: 'channel-not-found' }
  /**
   * 503 `shutting_down` — 상류가 재기동 중이라 기다리던 응답을 끊었다.
   *
   * ★ `unconfirmed` 와 가른다. 이 경우는 원인이 확정이고 할 일도 다르다 — 상류는
   *   기동할 때 전수 동기화를 한 번 돌므로 **다시 누를 필요가 대개 없다.**
   *   본문의 `error` 가 맞을 때만 이 갈래다 (502·429 와 같은 규칙).
   */
  | { outcome: 'shutting-down' }
  /**
   * 네트워크 오류(연결 거부·DNS) — 요청이 상류에 **닿지 않았다.**
   *
   * ★ `unconfirmed` 와 가른다. 닿지 않았으면 동기화도 시작되지 않았으므로
   *   *"계속 진행 중일 수 있다"* 는 거짓말이 된다. 할 일은 상류가 떠 있는지 보는 것이다.
   */
  | { outcome: 'unreachable'; detail: string }
  /**
   * 타임아웃·예산·형태 불량·남의 채널 응답·그 밖의 상태.
   *
   * ★ **실패가 아니라 미확인이다.** 타임아웃이어도 상류 동기화는 계속 돈다 —
   *   끊긴 것은 우리 대기뿐이다.
   */
  | { outcome: 'unconfirmed'; detail: string };

/** 200 본문. `version` 은 보지 않는다 — 판이 올라도 이 필드들이 있으면 읽는다 */
const SyncOkBody = z.object({
  channelId: z.string().min(1),
  ok: z.literal(true),
  count: z.number().int().nonnegative(),
  cachedAt: z.string().min(1),
  durationMs: z.number().nonnegative(),
  /**
   * 선택 — 옛 판에는 없다. ★ `.catch` 로 둔다: 선택 필드 하나가 이상하다고 **성공한
   *   동기화**를 미확인으로 접으면 안 된다. 못 읽으면 "합류 아님" 과 같다.
   */
  joined: z.boolean().optional().catch(undefined),
});

/**
 * 429 본문. `error:"cooldown"` 만 상류 쿨다운으로 읽는다. 나머지 필드는 선택이다.
 *
 * ★ `error` 를 요구하는 이유: 앞단 프록시·다른 미들웨어의 429 를 상류 쿨다운으로 읽으면
 *   *"방금 갱신됐다"* 라는, 일어나지 않은 일을 적게 된다.
 */
const SyncCooldownBody = z.object({
  error: z.literal('cooldown'),
  channelId: z.string().optional(),
  retryAfterSec: z.number().nonnegative().optional(),
  cachedAt: z.string().nullable().optional(),
});

/**
 * 502 본문. `error:"sync_failed"` 만 상류의 동기화 실패로 읽는다.
 *
 * ★★ chzzkbot 이 죽어 있으면 앞단 프록시가 **Bad Gateway(502)** 를 낸다. 그것을
 *   `sync-failed` 로 읽으면 *"기존 목록으로 인증은 계속 됩니다"* 라고 적는데, 실제로는
 *   상류가 없어 인증이 전부 `unknown` 이다 — 운영자를 정반대로 안심시킨다.
 */
const SyncFailedBody = z.object({
  error: z.literal('sync_failed'),
  channelId: z.string().optional(),
  lastError: z.string().nullable().optional(),
  /** 선택 — 받아만 둔다. 실패 문구는 합류 여부와 무관하다(기존 목록 유지는 같다) */
  joined: z.boolean().optional().catch(undefined),
});

const ErrorBody = z.object({ error: z.string() });

/** 실패 응답 본문을 JSON 으로 — 아니면(옛 판의 HTML 등) `undefined` */
function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export type FollowerSyncOptions = Pick<
  FollowerCheckerOptions,
  'budget' | 'baseUrl' | 'token' | 'channelId' | 'clock' | 'onLog'
>;

/**
 * 대기열까지 포함한 요청 1건의 작업 예산.
 *
 * ★ 회당 타임아웃(60초)은 **나간 뒤**의 상한이다. 전역 동시성 상한(8)에 막혀 줄을 서는
 *   시간은 거기 들지 않는다 — 90초를 넘기면 기존 `budget` 갈래(미확인)로 접는다.
 *   90초 = 회당 60초 + 줄 30초. 디스코드 지연 응답 창(15분)보다 한참 짧다.
 */
export const FOLLOWER_SYNC_BUDGET_MS = 90_000;

export interface FollowerSyncClient {
  /**
   * 한 번 요청하고 결과를 가른다. **절대 던지지 않는다.**
   * 이미 나가 있는 요청이 있으면 **그 결과를 같이 기다린다** (아래 single-flight).
   */
  requestSync(): Promise<FollowerSyncResult>;
}

export function createFollowerSyncClient(opts: FollowerSyncOptions): FollowerSyncClient {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const url = `${base}/api/followers/${encodeURIComponent(opts.channelId)}/sync`;

  const log = (message: string, extra?: Record<string, unknown>): void => {
    try {
      opts.onLog?.(message, extra);
    } catch {
      /* 진단 로그가 요청을 죽이면 안 된다 (Principle 2) */
    }
  };

  /** R5 와 같은 대조 — 토큰 하나가 등록된 모든 채널을 연다. 값이 있을 때만 본다 */
  const otherChannel = (channelId: string | undefined): boolean =>
    channelId !== undefined && channelId !== opts.channelId;

  async function once(): Promise<FollowerSyncResult> {
    const res = await opts.budget.request('follower-sync', url, {
      method: 'POST',
      headers: { [CHZZKBOT_TOKEN_HEADER]: opts.token, Accept: 'application/json' },
      // ★ 재시도하지 않는다. 429 는 상류 쿨다운(60초)이라 기다려 다시 치면 운영자가
      //   1분을 묶이고, 결과는 "방금 갱신됐다" 로 같다. 바로 돌려줘 사람이 판단한다.
      maxRetries: 0,
      deadlineAt: opts.clock.now() + FOLLOWER_SYNC_BUDGET_MS,
    });

    if (res.ok) {
      const parsed = SyncOkBody.safeParse(res.body);
      if (!parsed.success) return { outcome: 'unconfirmed', detail: '응답 형태 불량' };
      if (otherChannel(parsed.data.channelId)) {
        log('팔로워 동기화 응답의 channelId 가 우리 채널이 아닙니다 (R5)', {
          got: parsed.data.channelId,
          want: opts.channelId,
        });
        return { outcome: 'unconfirmed', detail: '응답이 이 채널의 것이 아님' };
      }
      const { count, cachedAt, durationMs, joined } = parsed.data;
      return { outcome: 'synced', count, cachedAt, durationMs, ...(joined === true ? { joined } : {}) };
    }

    switch (res.kind) {
      case 'timeout':
        return { outcome: 'unconfirmed', detail: '제한 시간 초과' };
      case 'budget':
        return { outcome: 'unconfirmed', detail: '작업 예산 초과' };
      case 'network':
        return { outcome: 'unreachable', detail: res.detail.slice(0, 100) };
      case 'bad-body':
        return { outcome: 'unconfirmed', detail: '응답 형태 불량' };
      case 'http':
        break;
    }

    const body = parseJsonText(res.bodyText);
    switch (res.status) {
      case 429: {
        const p = SyncCooldownBody.safeParse(body);
        if (!p.success) return { outcome: 'unconfirmed', detail: 'HTTP 429' };
        const b = p.data;
        if (otherChannel(b.channelId)) return { outcome: 'unconfirmed', detail: '응답이 이 채널의 것이 아님' };
        return {
          outcome: 'cooldown',
          ...(b.retryAfterSec === undefined ? {} : { retryAfterSec: Math.ceil(b.retryAfterSec) }),
          ...(typeof b.cachedAt === 'string' && b.cachedAt !== '' ? { cachedAt: b.cachedAt } : {}),
        };
      }
      case 502: {
        const p = SyncFailedBody.safeParse(body);
        if (!p.success) return { outcome: 'unconfirmed', detail: 'HTTP 502' };
        const b = p.data;
        if (otherChannel(b.channelId)) return { outcome: 'unconfirmed', detail: '응답이 이 채널의 것이 아님' };
        return {
          outcome: 'sync-failed',
          ...(typeof b.lastError === 'string' && b.lastError !== '' ? { lastError: b.lastError } : {}),
        };
      }
      case 401:
        return { outcome: 'unauthorized' };
      case 404: {
        // ★ `channel_not_found` 만 따로 가른다. 나머지 404 는 본문이 무엇이든(옛 판·꺼짐)
        //   "이 기능을 쓸 수 없다" 로 읽는다.
        const p = ErrorBody.safeParse(body);
        return p.success && p.data.error === 'channel_not_found'
          ? { outcome: 'channel-not-found' }
          : { outcome: 'unsupported', status: 404 };
      }
      case 405:
        return { outcome: 'unsupported', status: 405 };
      case 503: {
        const p = ErrorBody.safeParse(body);
        return p.success && p.data.error === 'shutting_down'
          ? { outcome: 'shutting-down' }
          : { outcome: 'unconfirmed', detail: 'HTTP 503' };
      }
      default:
        return { outcome: 'unconfirmed', detail: `HTTP ${String(res.status)}` };
    }
  }

  /**
   * ★★ single-flight — 나가 있는 요청은 **하나**다.
   *
   *   상류는 겹친 동기화를 하나로 합치지만 **각 요청에 끝날 때 답한다.** 운영자가
   *   "멈췄나" 하고 연타하면 그 수만큼 전역 동시성 슬롯(8)을 최대 60초씩 쥐고, 그동안
   *   멤버의 `follower-lookup`(3초)이 줄에서 굶어 인증이 `unknown` 이 된다.
   *   같은 프로세스 안의 겹친 호출은 여기서 한 요청의 결과를 나눠 받는다.
   */
  let inflight: Promise<FollowerSyncResult> | undefined;

  return {
    requestSync(): Promise<FollowerSyncResult> {
      if (inflight !== undefined) return inflight;
      const p = once().finally(() => {
        inflight = undefined;
      });
      inflight = p;
      return p;
    },
  };
}
