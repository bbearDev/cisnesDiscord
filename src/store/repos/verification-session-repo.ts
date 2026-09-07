// 출처: chzzkbot src/web/session.ts 의 대기열 규율(1회 소모 · 오래된 것부터 폐기)을
//       옮기되, 상류가 **메모리**에 두던 것을 §8 스키마의 `verification_sessions` 로 옮겼다.
import type { Db } from '../db.js';

/**
 * 인증 세션 저장소 — `verification_sessions` (계획 §8 · AC-3 · AC-12).
 *
 * ★ **정책은 여기 없다.** TTL 판정 · nonce 해싱 · 상수 시간 비교 · `MAX_PENDING`
 *   경보는 전부 `src/web/session.ts` 가 소유한다. 이 파일은 SQL 만 안다 —
 *   그래야 정책을 메모리 구현으로 그대로 테스트할 수 있다.
 *
 * ★ **`nonce_hash` 만 저장한다** (§8 주석). DB 가 유출돼도 진행 중인 흐름을
 *   재현할 수 없어야 한다. 원문 nonce 는 브라우저 쿠키에만 있다.
 *
 * ★ `result` 가 **소모 표식을 겸한다.** `NULL` 이면 아직 안 쓴 state 다.
 *   전용 컬럼을 만들지 않는 이유: §8 스키마를 고치지 않고도 "1회 소모" 를
 *   `UPDATE … WHERE result IS NULL` 한 문장의 `changes === 1` 로 원자적으로
 *   판정할 수 있다 — 조회 후 갱신으로 나누면 두 콜백이 같은 state 를 통과한다.
 */

export interface VerificationSessionRow {
  state: string;
  discordUserId: string;
  nonceHash: string;
  /** ISO-8601 UTC */
  createdAt: string;
  expiresAt: string;
  /** `undefined` = 아직 소모되지 않음 */
  result: string | undefined;
  /** ★ 3상태다. `undefined` 가 `unknown` — **0(미팔로우)으로 접지 않는다** */
  isFollower: boolean | undefined;
}

export interface VerificationSessionRepo {
  insert(row: VerificationSessionRow): void;
  get(state: string): VerificationSessionRow | undefined;
  /** 아직 소모되지 않고 만료도 안 된 이 사용자의 흐름 (AC-12 b). 가장 최근 1건 */
  findPending(discordUserId: string, nowIso: string): VerificationSessionRow | undefined;
  /** `/oauth/start` 가 브라우저 쿠키를 심을 때 해시를 회전시킨다 */
  updateNonceHash(state: string, nonceHash: string): boolean;
  /** ★ 원자적 1회 소모. 이미 쓰였으면 `false` */
  consume(state: string, marker: string): boolean;
  /** 소모된 흐름의 최종 결과를 남긴다 */
  finish(state: string, result: string, isFollower: boolean | undefined): void;
  /** 만료된 행을 지운다. 지운 수를 준다 */
  pruneExpired(nowIso: string): number;
  /** 만료되지 않은 **미소모** 대기 수 (§5.6.2 `MAX_PENDING` 판정 축) */
  pendingCount(nowIso: string): number;
  /** 상한을 넘겼을 때 **가장 오래된 대기부터** 버린다. 지운 수를 준다 */
  dropOldestPending(nowIso: string, count: number): number;
}

interface Row {
  state: string;
  discord_user_id: string;
  nonce_hash: string;
  created_at: string;
  expires_at: string;
  result: string | null;
  is_follower: number | null;
}

const COLUMNS = 'state, discord_user_id, nonce_hash, created_at, expires_at, result, is_follower';

function toRow(r: Row): VerificationSessionRow {
  return {
    state: r.state,
    discordUserId: r.discord_user_id,
    nonceHash: r.nonce_hash,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    result: r.result ?? undefined,
    isFollower: r.is_follower === null ? undefined : r.is_follower === 1,
  };
}

