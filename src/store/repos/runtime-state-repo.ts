import type { RuntimeStateStore } from '../../runtime/liveness-stamp.js';
import type { Db } from '../db.js';

/**
 * `runtime_state` 저장소 — `RuntimeStateStore` 포트의 DB 구현 (계획 §8 · AC-29/30).
 *
 * ★ **포트 타입을 여기서 import 해 반환형에 박는다.** 손으로 같은 모양을 다시
 *   적으면 포트가 바뀐 날 조립부에서야 깨지고, 하필 그 자리가 "다운타임을
 *   재려던 순간"이다. `runtime`(L1)은 `store`(L2)보다 아래라 이 방향의
 *   import 는 레이어 규칙이 허용한다.
 *
 * ★ 키를 CHECK 로 고정하지 않은 것은 스키마의 선택이다(§8 주석 — "여기는 어휘가
 *   자랄 자리"). 대신 키 이름 상수는 쓰는 쪽(`liveness-stamp.ts` 의 `LAST_SEEN_KEY`)이
 *   소유하고, 이 저장소는 문자열을 그대로 받는다.
 *
 * ★ `set` 은 UPSERT 다. `INSERT … ON CONFLICT DO UPDATE` 한 문장이라 "있으면 갱신,
 *   없으면 삽입"이 조건문이 아니라 제약으로 판정된다.
 */

export interface RuntimeStateRow {
  key: string;
  value: string;
  updatedAt: string;
}

export interface RuntimeStateRepo extends RuntimeStateStore {
  /** 진단·테스트용 전량 조회 */
  list(): RuntimeStateRow[];
}

interface Row {
  key: string;
  value: string;
  updated_at: string;
}

export function createRuntimeStateRepo(db: Db): RuntimeStateRepo {
  const selectOne = db.prepare<{ key: string }, Row>(
    'SELECT key, value, updated_at FROM runtime_state WHERE key = @key',
  );
  const selectAll = db.prepare<[], Row>(
    'SELECT key, value, updated_at FROM runtime_state ORDER BY key ASC',
  );
  const upsert = db.prepare<{ key: string; value: string; at: string }, never>(`
    INSERT INTO runtime_state (key, value, updated_at)
    VALUES (@key, @value, @at)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);

  return {
    get(key): string | undefined {
      return selectOne.get({ key })?.value;
    },

    set(key, value, at): void {
      upsert.run({ key, value, at });
    },

    list(): RuntimeStateRow[] {
      return selectAll
        .all()
        .map((r) => ({ key: r.key, value: r.value, updatedAt: r.updated_at }));
    },
  };
}
