/**
 * 다운타임 복구 — 계획 §S7 (AC-29 · AC-30 · AC-31).
 *
 * ★★ **라이브와 유튜브의 규칙이 다르다. 그 차이가 이 파일의 전부다.**
 *
 *   | 대상 | 다운타임 ≤ 6h | 다운타임 > 6h |
 *   |---|---|---|
 *   | **유튜브 밀린 업로드** (지나간 이벤트) | 전부 공지 (AC-29) | **전량 생략** + 현재 피드 `seeded` 선점 + 기록 (AC-30) |
 *   | **진행 중인 방송** (현재 사실)      | `announce` 면 1회 공지 | **`announce` 면 1회 공지 — 생략하지 않는다** |
 *   | **이미 끝난 방송** (지나간 이벤트)  | 공지 안 함 (AC-31)     | 공지 안 함 (AC-31) |
 *
 *   근거: 6시간 넘게 **진행 중인** 방송을 알리지 않는 것은 AC-29 의 취지에 어긋나고,
 *   `liveHash` 원장이 중복을 막으므로 위험이 없다. §3-a 로도 늦은 공지(1위)가 누락(2위)보다 낫다.
 *   반면 **이미 끝난** 방송을 공지하는 것은 3위라 절대 하지 않는다.
 *
 * ★ 라이브 복구는 **§5.1 의 3상태 판정식을 그대로 재사용한다**(`live-state.ts`).
 *   복구 전용 규칙을 따로 만들지 않는다 — 두 벌을 두면 한쪽만 고쳤을 때 갈라지고,
 *   하필 그 갈라짐이 "끝난 방송에 시작 공지" 로 나타난다.
 *
 * ★★ **라이브 경로에는 `seeded` 선점을 하지 않는다** (계획 rev.4 B-1).
 *   하면 이후 `announce` 의 `claim` 이 **반드시** 실패해
 *   "7시간 + `announce` → 1건" 수용 기준이 **구조적으로 통과 불가**가 된다.
 *   `seeded` 는 유튜브 전용이며 스키마 CHECK 도 그렇게 강제한다.
 */

import type { LiveJudgment, LiveStateInput } from '../live/live-state.js';
import { judgeLiveState } from '../live/live-state.js';
import type { LiveAnnounceFn, LiveLedger } from '../live/live-announce.js';
import { jobFromPoll, liveAnnounceLabel } from '../live/live-announce.js';

/** 기본 기준 시간 — `recovery.downtimeThresholdHours` (6시간) */
export const DEFAULT_DOWNTIME_THRESHOLD_HOURS = 6;

export interface DowntimeWindow {
  /** 마지막 생존 시각(ms). 표식이 없거나 깨졌으면 undefined */
  lastSeenAt: number | undefined;
  /** 지금(ms) */
  now: number;
  /** `lastSeenAt` 이 없으면 undefined — **0 으로 접지 않는다** */
  durationMs: number | undefined;
  /** 기준 시간을 넘겼는가. 알 수 없으면 `true`(보수적) */
  exceeded: boolean;
  /** 표식이 아예 없었다 = 첫 기동이거나 DB 가 새것 */
  firstBoot: boolean;
}

/**
 * 다운타임을 잰다.
 *
 * ★ 경계는 **`>` 가 아니라 `>=` 가 아니다** — 계획은 *"기준 시간(기본 6시간) **이하**이면
 *   전부 공지, **초과**하면 생략"* 이라 했다. 즉 정확히 6시간이면 **공지하는 쪽**이다.
 *   §9.1 이 `6h±1s` 경계 테스트를 요구한 자리다.
 *
 * ★ `lastSeenAt` 이 없으면 `exceeded: true` 로 둔다. 첫 기동에 과거 영상을 도배하는 것보다
 *   생략하고 기록을 남기는 편이 안전하다 — AC-26(최초 기동 시딩)과도 방향이 같다.
 */
export function measureDowntime(
  lastSeenAt: number | undefined,
  now: number,
  thresholdHours = DEFAULT_DOWNTIME_THRESHOLD_HOURS,
): DowntimeWindow {
  const thresholdMs = thresholdHours * 60 * 60 * 1_000;
  if (lastSeenAt === undefined) {
    return { lastSeenAt, now, durationMs: undefined, exceeded: true, firstBoot: true };
  }
  // ★ 음수 방어: 시계가 뒤로 갔거나 표식이 미래다. 0 으로 접고 초과로 보지 않는다.
  const durationMs = Math.max(0, now - lastSeenAt);
  return { lastSeenAt, now, durationMs, exceeded: durationMs > thresholdMs, firstBoot: false };
}

