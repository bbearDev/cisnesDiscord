import type { AlertStateStore } from '../../runtime/alerts/ops-alert-service.js';
import type { AlertKind } from '../../runtime/alerts/types.js';
import type { Db } from '../db.js';

/**
 * `alert_state` 저장소 — `AlertStateStore` 포트의 DB 구현 (계획 §8 · AC-19).
 *
 * ★ **디바운스 상태가 재기동을 넘어 살아남는 것**이 이 파일의 존재 이유다.
 *   메모리 구현(`createMemoryAlertState`)만 쓰면 프로세스가 재시작할 때마다
 *   30분 창이 리셋되고, 하필 재시작을 반복하는 장애(= 경보가 가장 많이 나는 상황)에서
 *   같은 경보가 매 기동마다 다시 나간다.
 *
 * ★★ `alert_kind` 에는 CHECK 가 걸려 있다. 목록이 `ALERT_KINDS` 와 한 글자라도
 *   다르면 INSERT 가 실패하는데, **하필 그 실패가 경보를 보내려던 순간**이라
 *   아무도 모르게 경보가 사라진다(§8 주석). 그래서 파라미터 타입을 `AlertKind` 로
 *   박아 오타가 컴파일에서 걸리게 하고, 두 목록의 일치는 통합 테스트가 대조한다.
 *
 * ★ 시각은 `TEXT` ISO-8601 인데 포트는 epoch ms 를 주고받는다. 변환을 여기서만
 *   한다 — 호출부가 문자열을 만들게 하면 포맷이 두 곳에 생기고, 문자열 정렬이
 *   곧 시간 정렬이라는 §8 의 전제가 그 순간 깨진다.
 *
 * ★ 파싱 불가한 `last_sent_at` 은 `undefined` 다. 0(에포크)으로 접으면
 *   "보낸 적 없다"와 "1970년에 보냈다"가 같아지는데, 후자는 항상 창 밖이라
 *   결과적으로 같은 판정이 되지만 **의미가 다른 두 상태를 같은 값으로 만드는 것**은
 *   나중에 이 컬럼을 읽는 사람을 속인다 (Principle 3).
 */

export interface AlertStateRow {
  scope: string;
  alertKind: AlertKind;
  lastSentAt: string | undefined;
  suppressedCount: number;
}

export interface AlertStateRepo extends AlertStateStore {
  /** 진단·테스트용 */
  list(): AlertStateRow[];
}

interface Row {
  scope: string;
  alert_kind: string;
  last_sent_at: string | null;
  suppressed_count: number;
}

export function createAlertStateRepo(db: Db): AlertStateRepo {
  const selectOne = db.prepare<{ scope: string; kind: string }, Row>(`
    SELECT scope, alert_kind, last_sent_at, suppressed_count
      FROM alert_state
     WHERE scope = @scope AND alert_kind = @kind
  `);

  const selectAll = db.prepare<[], Row>(`
    SELECT scope, alert_kind, last_sent_at, suppressed_count
      FROM alert_state
     ORDER BY scope ASC, alert_kind ASC
  `);

  const sentStmt = db.prepare<{ scope: string; kind: string; at: string }, never>(`
    INSERT INTO alert_state (scope, alert_kind, last_sent_at, suppressed_count)
    VALUES (@scope, @kind, @at, 0)
    ON CONFLICT (scope, alert_kind) DO UPDATE SET last_sent_at = excluded.last_sent_at
  `);

  // ★ RETURNING 으로 올라간 값을 한 번에 받는다. UPDATE 뒤에 다시 SELECT 하면
  //   그 사이에 다른 경로가 끼어들 수 있다 (원장 `markFailed` 와 같은 규율).
  const bumpStmt = db.prepare<{ scope: string; kind: string }, { suppressed_count: number }>(`
    INSERT INTO alert_state (scope, alert_kind, suppressed_count)
    VALUES (@scope, @kind, 1)
    ON CONFLICT (scope, alert_kind)
      DO UPDATE SET suppressed_count = alert_state.suppressed_count + 1
    RETURNING suppressed_count
  `);

  const clearStmt = db.prepare<{ scope: string; kind: string }, never>(`
    UPDATE alert_state SET suppressed_count = 0 WHERE scope = @scope AND alert_kind = @kind
  `);

  const toMs = (raw: string | null): number | undefined => {
    if (raw === null || raw === '') return undefined;
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? undefined : ms;
  };

  return {
    lastSentAt(scope, kind): number | undefined {
      const r = selectOne.get({ scope, kind });
      return r === undefined ? undefined : toMs(r.last_sent_at);
    },

    markSent(scope, kind, at): void {
      sentStmt.run({ scope, kind, at: new Date(at).toISOString() });
    },

    bumpSuppressed(scope, kind): number {
      return bumpStmt.get({ scope, kind })?.suppressed_count ?? 0;
    },

    suppressedCount(scope, kind): number {
      return selectOne.get({ scope, kind })?.suppressed_count ?? 0;
    },

    clearSuppressed(scope, kind): void {
      clearStmt.run({ scope, kind });
    },

    list(): AlertStateRow[] {
      return selectAll.all().map((r) => ({
        scope: r.scope,
        alertKind: r.alert_kind as AlertKind,
        lastSentAt: r.last_sent_at ?? undefined,
        suppressedCount: r.suppressed_count,
      }));
    },
  };
}
