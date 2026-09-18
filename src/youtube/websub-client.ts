import { randomBytes } from 'node:crypto';

import type { StuckAlert, StuckWatch } from '../live/stuck-watch.js';
import type { Clock, Disposable } from '../runtime/clock.js';
import type { WebSubSubRepo, WebSubSubRow } from '../store/repos/websub-sub-repo.js';
import type { YoutubeChannelRepo } from '../store/repos/youtube-channel-repo.js';
import type { TextClient, TextFailureKind } from './http-text.js';

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
 * ⚠️⚠️ RSS 폴에 쓰는 `https://www.youtube.com/feeds/videos.xml` 과 **경로도 내용도
 *   다르다** (`/xml/feeds/` 대 `/feeds/`). 예전 주석은 *"둘 다 같은 피드를 준다"* 고
 *   적었는데 **틀렸다.** 이 주소는 허브에 등록할 **토픽 식별자**일 뿐, 내용은
 *   *"This is a static file … should be used as a topic on the hub"* 안내와
 *   `<link rel="hub">` 만 든 463바이트 스텁이다 (실측 2026-09-15). 영상이 들어 있지 않다.
 *
 * ★ 두 방향 모두 사고가 된다:
 *   · 여기를 폴 주소로 쓰면 → 200 인데 0건. 스로틀로 오진하기 딱 좋다
 *   · 폴 주소를 여기에 쓰면 → 허브가 토픽 문자열을 **정확히 일치**로 비교하므로
 *     검증 GET 의 `hub.topic` 이 어긋나 모든 검증이 404 로 거절된다
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
 * 구독 요청 1건의 작업 전체 예산 (§5.6.1). 회당 30초 + 여유.
 *
 * ★ 회당 타임아웃(`websub-subscribe`)보다 **반드시 커야 한다.** 작으면 예산이 먼저
 *   끊어 회당 타임아웃을 올린 효과가 통째로 사라진다 — 값을 올릴 때 짝으로 본다.
 *
 * ★ 채널 상한 5개 기준 스윕 한 바퀴 최악 `45 × 5 = 225초` 로, 기본 주기 300초 안에
 *   끝난다. 이 부등식은 `websub-lease.test.ts` 가 `MAX_YOUTUBE_CHANNELS` 를 축으로 지킨다.
 */
export const WEBSUB_BUDGET_MS = 45_000;

/**
 * 구독 재시도 백오프 — **연속 실패마다 2배.** 상한은 호출부가 정한다
 * (확정 실패 1시간 / 5xx 30분 — `WEBSUB_PENDING_BACKOFF_MAX_SEC`).
 *
 * ★★ 왜 필요한가 (실측 2026-09-10). 구독이 확정되지 않으면 스윕이 매번 "갱신해야 함"
 *   으로 읽어 **5분마다 영원히 재시도한다.** 하루 414건이 나갔고, 그 상대는 우리 IP 를
 *   이미 간헐적으로 조이고 있는 구글이다(같은 날 RSS 피드도 간헐 차단됐다).
 *   즉 재시도 자체가 **막힌 상태를 유지시키는 쪽**으로 일한다.
 *
 * ★ `RESUBSCRIBE_COOLDOWN_MS` 는 **확정 실패**를 못 막는다 — 그 쿨다운은 `subscribed_at`
 *   기준인데 4xx·network 에서는 그 값이 갱신되지 않아 쿨다운이 영원히 통과다.
 *   실패 쪽 브레이크가 따로 있어야 하는 이유다.
 *
 *   ⚠️ 미정(5xx·timeout)은 다르다. 2026-09-19 부터 그쪽은 `markRequested` 를 걸어
 *   쿨다운이 함께 잡으므로 이 백오프와 **둘 중 긴 쪽**이 실질 간격이 된다.
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
 *   전(고정 300초):            300 + 300 + 300 = 15분
 *   후(백오프, 스윕 정렬 포함):  900 + 1500      = 40분   ← 실측
 *   ```
 *
 * ★★ **실측이 계산보다 길다.** 산술로는 `600 + 1200 = 30분` 인데 실제는 40분이었다
 *   (2026-09-13 갱신, 두 채널 모두 정확히 40분). 백오프가 끝나도 **다음 스윕까지
 *   기다리므로** 간격이 스윕 주기(300초) 단위로 올림되기 때문이다 — 600→900,
 *   1200→1500. 게이트는 스윕 안에서 판정되지 스스로 타이머를 걸지 않는다.
 *
 *   견딜 만하다고 판단했다 — 이 경보가 다루는 것은 분 단위로 급한 사건이 아니고
 *   (리스는 5일, 갱신 창은 2.5일), 재시도를 줄이는 이득이 그보다 크다.
 *   나중에 *"왜 경보가 40분 뒤에 왔지"* 를 다시 파지 않도록 여기 남긴다.
 */
