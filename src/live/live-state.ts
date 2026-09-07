import type { LiveApiChannel, LiveApiFailure } from '../chzzk/live-api-schema.js';

/**
 * ★★★ 3상태 판정기 — **유일한 판정 지점** (계획 §5.1 · §S5, DD-2 · AC-31).
 *
 * 폴러 · 복구 · 테스트가 전부 이 함수를 부른다.
 * **`live` / `confirmed` / `status` 필드를 이 파일 밖에서 읽지 않는다.**
 * 읽는 순간 판정 규칙이 두 곳에 생기고, 그것이 §10 시나리오 1이 지목한 결함의
 * 정확한 형태다 — 한쪽만 고친 날 두 규칙이 갈린다.
 *
 * ```
 * announce  ⟸  live && confirmed && liveHash 존재
 * ended     ⟸  !live && status === 'running'
 * unknown   ⟸  그 외 전부
 *              · status !== 'running'  (starting / failed / stopped / 부재)
 *              · 연결 실패 · 타임아웃 · 401 · 404 · 5xx · 스키마 불일치
 *              · live && !confirmed                      ← DD-2 의 자리
 *              · 응답에 우리 채널이 아예 없음
 * ```
 *
 * ★★ **`unknown` 을 `ended` 로도 `announce` 로도 접지 않는다.**
 *   접는 순간 AC-31("이미 종료된 방송에 시작 공지 금지")의 판정 근거가 무너진다:
 *   "모름"을 "꺼짐"으로 읽으면 진행 중인 방송을 놓치고, "켜짐"으로 읽으면
 *   끝난 방송에 시작 공지가 나간다. **Principle 3.**
 *
 * ★ rev.5 실측 — **평상시(방송 없음) 응답이 `live:false, confirmed:false,
 *   status:'running'`** 이다. 이건 `ended` 이고 **정상**이다. 공지도 경보도 없다.
 *   `confirmed` 만 보고 판정했다면 방송이 없는 내내 오경보가 났을 것이다.
 *
 * ★ 판정 순서는 위 식을 **글자 그대로** 따른다: announce → ended → unknown.
 *   `live:true` 는 상류에서 `status === 'running'` 일 때만 서는 값이라
 *   "`live:true` + `status:'starting'`" 은 계약상 나올 수 없는 조합이다.
 *   그런 조합이 실제로 오면 `confirmed`·`liveHash` 가 함께 있는 쪽(= 신원이 확정된
 *   진짜 방송)을 믿는 것이 §3-a 상 안전하다 — 원장이 중복을 막으므로 위험이 없고,
 *   반대로 접으면 진행 중인 방송을 놓친다(2위).
 */

export type LiveState = 'announce' | 'ended' | 'unknown';

/**
 * `unknown` 이 된 이유.
 *
 * ★ 판정을 바꾸지 않는다 — 전부 똑같이 `unknown` 이다. 이유를 남기는 것은
 *   **호출부가 필드를 다시 읽지 않게 하기 위해서다.** AC-P1(`confirmed` 고착)은
 *   "`live && !confirmed` 가 5분 지속"인데, 폴러가 그걸 알려면 필드를 읽거나
 *   여기서 받아야 한다. 후자여야 판정이 한 곳에 남는다.
 */
export type UnknownReason =
  /** `live && !confirmed` — ★ AC-P1 의 판정 입력. DD-2 가 막는 그 상태 */
  | 'unconfirmed'
  /** `live && confirmed` 인데 `liveHash` 가 없다 — 공지할 키가 없다 */
  | 'no-identity'
  /** `status !== 'running'` — 봇이 그 채널을 아직/이미 서빙하지 않는다 */
  | 'status-not-running'
  /** 응답은 왔는데 우리 채널이 목록에 없다 (§5.2-c 보호 목록 (a)) */
  | 'channel-missing'
  /** 연결 실패 · 타임아웃 · 예산 초과 · 4xx · 5xx */
  | 'transport'
  /** 본문이 계약과 다르다 (필수 필드 누락 · version 불일치) */
  | 'schema';

