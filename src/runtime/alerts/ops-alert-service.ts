// 출처: chzzkbot src/runtime/alerts/alert-service.ts
//       — 디바운스 키를 (channelId, kind) 에서 **(scope, kind)** 로 일반화했다 (계획 §14).
import type { Clock } from '../clock.js';
import { DEBOUNCE_EXEMPT, SYSTEM_SCOPE, type AlertKind } from './types.js';
import type { Notifier, WebhookSendResult } from './discord-webhook.js';

/**
 * 운영 경보 서비스 — 디바운스 · 면제 · 격리.
 *
 * 세 가지를 한다:
 *   ① 같은 경보를 `minIntervalMin` 안에 반복 발송하지 않는다
 *   ② 면제 종류는 디바운스를 건너뛴다 (`DEBOUNCE_EXEMPT`)
 *   ③ 발송이 실패해도 **호출자에게 던지지 않는다** (계획 Principle 2)
 *
 * ★★ 디바운스 키는 `(scope, kind)` 다.
 *   chzzkbot 은 `(channelId, kind)` 였는데, 그 전에는 `kind` 만으로 키잉해서
 *   **채널 A 의 `rate_limited` 한 건이 나머지 29채널의 같은 경보를 30분간
 *   통째로 삼켰다.** 여기서는 경보의 주체가 치지직 채널만이 아니라
 *   유튜브 채널·길드·시스템 전역까지 섞이므로 `channelId` 로는 이름이 맞지 않는다.
 *   그래서 `scope` 로 일반화했다 — 같은 결함을 유튜브 채널 축에서 되풀이하지 않기 위해서다.
 *
 * ★ 서비스는 **스코프에 매여 있다.** `raise(kind, message)` 가 스코프를 다시 받지 않는
 *   이유: 호출부(폴러·감시자)는 이미 자기 스코프 안에서 돌고 있어 매번 넘기게 하면
 *   **넘기는 것을 잊은 곳만 조용히 잘못된 버킷에 쌓인다.**
 *   다른 스코프로 보내려면 `forScope()` 로 명시적으로 갈아탄다.
 *
 * ★ 디바운스 상태를 어디에 두는가.
 *   DB(`alert_state`)가 최종 진실이지만 이 모듈은 L1(runtime) 이라 store(L2) 를
 *   import 할 수 없다. 그래서 상태 읽기·쓰기를 **인터페이스로 주입받는다.**
 *   composition-root 가 DB 구현을 꽂고, 테스트는 메모리 구현을 꽂는다.
 *   eslint 의 레이어 규칙이 이 형태를 강제한다.
 */

/** 억제 판정에 필요한 최소 상태. `alert_state` 의 부분집합이다. */
export interface AlertStateStore {
  /** 마지막 발송 시각(ms epoch). 보낸 적이 없으면 undefined */
  lastSentAt(scope: string, kind: AlertKind): number | undefined;
  /** 발송에 성공했을 때만 부른다 */
  markSent(scope: string, kind: AlertKind, at: number): void;
  /** 억제된 횟수를 1 올리고 새 값을 돌려준다 */
  bumpSuppressed(scope: string, kind: AlertKind): number;
  /** 억제된 횟수를 **읽기만** 한다. 부작용이 없어야 한다 */
  suppressedCount(scope: string, kind: AlertKind): number;
  /** 발송 후 억제 카운터를 비운다 */
  clearSuppressed(scope: string, kind: AlertKind): void;
}

/**
 * 맵 키.
 *
 * ★ 구분자로 NUL 을 쓴다. `:` 이나 `-` 는 스코프 안에 들어갈 수 있어
 *   `("a:b", "c")` 와 `("a", "b:c")` 가 같은 키가 된다 — 다른 스코프의 경보가
 *   서로를 삼키는, 이 키잉이 고치려던 바로 그 결함의 재발이다.
 */
function key(scope: string, kind: AlertKind): string {
  return `${scope}\u0000${kind}`;
}

/** 프로세스 메모리 구현. 테스트용이자 DB 준비 전 기동 구간의 폴백이다. */
export function createMemoryAlertState(): AlertStateStore {
  const last = new Map<string, number>();
  const suppressed = new Map<string, number>();
  return {
    lastSentAt: (s, k) => last.get(key(s, k)),
    markSent: (s, k, at) => {
      last.set(key(s, k), at);
    },
    bumpSuppressed: (s, k) => {
      const n = (suppressed.get(key(s, k)) ?? 0) + 1;
      suppressed.set(key(s, k), n);
      return n;
    },
    suppressedCount: (s, k) => suppressed.get(key(s, k)) ?? 0,
    clearSuppressed: (s, k) => {
      suppressed.delete(key(s, k));
    },
  };
}

/**
 * 나중에 실구현으로 **갈아끼울 수 있는** 저장소.
 *
 * ★ 왜 필요한가: 경보 서비스는 설정 로드 직후에 만들어지는데 DB 는 그 뒤에 열린다.
 *   그 사이에도 경보가 나갈 수 있어야 하므로(중복 기동 차단·DB 오류) 서비스를
 *   DB 뒤로 미룰 수 없다.
 *
 * ★ 갈아끼울 때 **메모리에 쌓인 것을 옮기지 않는다.** 그 구간에서 경보를 내는
 *   경로는 곧바로 프로세스를 끝내는 것들뿐이다 — 옮길 상태가 없다. 옮기는 코드를
 *   두면 "실제로는 한 번도 안 도는 이관 로직"이 남는다.
 */
export interface SwappableAlertState extends AlertStateStore {
  swap(next: AlertStateStore): void;
}

