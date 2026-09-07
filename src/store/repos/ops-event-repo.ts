import type { Db } from '../db.js';

/**
 * `ops_events` 저장소 — `OpsEventRecorder` 포트의 DB 구현 (계획 §8 · AC-8 · AC-14 · AC-30).
 *
 * ★ 경보(`alert_state`)와 다르다. 경보는 **사람을 부르는 것**이고 여기는
 *   **나중에 읽는 것**이다. 계약 위반 페이로드 · 다운타임 구간 · 복구 실패가 여기 남는다.
 *
 * ★★ **던지지 않는다.** `web/routes/chzzkbot-webhook.ts` 의 포트 주석이 그렇게
 *   못 박았고, 이유도 거기 있다 — *"기록이 수신을 죽이면 안 된다"*.
 *   디스크가 가득 찼을 때 운영 기록 한 줄 때문에 웹훅 수신이 5xx 가 되면
 *   그 방송이 영영 사라진다 (§3-a 2위). 실패는 `onError` 로만 새어 나간다.
 *
 * ★ `kind` 를 `string` 으로 받는다. 부르는 쪽이 자기 어휘를 좁은 유니온으로
 *   갖고 있고(`LIVE_WEBHOOK_OPS_KINDS`), 넓은 파라미터는 좁은 포트 타입에
 *   그대로 대입된다. 반대로 여기서 좁히면 복구(§S7)·연동(AC-8)이 쓰는 다른
 *   어휘를 이 파일이 전부 알아야 한다.
 */

export interface OpsEventRow {
  id: number;
  kind: string;
  detail: string | undefined;
  at: string;
}

export interface OpsEventRepo {
  /** `ops_events` 한 줄. **절대 던지지 않는다** */
  record(kind: string, detail: string, at: string): void;
  /** 진단·테스트용. `kind` 를 주면 그 종류만 */
  list(kind?: string): OpsEventRow[];
  count(kind?: string): number;
}

/**
 * `detail` 상한.
 *
 * ★ 자르는 이유는 원장 `markFailed` 와 같다 — 상류가 HTML 오류 페이지를 통째로
 *   돌려주는 일이 있고, 그걸 그대로 넣으면 한 행이 수십 KB 가 된다.
 */
export const MAX_OPS_DETAIL = 1_000;

interface Row {
  id: number;
  kind: string;
  detail: string | null;
  at: string;
}

export interface OpsEventRepoOptions {
  /** 기록 실패를 알린다. **던지면 안 된다** */
  onError?: (detail: string) => void;
}

export function createOpsEventRepo(db: Db, opts: OpsEventRepoOptions = {}): OpsEventRepo {
  const insert = db.prepare<{ kind: string; detail: string; at: string }, never>(
    'INSERT INTO ops_events (kind, detail, at) VALUES (@kind, @detail, @at)',
  );
  const selectAll = db.prepare<{ kind: string | null }, Row>(
    'SELECT id, kind, detail, at FROM ops_events WHERE @kind IS NULL OR kind = @kind ORDER BY id ASC',
  );
  const countAll = db.prepare<{ kind: string | null }, { n: number }>(
    'SELECT COUNT(*) AS n FROM ops_events WHERE @kind IS NULL OR kind = @kind',
  );

  return {
    record(kind, detail, at): void {
      try {
        insert.run({ kind, detail: detail.slice(0, MAX_OPS_DETAIL), at });
      } catch (e: unknown) {
        // ★ 삼킨다 (위 머리말). 기록 실패가 판정을 바꾸지 않는다.
        try {
          opts.onError?.(e instanceof Error ? e.message : String(e));
        } catch {
          /* 진단 콜백이 던지는 것까지 여기서 막는다 */
        }
      }
    },

    list(kind): OpsEventRow[] {
      return selectAll.all({ kind: kind ?? null }).map((r) => ({
        id: r.id,
        kind: r.kind,
        detail: r.detail ?? undefined,
        at: r.at,
      }));
    },

    count(kind): number {
      return countAll.get({ kind: kind ?? null })?.n ?? 0;
    },
  };
}