export const WEBSUB_BACKOFF_FACTOR = 2;
export const WEBSUB_BACKOFF_MAX_SEC = 3_600;

/**
 * **미정**(허브가 받았을 수도 있는 실패) 쪽 재시도 상한 — 확정 실패의 절반이다.
 *
 * ★★ 왜 따로 두는가 (실측 2026-09-19). 확정 실패는 기다릴수록 이득이지만 미정은
 *   **다음 시도가 곧 성사일 수 있다.** 같은 요청을 두 채널에 보냈더니 응답은 둘 다
 *   `503` 에 20.29초로 초 단위까지 같았는데 한쪽만 2분 뒤 검증이 왔다 — 즉 허브는
 *   **확률적으로** 처리한다. 성사 가능한 시도를 1시간씩 버리면 만료된 구독이
 *   그만큼 오래 죽어 있는다.
 *
 * ★ 그렇다고 상한을 없애면 안 된다. 미정은 `RESUBSCRIBE_COOLDOWN_MS`(10분)가 하한을
 *   잡아 주지만 그것만으로는 채널당 하루 144회다 — 2026-09-10 에 하루 414건으로
 *   구글에 조였던 전례가 있다. 30분이면 채널당 48회로, 붙을 기회는 남기고 부하는 던다.
 */
export const WEBSUB_PENDING_BACKOFF_MAX_SEC = 1_800;

/**
 * 연속 실패 `streak` 회일 때 다음 시도까지 기다릴 밀리초.
 *
 * ★ `streak` 은 `stuck-watch` 가 세는 값을 그대로 쓴다 — 여기서 또 세면 같은 규칙이
 *   두 곳에 생기고, 하필 지표(`websub_renew_fail_streak`)와 어긋나는 날이 온다.
 *
 * ★ `maxSec` 은 호출부가 정한다 (확정 실패 1시간 / 미정 30분). 기본값을 확정 실패로
 *   둔 것은 이 함수를 부르는 새 자리가 생겼을 때 **덜 두드리는 쪽**으로 틀리기 위해서다.
 */
export function renewBackoffMs(
  streak: number,
  sweepSec: number,
  maxSec: number = WEBSUB_BACKOFF_MAX_SEC,
): number {
  if (streak <= 0) return 0;
  const sec = Math.min(sweepSec * WEBSUB_BACKOFF_FACTOR ** streak, maxSec);
  return Math.floor(sec * 1_000);
}

