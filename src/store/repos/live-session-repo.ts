import type { Db } from '../db.js';

/**
 * `live_sessions` 저장소 — `LiveSessionStore` 포트의 DB 구현 (계획 §8 · AC-16 · AC-31).
 *
 * ★★ **포트 타입(`src/live/live-announce.ts` 의 `LiveSessionStore`)을 import 하지
 *   않는다.** `live` 는 L4 이고 `store` 는 L2 라 그 방향은 레이어 규칙이 막는다
 *   (`eslint.config.js`). 그래서 여기서는 같은 모양을 **구조적으로** 선언하고,
 *   두 타입이 갈리는 것은 조립부(`src/main.ts`)가 잡는다 —
 *   `const store: LiveSessionStore = createLiveSessionRepo(db)` 한 줄이
 *   typecheck 에서 깨진다. `live-announce.ts` 가 `LiveEmbedFields` 를
 *   `EmbedSpec` 과 같게 두는 것과 같은 규율이다.
 *
 * ★ `open_date` 와 `opened_at` 을 **둘 다** 넣는다 (§8 스키마 주석).
 *   `open_date` 는 계약 원문(KST 표기)이라 **신원·비교** 전용이고,
 *   `opened_at` 은 UTC 라 **시각 계산** 전용이다. 하나로 접으면 둘 중 하나가
 *   파생값이 되고, 파생 규칙이 틀린 날 지연이 9시간 어긋난다.
 *
 * ★ `record` 는 UPSERT 다. 같은 `liveHash` 를 웹훅과 폴링이 각각 볼 수 있고
 *   (원장이 공지 중복을 막을 뿐 세션 기록은 양쪽에서 온다), 그때 두 번째가
 *   예외가 되면 **공지 경로가 세션 기록 실패로 흔들린다.**
 *   ★ `first_seen_at` 은 **갱신하지 않는다** — "우리가 처음 본 시각" 이 나중 관측으로
 *   덮이면 그 컬럼의 뜻이 사라진다.
 *
 * ★ `closeOpen` 이 채널을 받지 않는 이유: `live_sessions` 에 `channel_id` 컬럼이
 *   없다. 대상 채널이 단수(`live.channelId`)라 "열려 있는 세션"과 "그 채널의
 *   열려 있는 세션"이 같다. 다채널은 Non-Goal 이다.
 */

/** `src/live/live-announce.ts` 의 `LiveSessionRecord` 와 구조적으로 같다 (위 머리말) */
export interface LiveSessionInput {
  liveHash: string;
  openDate: string;
  openedAt: string;
  liveTitle?: string | undefined;
  liveId?: string | undefined;
  categoryValue?: string | undefined;
  status: string;
}

export interface LiveSessionRow extends LiveSessionInput {
  firstSeenAt: string;
  closedAt?: string | undefined;
}

export interface LiveSessionRepo {
  /** 신원이 확정된 세션을 기록한다 (이미 있으면 갱신) */
  record(session: LiveSessionInput, at: string): void;
  /** 아직 닫히지 않은 세션을 닫는다. 닫은 행 수를 돌려준다 */
  closeOpen(at: string): number;
  /**
   * 단건 조회.
   *
   * ★ 아웃박스 재발송이 이 값을 쓴다. 원장 행에는 `event_key`(= `liveHash`)만 있어
   *   임베드를 다시 만들 수 없는데, 여기 `opened_at`·`live_title` 이 남아 있으면
   *   재기동 뒤에도 같은 모양으로 다시 보낼 수 있다.
   */
  get(liveHash: string): LiveSessionRow | undefined;
  /** 진단·테스트용 */
  listOpen(): LiveSessionRow[];
}

interface Row {
  live_hash: string;
  open_date: string;
  opened_at: string;
  live_title: string | null;
  live_id: string | null;
  category_value: string | null;
  status: string;
  first_seen_at: string;
  closed_at: string | null;
}