/**
 * 아웃박스가 회수한 **업로드** 행이 보내기엔 너무 늦었는가.
 *
 * ★★ 이 판정이 AC-30 과 **같은 규칙의 나머지 절반**이다. 기동 복구는 *"다운타임이
 *   기준을 넘으면 밀린 유튜브 알림을 전량 생략"* 한다. 그런데 재기동 없이 디스코드만
 *   오래 죽어 있으면 같은 상황인데도 그 규칙이 적용되지 않아, 복구가 살아난 순간
 *   **이틀 지난 업로드 공지가 튀어나온다.** 같은 임계값을 쓰는 이유가 이것이다 —
 *   "얼마나 지난 알림까지 의미가 있는가" 는 경로가 아니라 시간이 정한다.
 *
 * ★ 경계는 `measureDowntime` 과 같다: 정확히 기준이면 **보내는 쪽**이다.
 *
 * ★ 기준은 `claimed_at`(처음 감지한 시각)이다. 마지막 시도 시각이 아니다 —
 *   재시도를 오래 한 것과 **알림이 오래된 것**은 다른 질문이고, 시청자에게 의미가
 *   있는 쪽은 뒤다.
 */
export function isStaleUploadResend(
  claimedAtMs: number | undefined,
  now: number,
  thresholdHours = DEFAULT_DOWNTIME_THRESHOLD_HOURS,
): boolean {
  // ★ 시각을 못 읽으면 **보낸다.** 늦은 공지(§3-a 1위)가 누락(2위)보다 낫고,
  //   파싱 실패를 억제 사유로 쓰면 멀쩡한 공지가 조용히 사라진다.
  if (claimedAtMs === undefined || Number.isNaN(claimedAtMs)) return false;
  return Math.max(0, now - claimedAtMs) > thresholdHours * 60 * 60 * 1_000;
}

