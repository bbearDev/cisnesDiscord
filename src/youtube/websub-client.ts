import { randomBytes } from 'node:crypto';

import type { StuckAlert, StuckWatch } from '../live/stuck-watch.js';
import type { Clock, Disposable } from '../runtime/clock.js';
import type { WebSubSubRepo, WebSubSubRow } from '../store/repos/websub-sub-repo.js';
import type { YoutubeChannelRepo } from '../store/repos/youtube-channel-repo.js';
import type { TextClient } from './http-text.js';

/**
 * WebSub 구독 관리 — 계획 §5.3 "WebSub 운영 규칙" (AC-20 · AC-P7).
 *
 * ★★ **허브가 준 `hub.lease_seconds` 를 그대로 저장하고 그 50% 시점에 갱신한다.
 *   상수 5일을 박지 않는다.** 계획이 이 문장을 굵게 적은 이유는 하나다 —
 *   허브가 다른 값을 주면 상수는 **조용히 틀리고**, 틀렸다는 사실은 리스가
 *   만료돼 푸시가 멈춘 뒤에야 드러난다. 최대값은 아직 **미확인**이다(S1-D 가 실측).
 *
 * ★★ **`lease_seconds` 는 구독 POST 의 응답이 아니라 검증 GET 으로 온다.**
 *   WebSub 은 비동기 검증이다 — 허브는 POST 에 202 만 주고, 뒤이어 우리 콜백으로
 *   `hub.challenge` 와 `hub.lease_seconds` 를 실은 GET 을 보낸다.
 *   그래서 `expires_at` 을 채우는 것은 `subscribe()` 가 아니라 `verify()` 다.
 *   POST 응답만 보고 리스를 안다고 적으면 그 코드는 **영영 실행되지 않는 분기**가 된다.
 *
 * ★★ 갱신을 **타이머가 아니라 주기 스윕**으로 한다.
 *   리스는 날 단위인데 타이머는 재기동·시계 점프·놓친 발화에 전부 취약하다.
 *   "남은 리스가 50% 이하면 재구독" 은 **상태에서 매번 다시 계산되는 판정**이라
 *   프로세스가 며칠 뒤에 떠도 같은 답을 낸다. 계획 §3-a 가 말한
 *   "모르는 것은 상태에서 다시 읽는다" 의 형태다.
 *
 * ★ 연속 실패 판정을 **여기서 세지 않는다** (AC-P7). `live/stuck-watch.ts` 의
 *   `'websub-renew'` 도메인에 관측만 넘긴다. 계획 §S6 표가 못 박은 그대로다 —
 *   *"여기서 새로 정의하지 않는다."*
 */

/** 계획 §5.3 — 허브 주소 */
export const YOUTUBE_HUB_URL = 'https://pubsubhubbub.appspot.com/subscribe';

/**
 * 토픽 주소의 앞부분.
 *
 * ⚠️ RSS 폴에 쓰는 `https://www.youtube.com/feeds/videos.xml` 과 **경로가 다르다**
 *   (`/xml/feeds/` 대 `/feeds/`). 둘 다 같은 피드를 주지만 허브는 등록된 토픽
 *   문자열을 **정확히 일치**로 비교하므로, 여기를 폴 주소로 바꾸면 검증 GET 의
 *   `hub.topic` 이 우리 기대와 달라져 모든 검증이 404 로 거절된다.
 */
export const TOPIC_URL_BASE = 'https://www.youtube.com/xml/feeds/videos.xml';

export function topicUrl(channelId: string): string {
  return `${TOPIC_URL_BASE}?channel_id=${encodeURIComponent(channelId)}`;
}

/**
 * 리스가 이만큼 지나면 갱신한다 = **50% 시점** (계획 §5.3).
 *
 * ⚠️ `youtube.leaseWarnRatio`(0.2)와 **다른 값이다.** 저쪽은 "갱신이 안 되고 있다"를
 *   잡는 경보선이고 이쪽은 갱신 시점이다. 둘을 같은 값으로 두면 정상 갱신마다 경보가 난다.
 */
export const LEASE_RENEW_AT_ELAPSED_RATIO = 0.5;

/**
 * 스윕 주기.
 *
 * 리스는 날 단위라 갱신 시점은 분 단위 정밀도면 충분하다. 스윕 한 번의 비용은
 * 채널 수(2~5)만큼의 맵 조회이므로 5분은 사실상 공짜다.
 */