const COLUMNS =
  'live_hash, open_date, opened_at, live_title, live_id, category_value, status, first_seen_at, closed_at';

/**
 * 닫힌 세션의 `status`.
 *
 * ★ `live_sessions.status` 에는 CHECK 가 없다(§8). 그래서 값을 여기 한 곳에서만
 *   정하고, 쓰는 쪽은 이 상수를 본다 — 문자열을 두 곳에 적으면 한쪽만 고친 날
 *   "닫힌 세션"을 세는 질의가 조용히 0을 돌려준다.
 */
export const CLOSED_STATUS = 'ended';

function toRow(r: Row): LiveSessionRow {
  return {
    liveHash: r.live_hash,
    openDate: r.open_date,
    openedAt: r.opened_at,
    ...(r.live_title === null ? {} : { liveTitle: r.live_title }),
    ...(r.live_id === null ? {} : { liveId: r.live_id }),
    ...(r.category_value === null ? {} : { categoryValue: r.category_value }),
    status: r.status,
    firstSeenAt: r.first_seen_at,
    ...(r.closed_at === null ? {} : { closedAt: r.closed_at }),
  };
}

export function createLiveSessionRepo(db: Db): LiveSessionRepo {
  const upsert = db.prepare<
    {
      hash: string;
      openDate: string;
      openedAt: string;
      title: string | null;
      liveId: string | null;
      category: string | null;
      status: string;
      at: string;
    },
    never
  >(`
    INSERT INTO live_sessions
      (live_hash, open_date, opened_at, live_title, live_id, category_value, status, first_seen_at)
    VALUES
      (@hash, @openDate, @openedAt, @title, @liveId, @category, @status, @at)
    ON CONFLICT (live_hash) DO UPDATE SET
      open_date      = excluded.open_date,
      opened_at      = excluded.opened_at,
      -- ★ COALESCE — 폴링 응답에는 liveTitle 칸이 아예 없다. 덮어쓰면 웹훅이 실어 준
      --   제목이 다음 폴에서 NULL 로 지워진다.
      live_title     = COALESCE(excluded.live_title, live_sessions.live_title),
      live_id        = COALESCE(excluded.live_id, live_sessions.live_id),
      category_value = COALESCE(excluded.category_value, live_sessions.category_value),
      status         = excluded.status
      -- ★ first_seen_at 은 여기 없다 (위 머리말)
  `);

  const closeAllOpen = db.prepare<{ at: string; status: string }, never>(
    'UPDATE live_sessions SET status = @status, closed_at = @at WHERE closed_at IS NULL',
  );

  const selectOne = db.prepare<{ hash: string }, Row>(
    `SELECT ${COLUMNS} FROM live_sessions WHERE live_hash = @hash`,
  );

  const selectOpen = db.prepare<[], Row>(
    `SELECT ${COLUMNS} FROM live_sessions WHERE closed_at IS NULL ORDER BY first_seen_at ASC`,
  );

  return {
    record(session, at): void {
      upsert.run({
        hash: session.liveHash,
        openDate: session.openDate,
        openedAt: session.openedAt,
        title: session.liveTitle ?? null,
        liveId: session.liveId ?? null,
        category: session.categoryValue ?? null,
        status: session.status,
        at,
      });
    },

    closeOpen(at): number {
      // ★ `status` 도 이름 있는 파라미터로 넘긴다. better-sqlite3 는 이름 있는
      //   파라미터와 위치 파라미터를 **섞으면 거부한다.**
      return closeAllOpen.run({ status: CLOSED_STATUS, at }).changes;
    },

    get(liveHash): LiveSessionRow | undefined {
      const r = selectOne.get({ hash: liveHash });
      return r === undefined ? undefined : toRow(r);
    },

    listOpen(): LiveSessionRow[] {
      return selectOpen.all().map(toRow);
    },
  };
}