export type LiveStateInput =
  /** 응답에서 우리 채널을 골라냈다 */
  | { kind: 'channel'; channel: LiveApiChannel }
  /** 응답은 정상인데 우리 채널이 없다 */
  | { kind: 'channel-missing' }
  /** 조회 자체가 실패했다 */
  | { kind: 'failure'; failure: LiveApiFailure; detail?: string };

export type LiveJudgment =
  | { state: 'announce'; liveHash: string; channel: LiveApiChannel }
  | { state: 'ended'; channel: LiveApiChannel }
  | { state: 'unknown'; reason: UnknownReason; detail?: string };

/** `status` 가 이 값일 때만 `!live` 를 "종료"로 읽을 수 있다 */
export const RUNNING_STATUS = 'running';

/** 실패 종류 → `unknown` 이유. **전부 unknown 이다 — 매핑은 진단 라벨일 뿐이다** */
function reasonOfFailure(failure: LiveApiFailure): UnknownReason {
  return failure === 'schema' || failure === 'bad-body' ? 'schema' : 'transport';
}

/**
 * ★ 모든 폴링 응답은 정확히 이 셋 중 하나로만 접힌다. 2상태로 접지 않는다.
 */
export function judgeLiveState(input: LiveStateInput): LiveJudgment {
  if (input.kind === 'failure') {
    return {
      state: 'unknown',
      reason: reasonOfFailure(input.failure),
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    };
  }
  if (input.kind === 'channel-missing') {
    return { state: 'unknown', reason: 'channel-missing' };
  }

  const ch = input.channel;

  // ① announce ⟸ live && confirmed && liveHash 존재
  if (ch.live && ch.confirmed) {
    const hash = ch.liveHash;
    if (hash !== undefined && hash.length > 0) {
      return { state: 'announce', liveHash: hash, channel: ch };
    }
    // 신원이 확정됐다는데 키가 없다 — 공지할 수 없고, 그렇다고 종료도 아니다.
    return { state: 'unknown', reason: 'no-identity' };
  }

  // ② ended ⟸ !live && status === 'running'
  //    ★ `status` 조건이 빠지면 "봇이 그 채널을 아직 안 붙였다"가 "방송이 끝났다"가 된다.
  if (!ch.live && ch.status === RUNNING_STATUS) {
    return { state: 'ended', channel: ch };
  }

  // ③ 그 외 전부 unknown.
  if (ch.live) {
    // live 인데 ①을 못 지났다 = confirmed 가 false 다. ★ DD-2 · AC-P1 의 자리.
    return { state: 'unknown', reason: 'unconfirmed' };
  }
  return { state: 'unknown', reason: 'status-not-running' };
}

/**
 * AC-P1 의 판정 입력 — "이 관측이 `confirmed` 고착인가".
 *
 * ★ 호출부가 `judgment.reason === 'unconfirmed'` 를 직접 비교해도 되지만,
 *   그 문자열을 폴러에 적어 두면 이유 이름이 바뀌는 날 **경보가 조용히 죽는다**
 *   (조건이 영영 참이 되지 않고, 침묵이라 아무도 모른다). 함수로 두면 컴파일이 잡는다.
 */
export function isConfirmedStuck(judgment: LiveJudgment): boolean {
  return judgment.state === 'unknown' && judgment.reason === 'unconfirmed';
}

/**
 * AC-P2 의 판정 입력 — "이 관측이 `unknown` 인가".
 *
 * ★ `announce` 와 `ended` 는 **둘 다 성공한 관측이다.** `ended` 를 나쁜 관측으로
 *   세면 방송이 없는 평상시(하루 대부분)가 통째로 스트릭이 되어, 15분마다
 *   `live_api_unknown` 경보가 울린다. 그래서 여기서 명시적으로 갈라 둔다.
 */
export function isUnknown(judgment: LiveJudgment): boolean {
  return judgment.state === 'unknown';
}