/**
 * 실패한 구독 요청이 **허브에서 어떻게 끝났는가.**
 *
 * ★★ 이 판정이 존재하는 이유 (실측 2026-09-19). 허브(`pubsubhubbub.appspot.com`)는
 *   구독 요청에 20초를 끌다 `503 Transient error; please try again later` 를 돌려주면서
 *   **뒤에서는 그 구독을 처리하고 검증 GET 을 보낸다.** 실제로 503 을 받은 요청이
 *   2분 뒤 검증돼 5일짜리 리스가 붙었다. 즉 `ok === false` 는 *"실패했다"* 가 아니라
 *   *"결과를 모른다"* 일 수 있다.
 *
 * ★★ **불리언 하나로는 모자란다.** 이 판정에 달린 결정이 셋인데 서로 범위가 다르다:
 *
 *   |                         | 검증 대기 창 | 30분 상한 | *"기다리면 붙는다"* 문구 |
 *   |-------------------------|:-----------:|:--------:|:----------------------:|
 *   | `may-be-accepted` (5xx) |      ○      |    ○     |           ○            |
 *   | `no-answer` (timeout)   |      ○      |    ✕     |           ✕            |
 *   | `rejected` (4xx·network)|      ✕      |    ✕     |           ✕            |
 *
 *   가운뎃줄이 요점이다. 응답을 못 받았으면 **중복 요청은 막아야 하지만**(닿았을 수
 *   있다), 30분 상한과 "곧 붙는다" 는 *503 응답이 20.29초에 도착한* 관측에서 나온
 *   것이지 무응답에서 나온 것이 아니다. 무응답은 오히려 우리가 조여지고 있다는
 *   신호(2026-09-10)에 가까우므로 **덜 두드려야** 한다. 모르는 것은 모른다고 둔다 (§3-a).
 *
 * ★★ `budget` 이 `rejected` 인 이유 — 여기를 틀리면 조용히 나쁘다. 예산 소진은 두
 *   경로인데(`runtime/http-budget.ts`) **둘 다 기다릴 이유가 없다**:
 *     · `remaining <= 0` — 요청을 **보내지도 않았다**
 *     · 429 의 `Retry-After` 가 예산을 넘김 — 허브가 **명시적으로 거절**했다
 *   특히 뒤엣것을 "기다리면 붙는다" 로 접으면, 속도를 줄이라고 말한 상대를
 *   30분마다 두드리면서 운영자에게는 오지 않을 검증을 기다리라고 하게 된다.
 *
 * ★ `4xx` 를 미정에서 뺀 것도 같은 이유다. 거절된 요청까지 "기다려 보자" 로 접으면
 *   **설정이 틀려서 영영 안 붙는 상태**를 10분 창 뒤에 숨기게 된다.
 */
export type HubDelivery =
  /** 5xx — 허브가 받았고 뒤에서 처리 중일 수 있다 (실측된 경로) */
  | 'may-be-accepted'
  /** 응답을 못 받았다 — 닿았는지 모른다 */
  | 'no-answer'
  /** 거절당했거나 닿지 않았다 */
  | 'rejected';