export function createSwappableAlertState(
  initial: AlertStateStore = createMemoryAlertState(),
): SwappableAlertState {
  let target = initial;
  return {
    swap: (next) => {
      target = next;
    },
    lastSentAt: (s, k) => target.lastSentAt(s, k),
    markSent: (s, k, at) => {
      target.markSent(s, k, at);
    },
    bumpSuppressed: (s, k) => target.bumpSuppressed(s, k),
    suppressedCount: (s, k) => target.suppressedCount(s, k),
    clearSuppressed: (s, k) => {
      target.clearSuppressed(s, k);
    },
  };
}

export interface OpsAlertServiceOptions {
  notifier: Notifier;
  state: AlertStateStore;
  clock: Clock;
  /**
   * 이 서비스가 매인 스코프. 스코프가 없는 전역 경보는 `SYSTEM_SCOPE`.
   *
   * ★ 선택 인자로 두지 않는다. 기본값을 주면 스코프를 넘기는 것을 잊은 호출부가
   *   조용히 남의 버킷에 쌓이고, 그게 정확히 이 키잉이 고치려던 증상이다.
   */
  scope: string;
  /** 0 이면 디바운스를 끈다 */
  minIntervalMin: number;
  /** 발송 자체를 끈다 (설정 `alerts.enabled: false`) */
  enabled?: boolean;
  /** 진단 로그. 던지면 안 된다 */
  onEvent?: (e: AlertEvent) => void;
}

export type AlertOutcome =
  | 'sent'
  | 'suppressed' // 디바운스에 걸림
  | 'disabled' // 설정으로 꺼짐
  | 'skipped-no-url' // 웹훅 미설정
  | 'failed'; // 발송 시도했으나 실패

export interface AlertEvent {
  scope: string;
  kind: AlertKind;
  outcome: AlertOutcome;
  /** suppressed 일 때 지금까지 눌린 횟수 */
  suppressedCount?: number;
  reason?: string;
}

export interface OpsAlertService {
  /** 이 서비스가 매인 스코프 */
  readonly scope: string;
  /** 절대 reject 하지 않는다 */
  raise(kind: AlertKind, message: string): Promise<AlertOutcome>;
  /**
   * 같은 알리미·상태 저장소·설정을 공유하되 **다른 스코프에 매인** 서비스.
   *
   * 상태 저장소를 공유하는 것이 핵심이다. 스코프마다 저장소를 새로 만들면
   * DB 구현에서는 문제없지만 메모리 구현에서 디바운스가 스코프마다 리셋된다.
   */
  forScope(scope: string): OpsAlertService;
}

/**
 * 디스코드 메시지 앞머리 — **어느 스코프의 경보인지 사람이 먼저 본다.**
 *
 * 이게 없으면 채널 여러 개가 같은 웹훅으로 쏟아질 때 운영자가 본문을 읽어야만
 * 어느 쪽인지 안다.
 */
function headline(scope: string): string {
  return scope === SYSTEM_SCOPE ? '[시스템]' : `[${scope}]`;
}

export function createOpsAlertService(opts: OpsAlertServiceOptions): OpsAlertService {
  const { notifier, state, clock } = opts;
  const enabled = opts.enabled ?? true;
  const windowMs = Math.max(0, opts.minIntervalMin) * 60_000;

  const emit = (e: AlertEvent): void => {
    try {
      opts.onEvent?.(e);
    } catch {
      // 진단 로그가 경보를 죽이면 안 된다.
    }
  };

  async function raise(scope: string, kind: AlertKind, message: string): Promise<AlertOutcome> {
    if (!enabled) {
      emit({ scope, kind, outcome: 'disabled' });
      return 'disabled';
    }

    // ★ 면제 판정을 디바운스보다 **먼저** 한다.
    //   순서가 반대면 면제 대상이 창에 걸린 뒤에야 면제를 확인하게 되고,
    //   구현에 따라 조용히 눌린다.
    const exempt = DEBOUNCE_EXEMPT.includes(kind);
    const now = clock.now();

    if (!exempt && windowMs > 0) {
      const last = state.lastSentAt(scope, kind);
      if (last !== undefined && now - last < windowMs) {
        const n = state.bumpSuppressed(scope, kind);
        emit({ scope, kind, outcome: 'suppressed', suppressedCount: n });
        return 'suppressed';
      }
    }

    // 억제된 동안 몇 건이 눌렸는지 함께 알린다 — 없으면 운영자가
    // "한 번 났나 보다" 로 오해한다. 읽기에 부작용을 쓰지 않는다.
    const pending = state.suppressedCount(scope, kind);
    state.clearSuppressed(scope, kind);
    const suffix = pending > 0 ? `\n(억제된 동일 경보 ${String(pending)}건)` : '';

    let result: WebhookSendResult;
    try {
      result = await notifier.send(`${headline(scope)} ${message}${suffix}`);
    } catch (e: unknown) {
      // Notifier 는 던지지 않기로 돼 있지만, 계약을 신뢰하지 않는다 —
      // 여기서 새면 경보 한 번에 봇이 죽는다 (Principle 2).
      emit({
        scope,
        kind,
        outcome: 'failed',
        reason: e instanceof Error ? e.message : String(e),
      });
      return 'failed';
    }

    if (result === 'sent') {
      state.markSent(scope, kind, now);
      emit({ scope, kind, outcome: 'sent' });
      return 'sent';
    }
    if (result === 'skipped-no-url') {
      emit({ scope, kind, outcome: 'skipped-no-url' });
      return 'skipped-no-url';
    }
    // 실패는 markSent 하지 않는다 — 그래야 다음 시도가 디바운스에 막히지 않는다.
    emit({ scope, kind, outcome: 'failed' });
    return 'failed';
  }

  function bind(scope: string): OpsAlertService {
    return {
      scope,
      raise: (kind, message) => raise(scope, kind, message),
      forScope: bind,
    };
  }

  return bind(opts.scope);
}