/** 사람이 읽는 기간 문구 — 운영 채널 기록에 싣는다 (AC-30) */
export function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${String(m)}분`;
  return m === 0 ? `${String(h)}시간` : `${String(h)}시간 ${String(m)}분`;
}

// ══════════════════════════════════════════════════════════════════
//  라이브 복구
// ══════════════════════════════════════════════════════════════════

export type LiveRecoveryOutcome =
  /** `announce` 였고 원장 선점에 성공해 공지했다 */
  | { kind: 'announced'; liveHash: string }
  /** `announce` 였으나 이미 공지된 방송이다 (원장이 막았다) */
  | { kind: 'already-announced'; liveHash: string }
  /** `ended` — 세션만 닫는다. 공지하지 않는다 (AC-31) */
  | { kind: 'ended' }
  /**
   * `unknown` — 공지하지 않고 주기 폴링에 넘긴다.
   *
   * ★ 기동 직후의 실패는 **`unknown` 연속 카운터의 1회차**로 센다. 그대로 이어지면
   *   AC-P2 경보가 뜬다 — 복구가 조용히 실패하는 것을 관측 가능하게 만드는 자리다.
   */
  | { kind: 'unknown'; reason: string };

export interface LiveRecoveryDeps {
  /** 기동 시 `GET /api/live` 1회 조회 결과 */
  input: LiveStateInput;
  ledger: LiveLedger;
  announce: LiveAnnounceFn;
  /** ISO-8601 UTC */
  at: string;
  /** `ended` 일 때 세션을 닫는다 */
  closeOpenSessions?: (at: string) => void;
}

/**
 * 기동 복구의 라이브 판정 — **다운타임 길이를 보지 않는다.**
 *
 * ★ 이것이 §S7 의 요점이다. 진행 중인 방송은 **현재 사실**이지 지나간 이벤트가 아니므로
 *   AC-30 의 생략 대상이 아니다. 생략 대상은 지나간 유튜브 업로드뿐이다.
 */
export async function recoverLive(deps: LiveRecoveryDeps): Promise<LiveRecoveryOutcome> {
  const judgment: LiveJudgment = judgeLiveState(deps.input);

  if (judgment.state === 'unknown') {
    return { kind: 'unknown', reason: judgment.reason };
  }

  if (judgment.state === 'ended') {
    deps.closeOpenSessions?.(deps.at);
    return { kind: 'ended' };
  }

  const { liveHash, channel } = judgment;
  // ★ 선점에 성공한 쪽만 보낸다. `seeded` 를 세우지 않는다 (B-1).
  const won = deps.ledger.claim('live_start', liveHash, deps.at, 'recovery');
  if (!won) return { kind: 'already-announced', liveHash };

  await deps.announce(jobFromPoll(channel, liveHash, 'recovery'));
  return { kind: 'announced', liveHash };
}

// ══════════════════════════════════════════════════════════════════
//  유튜브 복구
// ══════════════════════════════════════════════════════════════════

/** 피드에서 본 영상 하나 — 복구가 필요한 최소 정보만 */
export interface RecoverableVideo {
  videoId: string;
  channelId: string;
  /** ISO-8601. 정렬 기준 */
  publishedAt: string;
}

export type YoutubeRecoveryOutcome =
  /** 다운타임 ≤ 기준: 밀린 항목을 시간 순서대로 공지했다 */
  | { kind: 'backfilled'; announced: string[]; skipped: string[] }
  /** 다운타임 > 기준: 전량 생략하고 현재 피드를 선점만 했다 (AC-30) */
  | { kind: 'skipped'; seeded: string[]; durationText: string };

export interface YoutubeRecoveryDeps {
  window: DowntimeWindow;
  /** 기동 시 RSS 를 1회 훑은 결과 */
  videos: readonly RecoverableVideo[];
  ledger: LiveLedger;
  /** 공지 1건. **절대 reject 하지 않는다** */
  announce: (video: RecoverableVideo) => Promise<void>;
  at: string;
  /** AC-30 의 운영 채널 기록 */
  recordSkip?: (detail: string) => void;
  /**
   * RSS 는 최신 15개까지만 준다. 그 범위를 벗어났을 가능성을 기록한다 (계획 §S7).
   *
   * ★ "밀린 것을 전부 공지했다"고 말할 수 없는 경우가 있다는 뜻이고, 그 사실을
   *   조용히 두면 누락이 스스로를 숨긴다(§3-a 2위의 성질).
   */
  feedLimit?: number;
}

export const DEFAULT_RSS_FEED_LIMIT = 15;

export async function recoverYoutube(deps: YoutubeRecoveryDeps): Promise<YoutubeRecoveryOutcome> {
  const limit = deps.feedLimit ?? DEFAULT_RSS_FEED_LIMIT;

  // ── 기준 초과: 전량 생략 + 현재 피드 seeded 선점 + 기록 (AC-30) ──────────
  if (deps.window.exceeded) {
    const seeded: string[] = [];
    for (const v of deps.videos) {
      // ★ seeded=1 은 `youtube_upload` 에서만 합법이다 (스키마 CHECK).
      if (deps.ledger.claim('youtube_upload', v.videoId, deps.at, 'seed', { seeded: true })) {
        seeded.push(v.videoId);
      }
    }
    const durationText =
      deps.window.durationMs === undefined
        ? '기간 불명(생존 표식 없음)'
        : formatDuration(deps.window.durationMs);
    deps.recordSkip?.(
      `${durationText} 동안 중단됨 — 밀린 유튜브 알림 ${String(seeded.length)}건 생략`,
    );
    return { kind: 'skipped', seeded, durationText };
  }

  // ── 기준 이하: 밀린 항목을 publishedAt 오름차순으로 전부 공지 (AC-29) ────
  // ★ 오름차순이어야 한다. 피드는 최신순으로 오므로 그대로 보내면 시간이 거꾸로 흐른다.
  const ordered = [...deps.videos].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));

  const announced: string[] = [];
  const skipped: string[] = [];
  for (const v of ordered) {
    if (!deps.ledger.claim('youtube_upload', v.videoId, deps.at, 'recovery')) {
      // 이미 공지한 영상이다 — 원장이 막았다 (AC-24)
      skipped.push(v.videoId);
      continue;
    }
    await deps.announce(v);
    announced.push(v.videoId);
  }

  // ★★ 피드 상한에 닿았고 **원장이 하나도 모르는 영상뿐**이었으면 그 너머는 볼 수 없었다.
  //   `videos.length >= limit` 만으로 판정하면 안 된다 — 유튜브 RSS 는 영상이 15개 이상인
  //   채널이면 **언제나 정확히 15건**을 주므로, 그 조건은 재기동마다 참이고 경보가 매번
  //   울려 진짜 신호를 덮는다 (운영 관측 2026-09-12). 원장이 하나라도 아는 영상이 있었다면
  //   피드는 마지막 공지 시점보다 더 과거까지 닿은 것이고, 그 사이에 빠진 것은 없다.
  if (deps.videos.length >= limit && skipped.length === 0) {
    deps.recordSkip?.(
      `RSS 피드 상한(${String(limit)}건)에 닿았습니다 — 그보다 오래된 업로드는 확인할 수 없어 누락됐을 수 있습니다.`,
    );
  }

  return { kind: 'backfilled', announced, skipped };
}

/** 로그·경보 문구용 */
export function recoveryLabel(liveHash: string): string {
  return `recovery ${liveAnnounceLabel(liveHash)}`;
}