export const WEBSUB_SWEEP_SEC = 300;

/**
 * 재구독 쿨다운.
 *
 * ★ 검증 GET 이 오기 전에는 `expires_at` 이 그대로라 스윕이 매번 "갱신해야 함"으로
 *   읽는다. 쿨다운이 없으면 허브가 검증을 늦추는 동안 5분마다 재구독 폭탄이 나간다.
 *   반대로 너무 길면 허브가 받아만 놓고 검증하지 않는 상태를 오래 끈다 — 10분은
 *   그 사이다. 이 상태는 `leaseWarnRatio` 경보가 별도로 잡는다 (AC-P7).
 */
export const RESUBSCRIBE_COOLDOWN_MS = 10 * 60_000;

/**
 * 구독 요청 1건의 작업 전체 예산 (§5.6.1). 회당 15초 × 재시도 여유.
 *
 * ★ 회당 타임아웃(`websub-subscribe`)보다 **반드시 커야 한다.** 작으면 예산이 먼저
 *   끊어 회당 타임아웃을 올린 효과가 통째로 사라진다 — 값을 올릴 때 짝으로 본다.
 *
 * ★ 채널 2개면 스윕 한 바퀴 최악 60초로, 기본 주기 300초 안에 끝난다.
 */
export const WEBSUB_BUDGET_MS = 30_000;

/**
 * 구독 재시도 백오프 — **연속 실패마다 2배, 상한 1시간.**
 *
 * ★★ 왜 필요한가 (실측 2026-09-10). 구독이 확정되지 않으면 스윕이 매번 "갱신해야 함"
 *   으로 읽어 **5분마다 영원히 재시도한다.** 하루 414건이 나갔고, 그 상대는 우리 IP 를
 *   이미 간헐적으로 조이고 있는 구글이다(같은 날 RSS 피드도 간헐 차단됐다).
 *   즉 재시도 자체가 **막힌 상태를 유지시키는 쪽**으로 일한다.
 *
 * ★ `RESUBSCRIBE_COOLDOWN_MS` 는 이 경우를 못 막는다 — 그 쿨다운은 `subscribed_at`
 *   기준이고 그 값은 **202 를 받았을 때만** 갱신된다. 한 번도 못 받으면 쿨다운은
 *   영원히 통과다. 실패 쪽 브레이크가 따로 있어야 한다.
 *
 * ★ 상한이 1시간인 이유: 리스 갱신은 리스의 50% 시점(유튜브 기준 보통 2일 이상)이라
 *   1시간 지연이 갱신 기한을 위협하지 않는다. 그보다 길면 **막힘이 풀린 뒤 복귀가
 *   느려지는 쪽**이 문제가 된다.
 *
 * ★★ **절충 하나를 적어 둔다: AC-P7 의 후반부는 이 백오프만큼 느려진다.**
 *   AC-P7 은 두 반쪽이다 — 전반부(리스 잔여 경보)는 시도와 무관하게 매 스윕 평가되므로
 *   스윕 주기를 늦추지 않은 덕에 **그대로**다. 그러나 후반부(갱신 연속 실패 3회)의
 *   스트릭은 시도가 실제로 일어날 때만 오르므로 임계 도달이 늦어진다:
 *
 *   ```
 *   전: 300 + 300 + 300  = 15분
 *   후: 0   + 600 + 1200 = 30분
 *   ```
 *
 *   두 배지만 견딜 만하다고 판단했다 — 이 경보가 다루는 것은 분 단위로 급한 사건이
 *   아니고, 재시도를 줄이는 이득이 그보다 크다. 나중에 *"왜 경보가 30분 뒤에 왔지"* 를
 *   다시 파지 않도록 여기 남긴다.
 */
export const WEBSUB_BACKOFF_FACTOR = 2;
export const WEBSUB_BACKOFF_MAX_SEC = 3_600;

/**
 * 연속 실패 `streak` 회일 때 다음 시도까지 기다릴 밀리초.
 *
 * ★ `streak` 은 `stuck-watch` 가 세는 값을 그대로 쓴다 — 여기서 또 세면 같은 규칙이
 *   두 곳에 생기고, 하필 지표(`websub_renew_fail_streak`)와 어긋나는 날이 온다.
 */
export function renewBackoffMs(streak: number, sweepSec: number): number {
  if (streak <= 0) return 0;
  const sec = Math.min(sweepSec * WEBSUB_BACKOFF_FACTOR ** streak, WEBSUB_BACKOFF_MAX_SEC);
  return Math.floor(sec * 1_000);
}

