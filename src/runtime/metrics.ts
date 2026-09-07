/**
 * ★★★ §9.4 지표 레지스트리 — **"지금 지표가 뭐냐"에 답하는 곳은 하나다.**
 *
 * §9.4 의 표는 *"지표가 **실제로 배선돼 있는지**를 테스트한다"* 고 적었다.
 * 그 문장이 요구하는 것은 값이 아니라 **이름**이다 — 배선이 빠진 지표는
 * 언제나 0 이고, 0 은 *"아무 일도 없었다"* 와 구분되지 않는다. 그래서 침묵은
 * 조용하고, 하필 사고가 났을 때 침묵한다.
 *
 * ★ `ALERT_KINDS`(`runtime/alerts/types.ts`)와 **같은 규율**이다.
 *   저쪽은 목록이 DB CHECK 와 한 글자라도 다르면 경보가 조용히 사라지고,
 *   여기는 목록이 §9.4 표와 어긋나면 **대시보드가 조용히 빈다.** 둘 다
 *   "틀렸다는 사실 자체가 관측되지 않는" 종류라, 목록을 코드로 못 박는다.
 *
 * ★★ **상태를 두 번 갖지 않는다.**
 *   §9.4 지표의 절반은 값이 이미 다른 모듈 안에 산다 — 스트릭은 `stuck-watch`,
 *   팔로워 수치는 `follower-check`, 타임아웃은 `OutboundMetrics`, 재연결 수는
 *   게이트웨이. 그것을 여기로 **복사**하면 두 숫자가 생기고, 갈라지는 날
 *   어느 쪽이 참인지 아무도 모른다. 그래서 그 지표들은 **읽기 함수**로 받는다
 *   (`source: 'reader'`). 이 파일이 하는 일은 *"한 이름으로 물어보면 그 값을
 *   어디서 가져올지 아는 것"* 이지 값을 보관하는 것이 아니다.
 *
 * ★ 이 모듈은 L1(runtime)이라 `stuck-watch`(L4)·`follower-check`(L3)·
 *   게이트웨이(L7)를 import 할 수 없다. 읽기 함수를 주입받는 설계가 그
 *   레이어 규칙과 **같은 방향**이다 — `runtime/outbox.ts` 가 원장을 주입받는
 *   것과 같은 자리다.
 *
 * ★ **어떤 경로도 던지지 않는다.** 기록은 뜨거운 경로(웹훅 수신·공지 발송)에서
 *   불리고 조회는 진단 경로에서 불린다. 지표가 본체를 죽이면 그건 Principle 2
 *   위반이다 — 읽기 함수가 던져도 `snapshot()` 은 그 칸만 비우고 계속 간다.
 */

// ══════════════════════════════════════════════════════════════════
//  §9.4 표 — 이름
// ══════════════════════════════════════════════════════════════════

/**
 * 지표 이름 — 계획 §9.4 표와 **한 글자도 다르면 안 된다.**
 *
 * 로그 필드로도 같은 문자열을 쓴다. 두 축이 갈리면 대시보드와 로그가
 * 다른 값을 보게 된다.
 */
