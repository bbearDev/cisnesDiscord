/**
 * 고착·연속실패 감시 — AC-P1 · AC-P2 · AC-P4 · AC-P7 이 **한 구현을 공유한다** (계획 §S5).
 *
 * ★ 왜 한 구현인가.
 *   네 경보는 판정 모양이 같다 — "나쁜 상태가 N회 연속" 이거나 "나쁜 상태가 T 시간 지속".
 *   카운터를 각 폴 루프에 흩으면 *"중간에 1회라도 성공하면 리셋"* 규칙이 제어 흐름에
 *   얽히고, 그것이 §10 시나리오 1 완화책(**판정을 전용 모듈로 분리**)의 정확한 위반
 *   형태다. 한 곳에 두면 규칙이 한 번만 존재한다.
 *
 * ★★ **도메인별 카운터는 서로 격리된다.**
 *   공유 구현의 가장 흔한 회귀가 이것이다 — RSS 실패 4건이 `unknown` 스트릭을
 *   오염시키면 두 경보가 서로의 임계를 앞당긴다. 계획 §9.1 이 이 격리를 unit 으로
 *   고정하라고 지목했다.
 *
 * ★ 경보는 **에피소드당 1건**이다.
 *   임계를 넘은 뒤 매 관측마다 발화하면 장애 내내 도배된다. 한 번 발화하면
 *   정상 관측이 들어와 리셋될 때까지 다시 발화하지 않는다.
 */

import type { AlertKind } from '../runtime/alerts/types.js';

/**
 * 감시 도메인.
 *
 * ★ 문자열 리터럴 유니온이라 오타가 컴파일 시점에 걸린다. `string` 으로 두면
 *   `'rss'` 를 `'RSS'` 로 쓴 순간 **조용히 새 도메인이 생겨** 임계에 영영 도달하지 않는다.
 */
export type StuckDomain =
  /** AC-P1 — `live:true, confirmed:false` 지속. **지속시간** 판정 */
  | 'confirmed-stuck'
  /** AC-P2 — `GET /api/live` 의 `unknown` 연속. **연속횟수** 판정 */
  | 'live-api-unknown'
  /** AC-P4 — RSS 폴 연속 실패. **연속횟수** 판정 */
  | 'rss'
  /** AC-P7 — WebSub 갱신 연속 실패. **연속횟수** 판정 */
  | 'websub-renew'
  /**
   * §5.2 — 팔로워 스냅샷 노후.
   *
   * ★★ **배선만 하고 경보는 켜지 않는다** (`armed: false`).
   *   `staleAfterMin` 150분은 소스 상수 추론이지 실측이 아니다(§2-b 에서 잠정으로 격하).
   *   검증 안 된 임계로 경보하면 §13 `scopes-이상` 이 지정한 *"스코프 상실을 관측하는
   *   유일한 축"* 이 오탐에 덮인다. **S1-J 실측 후에 켠다.**
   *   게이트(판정 보류)는 이미 켜져 있다 — 게이트는 틀려도 안전한 방향이고,
   *   경보는 임계가 맞아야 의미가 있다.
   */
  | 'follower-stale';

type Mode = 'streak' | 'duration';

export interface DomainSpec {
  /** 발화할 경보 종류. `alert_state.alert_kind` CHECK 목록의 값이어야 한다 */
  readonly kind: AlertKind;
  readonly mode: Mode;
  /** `streak` 이면 횟수, `duration` 이면 밀리초 */
  readonly threshold: number;
  /** `false` 면 세기는 하되 발화하지 않는다 (지표만 남는다) */
  readonly armed: boolean;
}

export interface StuckWatchThresholds {
  /** AC-P1 기본 5분 (`live.confirmedStuckMin`) */
  confirmedStuckMs: number;
  /** AC-P2 기본 5회 (`live.pollFailThresholdCount`) */
  pollFailCount: number;
  /** AC-P4 기본 5회 (`youtube.rssFailThresholdCount`) */
  rssFailCount: number;
  /** AC-P7 기본 3회 (`youtube.renewFailThresholdCount`) */
  renewFailCount: number;
  /** §5.2 배선만 — 값은 쓰이되 발화하지 않는다 */
  followerStaleCount: number;
}

export function buildSpecs(t: StuckWatchThresholds): Readonly<Record<StuckDomain, DomainSpec>> {
  return {
    'confirmed-stuck': {
      kind: 'confirmed_stuck',
      mode: 'duration',
      threshold: t.confirmedStuckMs,
      armed: true,
    },
    'live-api-unknown': {
      kind: 'live_api_unknown',
      mode: 'streak',
      threshold: t.pollFailCount,
      armed: true,
    },
    rss: { kind: 'rss_fail', mode: 'streak', threshold: t.rssFailCount, armed: true },
    'websub-renew': {
      kind: 'websub_lease',
      mode: 'streak',
      threshold: t.renewFailCount,
      armed: true,
    },
    // ★ armed: false — 위 도메인 주석 참조. S1-J 실측 후에 true 로 바꾼다.
    'follower-stale': {
      kind: 'follower_stale',
      mode: 'streak',
      threshold: t.followerStaleCount,
      armed: false,
    },
  };
}