/** 시크릿 길이(바이트). HMAC-SHA1 의 블록(64B)보다 짧게 잡아 내부 해싱을 피한다 */
export const SECRET_BYTES = 32;

// ══════════════════════════════════════════════════════════════════
//  순수 계산 — 리스
// ══════════════════════════════════════════════════════════════════

/**
 * `hub.lease_seconds` 파싱.
 *
 * ★★ **0 · 음수 · 비정수 · 결측을 전부 `undefined` 로 접는다.**
 *   여기서 기본값 5일을 채워 넣고 싶은 유혹이 정확히 계획이 금지한 것이다 —
 *   허브가 값을 안 줬다는 사실과 "5일이다" 는 다른 정보이고, 후자로 적으면
 *   만료 시점이 **아무 근거 없이** 정해진다. 모르는 것은 모른다고 둔다 (§3-a).
 *   `undefined` 면 `expires_at` 이 NULL 로 남고, 스윕이 쿨다운 뒤 재구독한다.
 */
export function parseLeaseSeconds(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

/**
 * 갱신까지 남은 밀리초. 리스를 모르거나 0 이하면 **0(= 지금 갱신)** 이다.
 *
 * ★ 0 을 돌려주는 것이 안전한 방향이다. 모르는 리스를 길게 잡으면 만료를 지나치고,
 *   짧게 잡으면 재구독이 한 번 더 나갈 뿐이다 (쿨다운이 폭주를 막는다).
 */
export function renewAfterMs(leaseSeconds: number | undefined): number {
  if (leaseSeconds === undefined || !Number.isFinite(leaseSeconds) || leaseSeconds <= 0) return 0;
  return Math.floor(leaseSeconds * 1_000 * LEASE_RENEW_AT_ELAPSED_RATIO);
}

/**
 * 리스 잔여 비율 0..1. 지표 `websub_lease_remaining_ratio{channel}` 이자 AC-P7 의 판정값.
 *
 * 리스나 만료 시각을 모르면 **0** 이다 — "모르는 구독"은 경보 대상이 맞다.
 */
export function leaseRemainingRatio(
  nowMs: number,
  expiresAtMs: number | undefined,
  leaseSeconds: number | undefined,
): number {
  if (expiresAtMs === undefined) return 0;
  if (leaseSeconds === undefined || !Number.isFinite(leaseSeconds) || leaseSeconds <= 0) return 0;
  const ratio = (expiresAtMs - nowMs) / (leaseSeconds * 1_000);
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(1, Math.max(0, ratio));
}

function toMs(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

// ══════════════════════════════════════════════════════════════════
//  클라이언트
// ══════════════════════════════════════════════════════════════════

export type SubscribeMode = 'subscribe' | 'unsubscribe';

export type SubscribeOutcome =
  | { ok: true; status: number }
  | { ok: false; reason: string; status?: number };

export interface VerificationInput {
  channelId: string;
  /** `hub.mode` */
  mode: string;
  /** `hub.topic` */
  topic: string;
  /** `hub.lease_seconds` 원문 */
  leaseSecondsRaw?: string | undefined;
}

export type VerificationResult =
  | { accepted: true; mode: SubscribeMode; leaseSeconds?: number | undefined }
  | { accepted: false; reason: string };

/** AC-P7 전반부 — 리스 잔여가 경보선 아래다 */
export interface LeaseWarning {
  channelId: string;
  ratio: number;
  remainingSec: number;
  expiresAt?: string | undefined;
}

export interface SweepOutcome {
  checked: number;
  renewed: number;
  renewFailed: number;
  warnings: LeaseWarning[];
  /** `stuck-watch` 가 이번 스윕에서 발화한 것 (AC-P7 후반부) */
  alerts: StuckAlert[];
}

export interface WebSubClientOptions {
  http: TextClient;
  subs: WebSubSubRepo;
  channels: YoutubeChannelRepo;
  /** 설정 `youtube.channels` */
  configured: readonly { channelId: string; label: string }[];
  /**
   * 공개 콜백 주소 (경로까지). 채널은 `?channel=` 로 붙인다.
   *
   * ★ 경로에 채널을 넣지 않는 이유: `web/server.ts` 의 라우트 표는 **정확 일치**다
   *   (패턴 매칭을 두지 않는 것이 그 파일의 선택이다). 쿼리로 실으면 라우트가 하나로
   *   유지되고, 허브는 콜백 URL 을 문자열 그대로 다시 부르므로 값이 보존된다.
   */
  callbackUrl: string;
  clock: Clock;
  stuck: StuckWatch;
  /** 설정 `youtube.leaseWarnRatio` (기본 0.2) */
  leaseWarnRatio: number;
  hubUrl?: string;
  sweepSec?: number;
  /** 테스트 주입점 */
  secretFactory?: () => string;
  onAlert?: (a: StuckAlert) => void | Promise<void>;
  onLeaseWarning?: (w: LeaseWarning) => void | Promise<void>;
  onLog?: (message: string, extra?: Record<string, unknown>) => void;
}

export interface WebSubClient {
  /**
   * 기동 — 채널·구독 행 보장 → **전 구독의 잔여를 로그 한 줄로** (AC-P7) →
   * 임박·미구독 즉시 갱신 → 주기 스윕 예약.
   */
  start(): Promise<SweepOutcome>;
  /** 구독(또는 해지) 요청 1건. 갱신도 같은 함수다 — 같은 연산이기 때문이다 */
  subscribe(channelId: string, mode?: SubscribeMode): Promise<SubscribeOutcome>;
  /** 허브의 검증 GET. 라우트가 부른다 */
  verify(input: VerificationInput): VerificationResult;
  /** 채널별 시크릿. 라우트의 HMAC 검증이 쓴다. 모르는 채널이면 undefined */
  secretFor(channelId: string): string | undefined;
  /** 갱신·경보 판정 1회. 테스트와 주기 스윕이 같은 함수를 탄다 */
  sweep(): Promise<SweepOutcome>;
  /** 지표 스냅샷 */
  leaseRatios(): { channelId: string; ratio: number }[];
  stop(): void;
}

export function createWebSubClient(opts: WebSubClientOptions): WebSubClient {
  const { http, subs, channels, clock, stuck } = opts;
  const hubUrl = opts.hubUrl ?? YOUTUBE_HUB_URL;
  const sweepSec = opts.sweepSec ?? WEBSUB_SWEEP_SEC;
  const sweepMs = sweepSec * 1_000;
  /**
   * 채널별 **다음 시도 가능 시각**(epoch ms). 실패했을 때만 들어가고 성공하면 지운다.
   *
   * ★ 스윕 주기 자체는 늦추지 않는다. 스윕에는 구독 갱신 말고 **리스 잔여 경보**
   *   (AC-P7)도 달려 있어서, 주기를 늦추면 구독 실패가 경보까지 느리게 만든다.
   *   막아야 하는 것은 허브를 두드리는 빈도뿐이므로 그 지점만 게이트한다.
   */
  const nextAttemptAtMs = new Map<string, number>();
  const newSecret = opts.secretFactory ?? ((): string => randomBytes(SECRET_BYTES).toString('hex'));
  const known = new Map(opts.configured.map((c) => [c.channelId, c.label]));

  let timer: Disposable | undefined;

  const log = (message: string, extra?: Record<string, unknown>): void => {
    try {
      opts.onLog?.(message, extra);
    } catch {
      /* 로그가 구독을 죽이면 안 된다 (Principle 2) */
    }
  };

  function callbackFor(channelId: string): string {
    const sep = opts.callbackUrl.includes('?') ? '&' : '?';
    return `${opts.callbackUrl}${sep}channel=${encodeURIComponent(channelId)}`;
  }

  /** 채널·구독 행을 만든다. 시크릿은 **있으면 그대로 둔다** */
  function ensureRow(channelId: string): WebSubSubRow | undefined {
    const label = known.get(channelId);
    if (label === undefined) return undefined;
    channels.upsert(channelId, label);
    return subs.ensure(channelId, newSecret());
  }

  async function raise(alert: StuckAlert | undefined, out: StuckAlert[]): Promise<void> {
    if (alert === undefined) return;
    out.push(alert);
    try {
      await opts.onAlert?.(alert);
    } catch {
      /* 경보 실패가 갱신 루프를 죽이면 안 된다 */
    }
  }

  async function subscribe(
    channelId: string,
    mode: SubscribeMode = 'subscribe',
  ): Promise<SubscribeOutcome> {
    const row = ensureRow(channelId);
    if (row === undefined) return { ok: false, reason: `설정에 없는 채널: ${channelId}` };

    const form = new URLSearchParams({
      'hub.callback': callbackFor(channelId),
      'hub.mode': mode,
      'hub.topic': topicUrl(channelId),
      // v0.3 파라미터. 0.4 허브는 무시하고, appspot 허브는 이 값을 본다.
      'hub.verify': 'async',
      'hub.secret': row.secret,
    });

    const at = clock.now();
    const r = await http.request('websub-subscribe', hubUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      deadlineAt: at + WEBSUB_BUDGET_MS,
    });

    if (r.ok) {
      // ★ 여기서 `expires_at` 을 채우지 않는다. 리스는 검증 GET 으로만 온다 (머리말).
      subs.markRequested(channelId, clock.date().toISOString());
      return { ok: true, status: r.status };
    }
    return {
      ok: false,
      reason: `${r.kind}: ${r.detail}`,
      ...(r.status === undefined ? {} : { status: r.status }),
    };
  }

  /** 구독 시도 1건 + 결과를 `stuck-watch` 에 넘김 (AC-P7 후반부) */
  async function attempt(channelId: string, out: StuckAlert[]): Promise<boolean> {
    const r = await subscribe(channelId);
    const now = clock.now();
    if (r.ok) {
      subs.clearRenewError(channelId);
      stuck.observe('websub-renew', channelId, false, now);
      // ★ 즉시 푼다. 천천히 회복하면 막힘이 풀린 뒤에도 한참 느린 채로 남는다
      //   (`rss-poller` 가 "한 채널이라도 성공하면 즉시 복귀" 로 둔 것과 같은 이유).
      nextAttemptAtMs.delete(channelId);
      log('websub 구독 요청을 허브가 받았습니다', { channelId, status: r.status });
      return true;
    }
    subs.setRenewError(channelId, r.reason, clock.date().toISOString());
    await raise(stuck.observe('websub-renew', channelId, true, now), out);
    const waitMs = renewBackoffMs(stuck.value('websub-renew', channelId, now), sweepSec);
    if (waitMs > 0) nextAttemptAtMs.set(channelId, now + waitMs);
    log('websub 구독 요청 실패', {
      channelId,
      reason: r.reason,
      retryAfterSec: Math.round(waitMs / 1_000),
    });
    return false;
  }

  async function sweep(): Promise<SweepOutcome> {
    const now = clock.now();
    const out: SweepOutcome = { checked: 0, renewed: 0, renewFailed: 0, warnings: [], alerts: [] };

    for (const channelId of known.keys()) {
      const row = ensureRow(channelId);
      if (row === undefined) continue;
      out.checked += 1;

      const expiresAtMs = toMs(row.expiresAt);
      const subscribedAtMs = toMs(row.subscribedAt);
      const ratio = leaseRemainingRatio(now, expiresAtMs, row.leaseSeconds);

      // ── 갱신 판정: 남은 리스가 50% 이하이거나 아직 검증되지 않았다 ──
      const dueForRenew =
        expiresAtMs === undefined ||
        row.leaseSeconds === undefined ||
        expiresAtMs - now <= row.leaseSeconds * 1_000 * (1 - LEASE_RENEW_AT_ELAPSED_RATIO);
      const cooledDown =
        subscribedAtMs === undefined || now - subscribedAtMs >= RESUBSCRIBE_COOLDOWN_MS;
      // ★ 실패 백오프. `cooledDown`(성공 기준)과 다른 축이다 — 202 를 한 번도 못 받으면
      //   `subscribed_at` 이 갱신되지 않아 쿨다운은 영원히 통과한다.
      const backedOff = now < (nextAttemptAtMs.get(channelId) ?? 0);

      if (dueForRenew && cooledDown && !backedOff) {
        if (await attempt(channelId, out.alerts)) out.renewed += 1;
        else out.renewFailed += 1;
      }

      // ── AC-P7 전반부: 잔여 비율 경보 ──────────────────────────────
      // ★ 여기에는 카운터가 없다. **절대 임계 비교 하나**다 — 연속 판정이 필요한
      //   쪽(갱신 실패)만 `stuck-watch` 가 세고, 반복 발송은 `OpsAlertService` 의
      //   (scope, kind) 디바운스가 막는다. 여기에 또 카운터를 두면 같은 규칙이
      //   두 곳에 생긴다.
      if (expiresAtMs !== undefined && ratio < opts.leaseWarnRatio) {
        const warning: LeaseWarning = {
          channelId,
          ratio,
          remainingSec: Math.max(0, Math.round((expiresAtMs - now) / 1_000)),
          ...(row.expiresAt === undefined ? {} : { expiresAt: row.expiresAt }),
        };
        out.warnings.push(warning);
        try {
          await opts.onLeaseWarning?.(warning);
        } catch {
          /* 경보 실패가 스윕을 죽이면 안 된다 */
        }
      }
    }

    return out;
  }

  return {
    async start(): Promise<SweepOutcome> {
      for (const channelId of known.keys()) ensureRow(channelId);

      // ★ AC-P7 — 기동 시 **모든 구독의 잔여를 로그 한 줄로** 남긴다.
      //   채널마다 한 줄씩 내면 기동 로그에서 이 정보가 흩어져, 사람이
      //   "어느 것이 임박했나" 를 눈으로 비교하지 못한다.
      const now = clock.now();
      log(
        'websub 구독 잔여',
        {
          subscriptions: subs.list().map((s) => ({
            channelId: s.channelId,
            leaseSeconds: s.leaseSeconds ?? null,
            expiresAt: s.expiresAt ?? null,
            remainingRatio: Number(
              leaseRemainingRatio(now, toMs(s.expiresAt), s.leaseSeconds).toFixed(3),
            ),
            lastRenewError: s.lastRenewError ?? null,
          })),
        },
      );

      const first = await sweep();

      timer?.dispose();
      timer = clock.setInterval(() => {
        void sweep();
      }, sweepMs);

      return first;
    },

    subscribe,
    sweep,

    verify(input): VerificationResult {
      if (!known.has(input.channelId)) {
        return { accepted: false, reason: `설정에 없는 채널: ${input.channelId}` };
      }
      // ★ 토픽을 정확 일치로 본다. 허브가 다른 토픽의 검증을 우리 콜백으로 보내면
      //   그것은 콜백 URL 이 새어 나갔다는 뜻이고, 받아 주면 남의 피드를 우리
      //   채널 이름으로 공지하게 된다.
      if (input.topic !== topicUrl(input.channelId)) {
        return { accepted: false, reason: `토픽 불일치: ${input.topic}` };
      }

      if (input.mode === 'unsubscribe') {
        subs.remove(input.channelId);
        log('websub 구독 해지가 검증됐습니다', { channelId: input.channelId });
        return { accepted: true, mode: 'unsubscribe' };
      }
      if (input.mode !== 'subscribe') {
        return { accepted: false, reason: `알 수 없는 mode: ${input.mode}` };
      }

      if (ensureRow(input.channelId) === undefined) {
        return { accepted: false, reason: `구독 행을 만들지 못했습니다: ${input.channelId}` };
      }

      // ★★ 여기가 계획의 핵심 문장이 실행되는 자리다 —
      //    **허브가 준 값을 그대로 저장한다.** 상수는 없다.
      const leaseSeconds = parseLeaseSeconds(input.leaseSecondsRaw);
      const expiresAt =
        leaseSeconds === undefined
          ? undefined
          : new Date(clock.now() + leaseSeconds * 1_000).toISOString();
      subs.recordLease(input.channelId, leaseSeconds, expiresAt);

      if (leaseSeconds === undefined) {
        // 리스를 모르는 구독은 만료를 계산할 수 없다. 스윕이 쿨다운 뒤 재구독한다.
        log('websub 검증에 lease_seconds 가 없습니다 — 만료를 알 수 없습니다', {
          channelId: input.channelId,
          raw: input.leaseSecondsRaw ?? null,
        });
      } else {
        log('websub 구독이 검증됐습니다', {
          channelId: input.channelId,
          leaseSeconds,
          expiresAt,
          renewAfterSec: Math.round(renewAfterMs(leaseSeconds) / 1_000),
        });
      }

      return { accepted: true, mode: 'subscribe', leaseSeconds };
    },

    secretFor(channelId): string | undefined {
      if (!known.has(channelId)) return undefined;
      return subs.get(channelId)?.secret;
    },

    leaseRatios(): { channelId: string; ratio: number }[] {
      const now = clock.now();
      return subs
        .list()
        .map((s) => ({
          channelId: s.channelId,
          ratio: leaseRemainingRatio(now, toMs(s.expiresAt), s.leaseSeconds),
        }));
    },

    stop(): void {
      timer?.dispose();
      timer = undefined;
    },
  };
}