export const METRIC_NAMES = [
  /**
   * ★★ **AC-15 의 판정 축** (§2 확정 해석).
   *
   *   웹훅 수신 → 디스코드 게시 완료까지. 목표 p95 ≤ 5초, 상한 30초다.
   *   *"1분"은 계약 한도이지 설계 목표가 아니다* — 그래서 이 지표가 없으면
   *   AC-15 는 **판정할 수 없다.** `docs/acceptance-checklist.md` 가 검증 방법으로
   *   이 이름을 직접 지목한다.
   */
  'live_webhook_to_post_ms',
  /**
   * `openedAt` 기준 총 지연.
   *
   * ★ **관측 전용이다. 합격 판정에 쓰지 않는다** (§2). 시작 시각은 상류가
   *   준 값이라 우리 책임 밖의 지연(치지직 → chzzkbot 구간)이 섞인다.
   *   그것을 AC-15 로 재면 우리가 고칠 수 없는 사유로 불합격이 난다.
   */
  'live_opened_to_post_ms',
  /**
   * 2xx 를 돌려주기까지 걸린 시간.
   *
   * ★ chzzkbot 계약 `timeoutMs`(5초) 대비 **여유**를 본다. 이 값이 5초에
   *   가까워지면 상류가 우리 응답을 실패로 보고 재전송하기 시작한다 —
   *   공지가 늦어지는 게 아니라 **재시도 폭풍**이 먼저 온다.
   */
  'live_webhook_ack_ms',
  /**
   * 감지 경로 분포 (`webhook` · `api-poll` · `recovery`).
   *
   * ★ **`api-poll` 비율 상승 = 웹훅 고장 신호** (Pre-mortem 2). 폴백이
   *   잘 돌수록 주경로 고장이 감춰지므로, 이 비율이 그것을 드러내는 축이다.
   *   ⬇ **경보는 걸지 않는다** (I-5) — 하루 0~2건이라 비율의 분모가 없다.
   */
  'live_detected_via',
  /** `websub` · `rss` · `recovery` · `seed`. **RSS 비율 = WebSub 건강도** (Pre-mortem 4) */
  'youtube_detected_via',
  /**
   * `not-synced` · `stale` · `http-4xx` · `http-5xx` · `timeout` ·
   * `wrong-channel` · `bad-shape`.
   *
   * ★ **`stale` 은 스코프 상실·동기화 중단을 관측하는 유일한 축이다**
   *   (§13 `scopes-이상`). 라벨이 갈리면 그 축을 잃는다.
   */
  'follower_lookup_unknown_total',
  /** 상류 단건 조회 횟수. **인증 수와 1:1 이어야 한다** — 넘으면 R1(단건)이 깨졌다 */
  'follower_lookup_total',
  /** ★ 신선도 재조회(§5.2 D-2) 발동 수. **인증당 최대 1** */
  'follower_lookup_recheck_total',
  /** DD-3 — 상류 단건 조회 왕복 시간 */
  'follower_lookup_ms',
  /** 거부 안내에 싣는 값과 **같은 값**. R-4 가 실제 데이터를 쓰는지 확인한다 */
  'follower_snapshot_age_sec',
  /** 시청자 토큰 정리 실패 수. 인증을 막지는 않지만 **잔여 권한이 남는다** */
  'viewer_token_revoke_failures',
  /**
   * ★ 마지막 웹훅 수신까지 걸린 시간.
   *
   *   **AC-P6 의 판정 축** — 폴링이 `announce` 를 냈는데 같은 `liveHash` 의
   *   웹훅 기록이 없으면 경보다.
   */
  'live_webhook_silence_sec',
  /** ★ AC-P7 — 채널별 리스 잔여 비율 0..1 */
  'websub_lease_ratio',
  /** ★ AC-P7 — 채널별 갱신 연속 실패 */
  'websub_renew_fail_streak',
  /**
   * ★ `unknown` 연속 횟수.
   *
   *   **`GET /api/live` 는 유일한 아웃바운드라 이 값이 곧 통합 건강도다.**
   *   임계 초과 → AC-P2.
   */
  'live_api_unknown_streak',
  /**
   * ★ `live && !confirmed` 지속 시간(초). 임계 초과 → AC-P1.
   *
   *   정상 창(14초 + 스캔)을 넘는 값이 상시 보이면 chzzkbot 스캔이 병들고 있다.
   */
  'live_unconfirmed_duration_sec',
  /** `confirmed:false` 를 본 횟수. **정상이지만 0 이면 S1-C 관측과 모순된다** */
  'live_unconfirmed_observed',
  /**
   * ★ 3상태 판정 분포 (`announce` · `ended` · `unknown`).
   *
   *   `unknown` 비율이 올라가면 통합이 흔들리는 중이다. 판정 자체는
   *   `live/live-state.ts` 가 하고 **거기에는 부작용을 두지 않는다** —
   *   세는 것은 그 함수를 부른 쪽의 일이다 (§10 시나리오 1 완화책).
   */
  'live_state_verdict',
  /** ★ RSS 폴 연속 실패. 임계 초과 → AC-P4 */
  'youtube_rss_fail_streak',
  /** ★ 서명 검증 실패 수. **AC-P5 — 조용한 202 의 원인을 특정하는 유일한 축** */
  'websub_signature_failures',
  /** ★ 호출별 타임아웃 발생 수. 특정 호출만 치솟으면 그 상류가 병들고 있다 (§5.6.1) */
  'outbound_timeout_total',
  /** ★ 게이트웨이 재연결 수. **FM1 의 조기 경보** — 부하와 상관되면 AC-P3 가 깨지는 중 */
  'discord_gateway_reconnects',
  /** ★ `/인증` 쿨다운 · 동시 상한 · `MAX_PENDING` 도달로 거절한 수 (§5.6.2) */
  'auth_flow_rejected',
  /**
   * 원장이 막은 중복 시도 수.
   *
   * ★★ **0 이 아니어야 정상이다.** 웹훅과 폴링이 같은 방송을 각각 집으려 하는
   *   것이 설계된 정상 동작이고, 이 숫자가 계속 0 이면 *"중복이 없었다"* 가
   *   아니라 **원장이 일하고 있다는 증거가 없다.**
   */
  'announcement_claim_conflicts',
  /** AC-19 — 재시도를 소진한 최종 발송 실패 수 */
  'discord_send_failures',
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

// ══════════════════════════════════════════════════════════════════
//  §9.4 표 — 종류와 출처
// ══════════════════════════════════════════════════════════════════

/**
 * - `counter`  누적. 라벨별로 갈린다
 * - `gauge`    마지막 값. 라벨별로 갈린다
 * - `duration` 밀리초 관측. 횟수 · 마지막 값 · p95
 */
export type MetricKind = 'counter' | 'gauge' | 'duration';

/**
 * - `local`   이 레지스트리가 **기록한다**. 사건이 나는 자리에서 부른다
 * - `reader`  값이 **다른 모듈 안에 산다.** 여기서는 읽기만 한다 (머리말 ★★)
 */
export type MetricSource = 'local' | 'reader';

export interface MetricSpec {
  readonly kind: MetricKind;
  readonly source: MetricSource;
}

/**
 * ★ `satisfies Record<MetricName, MetricSpec>` 가 **완전성을 컴파일에 건다.**
 *   §9.4 이름을 하나 더하고 여기를 빠뜨리면 타입 오류다 — 목록과 표가
 *   갈리는 것을 사람 눈에 맡기지 않는다.
 */
export const METRIC_SPECS = {
  live_webhook_to_post_ms: { kind: 'duration', source: 'local' },
  live_opened_to_post_ms: { kind: 'duration', source: 'local' },
  live_webhook_ack_ms: { kind: 'duration', source: 'local' },
  live_detected_via: { kind: 'counter', source: 'local' },
  youtube_detected_via: { kind: 'counter', source: 'local' },
  follower_lookup_unknown_total: { kind: 'counter', source: 'reader' },
  follower_lookup_total: { kind: 'counter', source: 'reader' },
  follower_lookup_recheck_total: { kind: 'counter', source: 'reader' },
  follower_lookup_ms: { kind: 'duration', source: 'reader' },
  follower_snapshot_age_sec: { kind: 'gauge', source: 'reader' },
  viewer_token_revoke_failures: { kind: 'counter', source: 'reader' },
  live_webhook_silence_sec: { kind: 'gauge', source: 'local' },
  websub_lease_ratio: { kind: 'gauge', source: 'reader' },
  websub_renew_fail_streak: { kind: 'gauge', source: 'reader' },
  live_api_unknown_streak: { kind: 'gauge', source: 'reader' },
  live_unconfirmed_duration_sec: { kind: 'gauge', source: 'reader' },
  live_unconfirmed_observed: { kind: 'counter', source: 'local' },
  live_state_verdict: { kind: 'counter', source: 'local' },
  youtube_rss_fail_streak: { kind: 'gauge', source: 'reader' },
  websub_signature_failures: { kind: 'counter', source: 'reader' },
  outbound_timeout_total: { kind: 'counter', source: 'reader' },
  discord_gateway_reconnects: { kind: 'counter', source: 'reader' },
  auth_flow_rejected: { kind: 'counter', source: 'reader' },
  announcement_claim_conflicts: { kind: 'counter', source: 'local' },
  discord_send_failures: { kind: 'counter', source: 'local' },
} as const satisfies Record<MetricName, MetricSpec>;

/**
 * 종류·출처로 이름을 좁힌다.
 *
 * ★ 이것이 **기록 API 의 오용을 컴파일에 거는 장치**다.
 *   `count('follower_lookup_total')` 은 타입 오류다 — 그 값은 `follower-check`
 *   안에 살고, 여기서 또 세면 두 숫자가 생긴다(머리말 ★★).
 */
type NamesWhere<K extends MetricKind, S extends MetricSource> = {
  [N in MetricName]: (typeof METRIC_SPECS)[N] extends { kind: K; source: S } ? N : never;
}[MetricName];

/** 이 레지스트리가 직접 세는 카운터 */
export type LocalCounter = NamesWhere<'counter', 'local'>;
/** 이 레지스트리가 직접 세우는 게이지 */
export type LocalGauge = NamesWhere<'gauge', 'local'>;
/** 이 레지스트리가 직접 재는 시간 */
export type LocalDuration = NamesWhere<'duration', 'local'>;

export type ReaderCounter = NamesWhere<'counter', 'reader'>;
export type ReaderGauge = NamesWhere<'gauge', 'reader'>;
export type ReaderDuration = NamesWhere<'duration', 'reader'>;
/** 읽기 함수가 필요한 모든 이름 */
export type ReaderMetric = ReaderCounter | ReaderGauge | ReaderDuration;

// ══════════════════════════════════════════════════════════════════
//  값
// ══════════════════════════════════════════════════════════════════

/** 라벨별 값 표. 키는 라벨 값(`webhook` · 채널 id · 호출 이름 …) */
export type LabeledValues = Readonly<Record<string, number>>;

export interface CounterSample {
  readonly kind: 'counter';
  /** 라벨을 합친 총합 */
  readonly total: number;
  readonly byLabel: LabeledValues;
}

export interface GaugeSample {
  readonly kind: 'gauge';
  /**
   * 하나로 읽을 수 있을 때의 값.
   *
   * ★★ **라벨이 둘 이상이면 `undefined` 다.** 여럿을 하나로 접는 규칙이
   *   지표마다 다르기 때문이다 — 리스 잔량(`websub_lease_ratio`)은 **최솟값**이
   *   나쁘고 갱신 연속 실패(`websub_renew_fail_streak`)는 **최댓값**이 나쁘다.
   *   접는 규칙을 레지스트리에 박으면 둘 중 하나는 반드시 틀린 값을 보여준다.
   *   보는 쪽이 `byLabel` 을 직접 접어야 한다.
   */
  readonly value: number | undefined;
  readonly byLabel: LabeledValues;
}

export interface DurationSample {
  readonly kind: 'duration';
  readonly count: number;
  readonly lastMs: number | undefined;
  /**
   * 표본 버퍼 기준 p95.
   *
   * ★ 읽기 함수로 오는 시간 지표(`follower_lookup_ms`)는 `undefined` 다 —
   *   표본은 기록하는 쪽에만 있고, 여기서 다시 모으면 **같은 사건을 두 번 세는
   *   두 번째 사본**이 된다.
   */
  readonly p95Ms: number | undefined;
}

export type MetricSample = CounterSample | GaugeSample | DurationSample;

/** §9.4 표 전체. **모든 이름이 반드시 들어 있다** — 빠진 칸은 곧 침묵이다 */
export type MetricsSnapshot = Readonly<Record<MetricName, MetricSample>>;

// ══════════════════════════════════════════════════════════════════
//  읽기 함수
// ══════════════════════════════════════════════════════════════════

/**
 * 다른 모듈이 이미 갖고 있는 값을 가져오는 함수들.
 *
 * ★ 도메인 지식(어느 스트릭이 어느 지표인가)은 **composition-root 가 갖는다.**
 *   여기서 `stuck-watch` 의 도메인 이름을 문자열로 알고 있으면, 저쪽 이름이
 *   바뀌는 날 이 파일은 컴파일을 통과한 채 **조용히 0 을 돌려준다.**
 *   조립부에서 꽂으면 그 이름 변경이 타입으로 걸린다.
 */
export interface MetricReaders {
  /** 숫자 하나이거나 라벨별 표 */
  readonly counters?: Partial<Record<ReaderCounter, () => number | LabeledValues>>;
  /** 숫자 하나(없으면 `undefined`)이거나 라벨별 표 */
  readonly gauges?: Partial<Record<ReaderGauge, () => number | undefined | LabeledValues>>;
  readonly durations?: Partial<
    Record<ReaderDuration, () => { count: number; lastMs: number | undefined }>
  >;
}

// ══════════════════════════════════════════════════════════════════
//  레지스트리
// ══════════════════════════════════════════════════════════════════

export interface MetricsRegistry {
  /** 카운터 1(또는 `by`) 증가. 라벨을 주면 라벨 칸도 함께 오른다 */
  count(name: LocalCounter, label?: string, by?: number): void;
  /** 게이지의 마지막 값을 세운다 */
  gauge(name: LocalGauge, value: number, label?: string): void;
  /** 시간 관측 1건 (밀리초) */
  duration(name: LocalDuration, ms: number): void;

  /**
   * 읽기 함수를 꽂는다. **한 번만 부를 수 있다.**
   *
   * ★ 왜 생성자가 아니라 별도 호출인가. 원장(L2)은 기록 포트를 **DB 를 여는
   *   순간** 필요로 하는데, 읽기 대상(팔로워 판정기 · 게이트웨이 · WebSub
   *   클라이언트)은 그보다 한참 뒤에 조립된다. 생성자에 몰면 조립 순서를
   *   지표 때문에 비틀어야 한다.
   *
   * ★ 두 번째 호출을 **던지는** 이유: 덮어쓰기를 허용하면 먼저 꽂은 배선이
   *   조용히 사라진다. 그건 이 파일이 막으려는 바로 그 침묵이다.
   */
  bind(readers: MetricReaders): void;

  /** §9.4 표 전체를 이름으로 돌려준다 */
  snapshot(): MetricsSnapshot;

  /**
   * 읽기 함수가 꽂히지 않은 이름.
   *
   * ★★ **비어 있어야 정상이다.** 읽기 함수가 없는 지표는 영원히 0 인데,
   *   0 은 "아무 일도 없었다" 와 구분되지 않는다 — 배선 누락이 정확히 그
   *   모양으로 숨는다. 테스트가 이 목록이 비었는지 단언한다.
   */
  unwired(): readonly MetricName[];
}

/**
 * 표본 버퍼 크기.
 *
 * ★ 무한히 쌓지 않는다. 라이브 이벤트는 하루 0~2건이라 실제로는 몇 개뿐이지만,
 *   상류가 오작동해 같은 이벤트를 쏟아내면 이 배열이 유일한 무한 증가 지점이
 *   된다 (`webhook-silence-watch.ts` 가 같은 이유로 같은 선택을 했다).
 *   256개면 하루치 p95 를 내기에 충분하고, 넘치는 것은 오래된 쪽부터 버린다.
 */
export const SAMPLE_CAPACITY = 256;

interface CounterCell {
  total: number;
  byLabel: Map<string, number>;
}

interface GaugeCell {
  /** 라벨 없이 세운 마지막 값 */
  bare: number | undefined;
  byLabel: Map<string, number>;
}

interface DurationCell {
  count: number;
  lastMs: number | undefined;
  samples: number[];
}

function toRecord(m: ReadonlyMap<string, number>): LabeledValues {
  return Object.fromEntries(m);
}

/**
 * `GaugeSample.value` 의 규칙 — 머리말 ★★ 참조.
 *
 * 라벨 없이 세운 값이 있으면 그것, 없고 라벨이 **정확히 하나**면 그 값,
 * 그 외에는 `undefined`.
 */
function foldGauge(bare: number | undefined, byLabel: LabeledValues): number | undefined {
  if (bare !== undefined) return bare;
  const values = Object.values(byLabel);
  return values.length === 1 ? values[0] : undefined;
}

/** 표본 버퍼 기준 백분위. 표본이 없으면 `undefined` */
export function percentile(samples: readonly number[], p: number): number | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/** 카운터 읽기 값을 표본으로 접는다 */
function counterOf(v: number | LabeledValues): CounterSample {
  if (typeof v === 'number') return { kind: 'counter', total: v, byLabel: {} };
  const total = Object.values(v).reduce((a, b) => a + b, 0);
  return { kind: 'counter', total, byLabel: v };
}

function gaugeOf(v: number | undefined | LabeledValues): GaugeSample {
  if (v === undefined) return { kind: 'gauge', value: undefined, byLabel: {} };
  if (typeof v === 'number') return { kind: 'gauge', value: v, byLabel: {} };
  return { kind: 'gauge', value: foldGauge(undefined, v), byLabel: v };
}

/** 값이 없을 때의 칸. `unwired()` 가 그 사실을 따로 말한다 */
function emptySample(kind: MetricKind): MetricSample {
  if (kind === 'counter') return { kind: 'counter', total: 0, byLabel: {} };
  if (kind === 'gauge') return { kind: 'gauge', value: undefined, byLabel: {} };
  return { kind: 'duration', count: 0, lastMs: undefined, p95Ms: undefined };
}

export function createMetricsRegistry(initial?: MetricReaders): MetricsRegistry {
  const counters = new Map<LocalCounter, CounterCell>();
  const gauges = new Map<LocalGauge, GaugeCell>();
  const durations = new Map<LocalDuration, DurationCell>();
  let readers: MetricReaders | undefined = initial;

  const counterCell = (name: LocalCounter): CounterCell => {
    let c = counters.get(name);
    if (c === undefined) {
      c = { total: 0, byLabel: new Map() };
      counters.set(name, c);
    }
    return c;
  };

  const gaugeCell = (name: LocalGauge): GaugeCell => {
    let g = gauges.get(name);
    if (g === undefined) {
      g = { bare: undefined, byLabel: new Map() };
      gauges.set(name, g);
    }
    return g;
  };

  const durationCell = (name: LocalDuration): DurationCell => {
    let d = durations.get(name);
    if (d === undefined) {
      d = { count: 0, lastMs: undefined, samples: [] };
      durations.set(name, d);
    }
    return d;
  };

  /** 읽기 함수를 태운다. **던져도 스냅샷을 죽이지 않는다** (Principle 2) */
  function read<T>(fn: (() => T) | undefined): T | undefined {
    if (fn === undefined) return undefined;
    try {
      return fn();
    } catch {
      return undefined;
    }
  }

  function sampleOf(name: MetricName): MetricSample {
    const spec: MetricSpec = METRIC_SPECS[name];

    if (spec.source === 'local') {
      if (spec.kind === 'counter') {
        const c = counters.get(name as LocalCounter);
        if (c === undefined) return emptySample('counter');
        return { kind: 'counter', total: c.total, byLabel: toRecord(c.byLabel) };
      }
      if (spec.kind === 'gauge') {
        const g = gauges.get(name as LocalGauge);
        if (g === undefined) return emptySample('gauge');
        const byLabel = toRecord(g.byLabel);
        return { kind: 'gauge', value: foldGauge(g.bare, byLabel), byLabel };
      }
      const d = durations.get(name as LocalDuration);
      if (d === undefined) return emptySample('duration');
      return {
        kind: 'duration',
        count: d.count,
        lastMs: d.lastMs,
        p95Ms: percentile(d.samples, 0.95),
      };
    }

    if (spec.kind === 'counter') {
      const v = read(readers?.counters?.[name as ReaderCounter]);
      return v === undefined ? emptySample('counter') : counterOf(v);
    }
    if (spec.kind === 'gauge') {
      // ★ 게이지는 `undefined` 자체가 정상 값이다 ("아직 관측이 없다").
      //   읽기 함수가 없는 것과 구분은 `unwired()` 가 한다.
      const fn = readers?.gauges?.[name as ReaderGauge];
      return gaugeOf(read(fn));
    }
    const v = read(readers?.durations?.[name as ReaderDuration]);
    if (v === undefined) return emptySample('duration');
    return { kind: 'duration', count: v.count, lastMs: v.lastMs, p95Ms: undefined };
  }

  return {
    count(name, label, by = 1): void {
      const c = counterCell(name);
      c.total += by;
      if (label !== undefined) c.byLabel.set(label, (c.byLabel.get(label) ?? 0) + by);
    },

    gauge(name, value, label): void {
      const g = gaugeCell(name);
      if (label === undefined) g.bare = value;
      else g.byLabel.set(label, value);
    },

    duration(name, ms): void {
      const d = durationCell(name);
      d.count += 1;
      d.lastMs = ms;
      d.samples.push(ms);
      // 오래된 표본부터 버린다. 상한이 256이라 이동 비용은 무시할 수 있다.
      if (d.samples.length > SAMPLE_CAPACITY) d.samples.shift();
    },

    bind(next): void {
      if (readers !== undefined) {
        // ★ 조립 오류다. 덮어쓰면 먼저 꽂은 배선이 조용히 사라진다.
        throw new Error('지표 읽기 함수는 한 번만 꽂을 수 있습니다');
      }
      readers = next;
    },

    snapshot(): MetricsSnapshot {
      const out = {} as Record<MetricName, MetricSample>;
      for (const name of METRIC_NAMES) out[name] = sampleOf(name);
      return out;
    },

    unwired(): readonly MetricName[] {
      const missing: MetricName[] = [];
      for (const name of METRIC_NAMES) {
        const spec: MetricSpec = METRIC_SPECS[name];
        if (spec.source !== 'reader') continue;
        const present =
          spec.kind === 'counter'
            ? readers?.counters?.[name as ReaderCounter] !== undefined
            : spec.kind === 'gauge'
              ? readers?.gauges?.[name as ReaderGauge] !== undefined
              : readers?.durations?.[name as ReaderDuration] !== undefined;
        if (!present) missing.push(name);
      }
      return missing;
    },
  };
}