export function createVerificationSessionRepo(db: Db): VerificationSessionRepo {
  const insert = db.prepare<
    { state: string; user: string; hash: string; created: string; expires: string },
    never
  >(`
    INSERT INTO verification_sessions (state, discord_user_id, nonce_hash, created_at, expires_at)
    VALUES (@state, @user, @hash, @created, @expires)
  `);
  const selectOne = db.prepare<{ state: string }, Row>(
    `SELECT ${COLUMNS} FROM verification_sessions WHERE state = @state`,
  );
  // ★ `created_at DESC` — 같은 사용자에게 대기가 둘 이상 남는 것은 정상이 아니지만
  //   (진입 리밋이 막는다), 남았다면 **가장 최근 것**을 재제시하는 편이 사용자가
  //   방금 받은 URL 과 일치한다.
  const selectPendingByUser = db.prepare<{ user: string; now: string }, Row>(`
    SELECT ${COLUMNS} FROM verification_sessions
     WHERE discord_user_id = @user AND result IS NULL AND expires_at > @now
     ORDER BY created_at DESC
     LIMIT 1
  `);
  const updateNonce = db.prepare<{ state: string; hash: string }, never>(
    'UPDATE verification_sessions SET nonce_hash = @hash WHERE state = @state AND result IS NULL',
  );
  const consumeOne = db.prepare<{ state: string; marker: string }, never>(
    'UPDATE verification_sessions SET result = @marker WHERE state = @state AND result IS NULL',
  );
  const finishOne = db.prepare<
    { state: string; result: string; follower: number | null },
    never
  >('UPDATE verification_sessions SET result = @result, is_follower = @follower WHERE state = @state');
  const prune = db.prepare<{ now: string }, never>(
    'DELETE FROM verification_sessions WHERE expires_at <= @now',
  );
  const countPending = db.prepare<{ now: string }, { n: number }>(
    'SELECT COUNT(*) AS n FROM verification_sessions WHERE result IS NULL AND expires_at > @now',
  );
  const dropOldest = db.prepare<{ now: string; lim: number }, never>(`
    DELETE FROM verification_sessions
     WHERE state IN (
       SELECT state FROM verification_sessions
        WHERE result IS NULL AND expires_at > @now
        ORDER BY created_at ASC, state ASC
        LIMIT @lim
     )
  `);

  return {
    insert(row): void {
      insert.run({
        state: row.state,
        user: row.discordUserId,
        hash: row.nonceHash,
        created: row.createdAt,
        expires: row.expiresAt,
      });
    },

    get(state): VerificationSessionRow | undefined {
      const r = selectOne.get({ state });
      return r === undefined ? undefined : toRow(r);
    },

    findPending(discordUserId, nowIso): VerificationSessionRow | undefined {
      const r = selectPendingByUser.get({ user: discordUserId, now: nowIso });
      return r === undefined ? undefined : toRow(r);
    },

    updateNonceHash(state, nonceHash): boolean {
      return updateNonce.run({ state, hash: nonceHash }).changes === 1;
    },

    consume(state, marker): boolean {
      return consumeOne.run({ state, marker }).changes === 1;
    },

    finish(state, result, isFollower): void {
      finishOne.run({
        state,
        result,
        follower: isFollower === undefined ? null : isFollower ? 1 : 0,
      });
    },

    pruneExpired(nowIso): number {
      return prune.run({ now: nowIso }).changes;
    },

    pendingCount(nowIso): number {
      return countPending.get({ now: nowIso })?.n ?? 0;
    },

    dropOldestPending(nowIso, count): number {
      if (count <= 0) return 0;
      return dropOldest.run({ now: nowIso, lim: count }).changes;
    },
  };
}

/**
 * 메모리 구현 — 단위 테스트가 정책만 검증할 때 쓴다.
 *
 * ★ SQL 구현과 **같은 파일에 둔다.** 인터페이스가 늘었을 때 둘 중 하나만 고치면
 *   그 자리에서 컴파일이 깨지도록.
 */
export function createMemoryVerificationSessionRepo(): VerificationSessionRepo {
  /** ★ Map 은 삽입 순서를 지킨다 — 오래된 것부터 버릴 때 그 순서가 곧 나이다 */
  const rows = new Map<string, VerificationSessionRow>();

  const pending = (nowIso: string): VerificationSessionRow[] =>
    [...rows.values()].filter((r) => r.result === undefined && r.expiresAt > nowIso);

  return {
    insert(row): void {
      if (rows.has(row.state)) throw new Error(`state 중복: ${row.state}`);
      rows.set(row.state, { ...row });
    },
    get: (state) => {
      const r = rows.get(state);
      return r === undefined ? undefined : { ...r };
    },
    findPending(discordUserId, nowIso) {
      const found = pending(nowIso)
        .filter((r) => r.discordUserId === discordUserId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))[0];
      return found === undefined ? undefined : { ...found };
    },
    updateNonceHash(state, nonceHash): boolean {
      const r = rows.get(state);
      if (r === undefined || r.result !== undefined) return false;
      r.nonceHash = nonceHash;
      return true;
    },
    consume(state, marker): boolean {
      const r = rows.get(state);
      if (r === undefined || r.result !== undefined) return false;
      r.result = marker;
      return true;
    },
    finish(state, result, isFollower): void {
      const r = rows.get(state);
      if (r === undefined) return;
      r.result = result;
      r.isFollower = isFollower;
    },
    pruneExpired(nowIso): number {
      let n = 0;
      for (const [k, v] of rows) {
        if (v.expiresAt <= nowIso) {
          rows.delete(k);
          n += 1;
        }
      }
      return n;
    },
    pendingCount: (nowIso) => pending(nowIso).length,
    dropOldestPending(nowIso, count): number {
      if (count <= 0) return 0;
      const victims = pending(nowIso)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
        .slice(0, count);
      for (const v of victims) rows.delete(v.state);
      return victims.length;
    },
  };
}