export function hubDelivery(r: {
  kind: TextFailureKind;
  status?: number | undefined;
}): HubDelivery {
  switch (r.kind) {
    case 'http':
      return r.status !== undefined && r.status >= 500 ? 'may-be-accepted' : 'rejected';
    case 'timeout':
      return 'no-answer';
    case 'budget':
    case 'network':
    case 'not-text':
      return 'rejected';
  }
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
  /**
   * ★ `delivery` 는 *"허브에서 어떻게 끝났는가"* — `hubDelivery` 의 판정이다.
   *   `ok: false` 와 겹쳐 보이지만 다른 축이다: `ok` 는 **우리가 확인을 받았는가**,
   *   `delivery` 는 **상대가 일을 시작했을 수 있는가**. 둘을 한 불리언으로 접으면
   *   503 을 실패로 단정하던 그 결함으로 돌아간다.
   */
  | { ok: false; delivery: HubDelivery; reason: string; status?: number };

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
  /**
   * 허브가 받았을 수도 있어 **결과를 모르는** 시도 (`hubMayHaveAccepted`).
   *
   * ★ `renewFailed` 와 갈라 세는 이유는 운영자에게 하는 말이 다르기 때문이다.
   *   "실패" 는 *"다시 눌러도 같다"* 이고 "미정" 은 *"곧 붙을 수 있으니 기다려라"* 다.
   *   한 칸으로 합치면 `/구독갱신` 이 성사 직전인 구독을 실패로 보고한다.
   */
  renewPending: number;
  renewFailed: number;
  /**
   * 갱신할 때가 됐는데 **검증 대기 창에 걸려 시도하지 않은** 채널 수.
   *
   * ★★ "시도할 게 없었다" 와 "기다리는 중이라 안 했다" 는 운영자에게 **다른 말**이다.
   *   이 칸이 없으면 `/구독갱신` 이 둘을 *"갱신할 구독이 없습니다"* 한 문장으로 뭉뚱그리고,
   *   바로 옆에 `잔여 0%` 가 붙어 나온다 — 앞 요청이 처리되는 중인데 운영자는
   *   아무것도 안 하고 있다고 읽는다.
   */
  skippedCooldown: number;
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
  /**
   * **운영자 수동 갱신** — 실패 백오프를 지우고 즉시 스윕한다.
   *
   * ★★ 자동 갱신은 이미 돌고 있다. 이 함수가 버는 것은 **백오프 상한만큼의
   *   시간**뿐이다 — 허브가 막 회복됐을 때 다음 시도를 기다리지 않고 지금 친다.
   *   "자동이 안 되니 수동이 필요하다" 가 아니라 "자동이 그만큼 늦다" 이다.
   *   상한이 갈려 있으므로 실제로 버는 시간도 갈린다 — 확정 실패 최대 1시간,
   *   5xx 최대 30분이다.
   *
   * ★★ **`RESUBSCRIBE_COOLDOWN_MS` 는 지우지 않는다.** 그 쿨다운은 **요청이 허브에
   *   닿았을 때** 검증을 기다리는 10분을 보호한다 — 그것까지 무시하면 허브가 검증하는
   *   동안 운영자가 누를 때마다 재구독 폭탄이 나간다. 지우는 것은 **우리가 스스로 건
   *   브레이크**뿐이다.
   *
   *   ⚠️ 2026-09-19 부터 그 창은 **202 뿐 아니라 `5xx`·무응답에서도 열린다**
   *   (`hubDelivery`). 허브가 오류를 돌려주고도 뒤에서 처리하는 것이 관측됐기 때문이다.
   *   그래서 미정 직후에 누르면 이 함수가 **아무것도 보내지 않는다** — 그것이 맞다.
   *   그 경우 `SweepOutcome.skippedCooldown` 이 올라가고, 명령은 그것을 읽어
   *   *"앞선 요청의 검증을 기다리는 중"* 이라고 답한다.
   */
  renewNow(): Promise<SweepOutcome>;
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
    // ★ 요청을 보내지도 않았다 — 허브가 받았을 리 없으므로 미정이 아니다.
    if (row === undefined) {
      return { ok: false, delivery: 'rejected', reason: `설정에 없는 채널: ${channelId}` };
    }

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
      delivery: hubDelivery(r),
      reason: `${r.kind}: ${r.detail}`,
      ...(r.status === undefined ? {} : { status: r.status }),
    };
  }

  /** 구독 시도 1건의 결과. **`pending` 이 `failed` 와 갈라져 있는 것이 핵심이다** */
  type AttemptResult = 'renewed' | 'pending' | 'failed';

  /** 구독 시도 1건 + 결과를 `stuck-watch` 에 넘김 (AC-P7 후반부) */
  async function attempt(channelId: string, out: StuckAlert[]): Promise<AttemptResult> {
    const r = await subscribe(channelId);
    const now = clock.now();
    if (r.ok) {
      subs.clearRenewError(channelId);
      stuck.observe('websub-renew', channelId, false, now);
      // ★ 즉시 푼다. 천천히 회복하면 막힘이 풀린 뒤에도 한참 느린 채로 남는다
      //   (`rss-poller` 가 "한 채널이라도 성공하면 즉시 복귀" 로 둔 것과 같은 이유).
      nextAttemptAtMs.delete(channelId);
      log('websub 구독 요청을 허브가 받았습니다', { channelId, status: r.status });
      return 'renewed';
    }

    /** 허브가 받았을 수 있다 — 5xx 만. 30분 상한과 "기다리면 붙는다" 가 여기 달린다 */
    const mayHaveAccepted = r.delivery === 'may-be-accepted';
    /** 요청이 닿았는지 모른다 (5xx 이거나 무응답) — 검증 대기 창이 여기 달린다 */
    const uncertain = mayHaveAccepted || r.delivery === 'no-answer';

    /**
     * ★★ **결과를 모르면 검증 대기 창을 연다.** `markRequested` 를 부르는 것이 이 수정의
     *   심장이다 — `subscribed_at` 이 찍혀야 `RESUBSCRIBE_COOLDOWN_MS`(10분)가 걸리고,
     *   그래야 허브가 검증을 보내는 동안 **같은 구독을 또 요청하지 않는다.**
     *   실측(2026-09-19)에서 검증은 503 응답 2분 뒤에 왔다. 10분이면 충분히 덮는다.
     *
     * ★ 무응답(`no-answer`)도 창을 연다. 닿았는지 모르는데 또 보내면 **닿았을 때**
     *   중복이 된다 — §3-a 는 늦는 것(1위)이 틀리는 것보다 낫다고 정해 두었다.
     *
     * ★ 확정 실패(`rejected`)에서는 부르지 않는다. 그쪽은 기다릴 것이 없고,
     *   창을 열면 영영 안 붙는 상태를 10분씩 숨기게 된다.
     */
    if (uncertain) subs.markRequested(channelId, clock.date().toISOString());

    /**
     * ★ 미정에도 `setRenewError` 와 실패 스트릭은 **그대로 올린다.** 구독이 아직
     *   확정되지 않은 것은 사실이고, 그 사실을 감추면 영영 안 붙는 상태를 아무도
     *   모른다 (§3-a 의 "틀리게 보내기" 가 가장 나쁘다). 미정이 바꾸는 것은
     *   **얼마나 기다릴지**이지 **알릴지 말지**가 아니다.
     *
     * ★★ 스트릭을 푸는 것은 **늦게 도착한 검증**이다 (`verify()`). 여기서만 풀면
     *   503→검증 경로로 살아난 구독이 영영 "연속 실패" 로 남는다.
     */
    subs.setRenewError(channelId, r.reason, clock.date().toISOString());
    await raise(stuck.observe('websub-renew', channelId, true, now), out);
    const waitMs = renewBackoffMs(
      stuck.value('websub-renew', channelId, now),
      sweepSec,
      // ★ 30분 상한은 **5xx 에서만**이다. 무응답에 이것을 물리면, 우리가 조여지고
      //   있다는 신호에 대고 두 배로 두드리게 된다 (`hubDelivery` 머리말의 표).
      mayHaveAccepted ? WEBSUB_PENDING_BACKOFF_MAX_SEC : WEBSUB_BACKOFF_MAX_SEC,
    );
    if (waitMs > 0) nextAttemptAtMs.set(channelId, now + waitMs);
    log(
      mayHaveAccepted
        ? 'websub 구독 요청 결과 미정 — 허브가 받았을 수 있어 검증을 기다립니다'
        : 'websub 구독 요청 실패',
      {
        channelId,
        reason: r.reason,
        delivery: r.delivery,
        retryAfterSec: Math.round(waitMs / 1_000),
      },
    );
    return mayHaveAccepted ? 'pending' : 'failed';
  }

  async function runSweep(): Promise<SweepOutcome> {
    const now = clock.now();
    const out: SweepOutcome = {
      checked: 0,
      renewed: 0,
      renewPending: 0,
      renewFailed: 0,
      skippedCooldown: 0,
      warnings: [],
      alerts: [],
    };

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
      // ★ 실패 백오프. `cooledDown` 과 다른 축이다 — 확정 실패(4xx·network)에서는
      //   `subscribed_at` 이 갱신되지 않아 쿨다운이 통과하므로 브레이크가 따로 있어야 한다.
      //   (미정 쪽은 `attempt` 가 `markRequested` 를 걸어 쿨다운이 함께 잡는다.)
      const backedOff = now < (nextAttemptAtMs.get(channelId) ?? 0);

      if (dueForRenew && cooledDown && !backedOff) {
        const res = await attempt(channelId, out.alerts);
        if (res === 'renewed') out.renewed += 1;
        else if (res === 'pending') out.renewPending += 1;
        else out.renewFailed += 1;
      } else if (dueForRenew && !cooledDown) {
        // ★ 백오프(`backedOff`)와 갈라 센다. 저쪽은 "우리가 쉬는 중" 이고 이쪽은
        //   "허브의 답을 기다리는 중" 이다 — 운영자에게 할 말이 다르다.
        out.skippedCooldown += 1;
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

  /**
   * 진행 중인 스윕. **겹침을 막는 유일한 자리다.**
   *
   * ★★ 예전에는 호출자가 주기 타이머 하나뿐이었고 스윕 최대 길이(채널 5 × 45초 = 225초)가
   *   주기(300초)보다 짧아 겹칠 일이 없었다. `renewNow` 가 **아무 때나 부르는 두 번째
   *   호출자**를 만들면서 그 전제가 깨졌다 — 수동 스윕이 도는 20초 사이에 주기 스윕이
   *   뜨면, 백오프를 방금 지웠으므로 같은 채널에 `subscribe` 가 **두 번** 나간다.
   *   허브 장애 중이면 둘 다 503 이라 실패 스트릭도 두 번 오른다.
   *
   * ★★ **공개 `sweep()` 이 이 가드를 탄다.** 가드를 특정 호출자(주기 타이머)에만 걸면
   *   "겹치지 않는다" 가 클라이언트의 성질이 아니라 **호출 규율**이 된다 — 규율은
   *   새 호출자가 생기는 날 조용히 깨진다. 이 PR 이 `renewNow` 로 두 번째 호출자를
   *   만들면서 겪은 것이 정확히 그것이다.
   *
   * ★ 순차로 `await` 하는 호출은 영향받지 않는다. 앞이 끝나면 `inFlight` 가 비므로
   *   다음 호출은 새로 돈다 — 접히는 것은 **정말로 동시인** 호출뿐이다.
   */
  let inFlight: Promise<SweepOutcome> | undefined;

  function sweepOnce(): Promise<SweepOutcome> {
    if (inFlight === undefined) {
      inFlight = runSweep().finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
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

      const first = await sweepOnce();

      timer?.dispose();
      timer = clock.setInterval(() => {
        void sweepOnce();
      }, sweepMs);

      return first;
    },

    subscribe,
    // ★ 공개 `sweep` = 가드를 탄 것. 내부 `runSweep` 은 가드 밖으로 새지 않는다.
    sweep: sweepOnce,

    async renewNow(): Promise<SweepOutcome> {
      /**
       * ★★ **도는 스윕이 있으면 끝을 기다린 뒤 지운다.** 먼저 지우면 그 스윕이 같은
       *   채널을 한 번 더 두드린다 — 이 명령이 막으려던 바로 그 과다 호출이다.
       *
       * ★ 진행 중 스윕에 **그냥 올라타지 않는다.** 그 스윕은 백오프를 **보고** 건너뛴
       *   뒤라, 올라타면 지운 효과가 다음 주기(최대 5분)로 밀린다. 수동 갱신이 버는 것이
       *   그 시간인데 그걸 도로 까먹는 셈이다. 기다렸다가 **새로** 돈다.
       *
       * ★ `catch` 로 삼키는 이유: 앞 스윕의 실패는 그 호출자의 결과이지 이 호출의
       *   결과가 아니다. 여기서 던지면 남의 실패로 수동 갱신이 취소된다.
       */
      if (inFlight !== undefined) await inFlight.catch(() => undefined);
      // ★ 우리 백오프만 지운다. 상류 보호(쿨다운)는 sweep 안에서 그대로 걸린다.
      nextAttemptAtMs.clear();
      return sweepOnce();
    },

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
        //
        // ★★ 여기서는 실패 스트릭을 **풀지 않는다.** 구독은 붙었지만 만료를 모르는
        //   상태이고, 리스 잔여 경보는 `expires_at` 이 NULL 이면 아예 평가되지 않는다
        //   (`runSweep` 의 게이트). 여기서까지 풀면 이 상태를 볼 눈이 하나도 안 남는다.
        log('websub 검증에 lease_seconds 가 없습니다 — 만료를 알 수 없습니다', {
          channelId: input.channelId,
          raw: input.leaseSecondsRaw ?? null,
        });
      } else {
        /**
         * ★★ **갱신 실패 episode 를 닫는 곳이 여기다.**
         *
         *   허브가 `503` 을 돌려주고도 뒤에서 구독을 처리하는 것이 관측된 이상
         *   (2026-09-19), *"갱신이 성공했다"* 를 알려 주는 신호는 구독 POST 의 응답이
         *   아니라 **이 검증 GET** 이다. `attempt()` 의 `observe(false)` 만으로는
         *   그 경로가 닫히지 않는다 — 검증이 도착하면 `expires_at` 이 미래로 밀려
         *   `dueForRenew` 가 2.5일간 거짓이 되고, 그동안 `attempt()` 자체가 불리지
         *   않으므로 스트릭이 **1 인 채로 굳는다.**
         *
         *   그 상태로 다음 갱신 주기를 맞으면 셋이 연달아 틀어진다:
         *     · `websub_renew_fail_streak` 지표가 멀쩡한 채널을 실패로 보고한다
         *     · 성공한 갱신 3번이 쌓여 *"갱신 3회 연속 실패"* 경보가 뜬다 (틀리게 보내기)
         *     · `stuck-watch` 가 `alerted` 를 세워 **진짜 장애 때 경보가 안 뜬다** (안 보내기)
         */
        stuck.observe('websub-renew', input.channelId, false, clock.now());
        nextAttemptAtMs.delete(input.channelId);

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
