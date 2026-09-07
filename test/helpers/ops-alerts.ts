import type { OpsAlertService } from '../../src/runtime/alerts/ops-alert-service.js';
import type { AlertKind } from '../../src/runtime/alerts/types.js';

/**
 * 운영 경보 수집기 — "경보가 정확히 몇 건 났는가" 를 세는 것이 §S5 수용 기준의 절반이다.
 *
 * ★ 실제 `OpsAlertService` 를 쓰지 않는 이유: 저쪽은 디바운스(30분)를 갖고 있어
 *   "5회 연속 → 1건" 과 "임계를 넘어 도배" 를 구분할 수 없게 만든다. 여기서
 *   확인하려는 것은 **감시 모듈이 에피소드당 1건만 낸다** 는 사실이므로
 *   디바운스가 없는 수집기로 세야 판정이 성립한다.
 */
export interface RaisedAlert {
  kind: AlertKind;
  message: string;
  scope: string;
}

export interface FakeOpsAlerts {
  service: OpsAlertService;
  readonly raised: readonly RaisedAlert[];
  countOf(kind: AlertKind): number;
  reset(): void;
}

export function createFakeOpsAlerts(scope = 'test-scope'): FakeOpsAlerts {
  const raised: RaisedAlert[] = [];

  const make = (s: string): OpsAlertService => ({
    scope: s,
    raise: (kind, message) => {
      raised.push({ kind, message, scope: s });
      return Promise.resolve('sent');
    },
    forScope: (next) => make(next),
  });

  return {
    service: make(scope),
    get raised() {
      return raised;
    },
    countOf: (kind) => raised.filter((r) => r.kind === kind).length,
    reset: () => {
      raised.length = 0;
    },
  };
}