/** 발화 사실. 호출부가 이것을 받아 운영 채널에 싣는다 */
export interface StuckAlert {
  domain: StuckDomain;
  kind: AlertKind;
  /** 채널 id 등. 경보 스코프가 된다 */
  scopeKey: string;
  /** `streak` 이면 연속 횟수, `duration` 이면 지속 밀리초 */
  value: number;
  threshold: number;
  mode: Mode;
}

interface Entry {
  /** streak 모드의 연속 횟수 */
  count: number;
  /** duration 모드에서 나쁜 상태가 시작된 시각(ms). 정상이면 undefined */
  since: number | undefined;
  /** 이 에피소드에서 이미 발화했는가 */
  alerted: boolean;
}

export interface StuckWatch {
  /**
   * 관측 1건을 넣는다.
   *
   * @param bad `true` 면 나쁜 상태(실패·고착), `false` 면 정상 → **카운터 리셋**
   * @returns 이번 관측으로 임계를 넘어 발화했으면 그 사실, 아니면 undefined
   */
  observe(domain: StuckDomain, scopeKey: string, bad: boolean, at: number): StuckAlert | undefined;
  /** 지표용 현재값. `streak` 은 횟수, `duration` 은 경과 밀리초 */
  value(domain: StuckDomain, scopeKey: string, at: number): number;
  /** 명시적 리셋 (예: 복구 성공) */
  reset(domain: StuckDomain, scopeKey: string): void;
  /** 지표 스냅샷 — `{domain, scopeKey, value}` 목록 */
  snapshot(at: number): readonly { domain: StuckDomain; scopeKey: string; value: number }[];
}

export interface StuckWatchOptions {
  specs: Readonly<Record<StuckDomain, DomainSpec>>;
}

/**
 * ★ 구분자는 NUL(`\u0000`) 이다. 도메인·채널 id 어디에도 나올 수 없는 바이트라
 *   `('a','b:c')` 와 `('a:b','c')` 가 같은 키가 되는 사고를 막는다
 *   (`ops-alert-service.ts` 가 같은 이유로 같은 선택을 했다).
 */
const SEP = '\u0000';

function key(domain: StuckDomain, scopeKey: string): string {
  return `${domain}${SEP}${scopeKey}`;
}

export function createStuckWatch(opts: StuckWatchOptions): StuckWatch {
  const entries = new Map<string, Entry>();
  const specs = opts.specs;

  function entryOf(k: string): Entry {
    let e = entries.get(k);
    if (e === undefined) {
      e = { count: 0, since: undefined, alerted: false };
      entries.set(k, e);
    }
    return e;
  }

  function currentValue(spec: DomainSpec, e: Entry, at: number): number {
    if (spec.mode === 'streak') return e.count;
    return e.since === undefined ? 0 : Math.max(0, at - e.since);
  }

  return {
    observe(domain, scopeKey, bad, at): StuckAlert | undefined {
      const spec = specs[domain];
      const k = key(domain, scopeKey);
      const e = entryOf(k);

      if (!bad) {
        // ★ 정상 관측 하나로 에피소드가 끝난다 — "중간에 1회라도 성공하면 리셋".
        e.count = 0;
        e.since = undefined;
        e.alerted = false;
        return undefined;
      }

      if (spec.mode === 'streak') {
        e.count += 1;
      } else if (e.since === undefined) {
        // ★ 나쁜 상태의 **시작 시각**을 잡는다. 관측 시각이 아니라 이 값이 기준이라
        //   폴링 주기가 불규칙해도 지속시간 판정이 흔들리지 않는다.
        e.since = at;
      }

      const value = currentValue(spec, e, at);
      // ★ `>=` 다. AC-P1 은 "5분 지속 → 경보, 4분 59초 → 무경보" 이므로 경계 포함이다.
      if (value < spec.threshold) return undefined;
      // ★ 에피소드당 1건. 넘긴 뒤에도 계속 세지만 다시 발화하지는 않는다.
      if (e.alerted) return undefined;
      e.alerted = true;
      // ★ 발화하지 않는 도메인도 **세기는 한다** — 지표는 남고 경보만 없다.
      if (!spec.armed) return undefined;

      return { domain, kind: spec.kind, scopeKey, value, threshold: spec.threshold, mode: spec.mode };
    },

    value(domain, scopeKey, at): number {
      const e = entries.get(key(domain, scopeKey));
      return e === undefined ? 0 : currentValue(specs[domain], e, at);
    },

    reset(domain, scopeKey): void {
      entries.delete(key(domain, scopeKey));
    },

    snapshot(at) {
      const out: { domain: StuckDomain; scopeKey: string; value: number }[] = [];
      for (const [k, e] of entries) {
        const sep = k.indexOf(SEP);
        const domain = k.slice(0, sep) as StuckDomain;
        out.push({ domain, scopeKey: k.slice(sep + 1), value: currentValue(specs[domain], e, at) });
      }
      return out;
    },
  };
}
