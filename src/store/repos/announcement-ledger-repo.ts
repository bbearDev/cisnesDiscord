// 출처: chzzkbot src/store/repos/live-event-repo.ts · processed-repo.ts
//       (claim/markDelivered/markFailed/pending 의 모양과 규율을 그대로 옮겼다 — 계획 §14)
import type { Db } from '../db.js';
import { withFullSync } from '../db.js';

/**
 * ★★ 공지 원장 — **중복 0 / 누락 0 의 단일 진실원** (계획 Principle 1).
 *
 * 이 저장소가 답하는 질문은 하나다: **"이 공지, 내가 보내야 하나?"**
 *
 * 웹훅 · API 폴링 · 복구 · 아웃박스, **네 인입이 전부 이 문 하나를 지난다.**
 * 중복 방지는 조건문이 아니라 `PRIMARY KEY (kind, event_key)` 다 —
 * `INSERT … ON CONFLICT DO NOTHING` 의 `changes === 1` 인 쪽만 발송한다.
 *
 * ★ 발송 **성공**까지 이 저장소가 책임지지 않는다. 여기서 하는 것은 "누가 보낼
 *   것인가" 를 한 명으로 정하는 일(claim)과 그 결과를 남기는 일뿐이다. 실제 발송은
 *   `discord/announcer.ts` 가 한다 — 저장소가 네트워크를 알면 테스트가 네트워크를 안다.
 *
 * ★ **발송 실패에 행을 지우지 않는다** (계획 §5.3). 재시도는 아웃박스가 담당하고,
 *   지우면 재시도와 폴백이 동시에 재선점해 **중복이 난다.**
 */

/**
 * 공지 종류 — DB `CHECK (kind IN (...))` 와 **한 글자도 다르면 안 된다.**
 *
 * 다르면 INSERT 가 CHECK 위반으로 실패하는데, 하필 그 실패가 "공지를 선점하려던
 * 순간" 이라 **아무도 모르게 공지가 사라진다.** `ALERT_KINDS` 가 겪은 것과 같은
 * 사고이고(계획 §8), 통합 테스트가 두 목록을 대조한다.
 */
export const ANNOUNCEMENT_KINDS = ['live_start', 'youtube_upload'] as const;
export type AnnouncementKind = (typeof ANNOUNCEMENT_KINDS)[number];

/**
 * 감지 경로 — DB `CHECK (detected_via IN (...))` 와 대조 대상이다.
 *
 * 지표 `live_detected_via` / `youtube_detected_via` 의 라벨이 곧 이 값이다 (§9.4).
 * `api-poll` 비율이 오르면 웹훅이 고장 중이라는 뜻이라, 이 값은 진단의 축이다.
 */
export const DETECTED_VIA = ['webhook', 'api-poll', 'websub', 'rss', 'recovery', 'seed'] as const;
export type DetectedVia = (typeof DETECTED_VIA)[number];

/** 아직 못 보낸 공지 — `announced_at IS NULL` 인 행 */
export interface PendingAnnouncement {
  kind: AnnouncementKind;
  eventKey: string;
  detectedVia: DetectedVia;
  claimedAt: string;
  /** 지금까지 **실패한** 횟수. 성공은 세지 않는다 */
  attempts: number;
  lastError?: string | undefined;
}

/** 진단·테스트용 원장 한 행 */
export interface LedgerRow extends PendingAnnouncement {
  /** 종결 시각. **발송했든 보내지 않기로 했든** 채워진다 (`markSuppressed` 주석 참조) */
  announcedAt?: string | undefined;
  /** ★ 이 값의 유무가 "발송함" 과 "보내지 않고 종결함" 을 가른다 */
  messageId?: string | undefined;
  seeded: boolean;
}

/**
 * 보내지 않고 종결된 행인가.
 *
 * ★ 이 판정을 호출부마다 손으로 적으면(`announcedAt != null && messageId == null`)
 *   한 곳이라도 틀리는 날 억제된 건이 "발송됨" 으로 집계된다. 규칙을 한 군데 둔다.
 */
export function isSuppressed(row: LedgerRow): boolean {
  return row.announcedAt !== undefined && row.messageId === undefined;
}

export interface ClaimOptions {
  /**
   * AC-26 최초 기동 시딩 표식. **유튜브 경로에서만 선다** —
   * 스키마 `CHECK (seeded = 0 OR kind = 'youtube_upload')` 가 그것을 강제한다.
   * 라이브 경로에 seeded 행을 미리 세우면 이후 announce 의 claim 이 **반드시 실패**해
   * 방송 공지가 영영 나가지 않는다 (계획 rev.4 B-1).
   */
  seeded?: boolean;
}

export interface AnnouncementLedgerRepo {
  /**
   * 발송권을 집는다. **이번에 처음이면 `true`**, 이미 누가 집었으면 `false`.
   *
   * ★ INSERT 의 성공 여부가 곧 판정이다. 조회 후 삽입으로 나누면 두 경로가
   *   동시에 통과해 공지가 두 번 나간다.
   * ★ `synchronous = FULL` 로 커밋한다. claim 이 커밋되지 않은 채 발송이 나가면
   *   재기동 후 같은 이벤트를 다시 claim 해 **중복 공지**가 된다 — 되돌릴 수 없는
   *   종류의 오류(§3-a 3위)라 이 한 트랜잭션에는 fsync 비용을 낸다.
   */
  claim(
    kind: AnnouncementKind,
    eventKey: string,
    at: string,
    detectedVia: DetectedVia,
    opts?: ClaimOptions,
  ): boolean;

  /** 발송에 성공했다 — 이 행은 다시 보내지 않는다 */
  markSent(kind: AnnouncementKind, eventKey: string, messageId: string, at: string): void;

  /**
   * 발송에 실패했다. **실패 횟수**를 올리고 사유를 남긴다. **올린 뒤의 횟수를 돌려준다.**
   *
   * ★ 돌려주는 이유: 방금 그 실패가 몇 번째인지는 이 값으로만 알 수 있고,
   *   운영 경보 문구가 그 숫자를 싣는다.
   */
  markFailed(kind: AnnouncementKind, eventKey: string, error: string, at: string): number;

  /**
   * **보내지 않고 종결한다** — 늦어서 내용이 틀려진 공지를 닫는 유일한 수단.
   *
   * ★ 이미 종결된 행에는 아무 일도 하지 않는다(`announced_at IS NULL` 조건).
   *   발송에 성공한 행을 나중에 억제로 덮어써 `message_id` 를 지우면, 보낸 메시지의
   *   주소를 잃는다.
   */
  markSuppressed(kind: AnnouncementKind, eventKey: string, reason: string, at: string): void;

  /**
   * 아웃박스가 회수할 미발송 행. 오래 기다린 것부터 준다.
   *
   * ★ **시드 행은 나오지 않는다** — 발송 대상이 아니면 회수 창을 차지해서도 안 된다.
   */
  pendingRetries(limit?: number): PendingAnnouncement[];

  /** 진단·테스트용 단건 조회 */
  get(kind: AnnouncementKind, eventKey: string): LedgerRow | undefined;
}

/**
 * 지표 배선점 (§9.4).
 *
 * ★★ **여기가 유일하게 옳은 자리다.** `announcement_claim_conflicts` 는
 *   *"원장이 막은 중복 시도 수"* 인데, 그 사실을 아는 것은 `INSERT … ON CONFLICT`
 *   의 `changes` 를 본 이 함수뿐이다. 호출부(웹훅 라우트 · 폴러 · 복구 · 아웃박스)
 *   네 곳에서 각자 세면 **한 곳을 빠뜨린 날 그 경로의 중복만 보이지 않는다** —
 *   하필 그 침묵이 "중복이 없었다" 로 읽힌다.
 *
 * ★ 이 카운터는 **프로세스 수명**이고 `announcement_ledger` 테이블은 **영속**이다.
 *   둘은 다른 질문에 답한다 — "기동 이후 무슨 일이 있었나" 와 "무엇이 기록돼
 *   있나". 그래서 사본이 아니다.
 *
 * ★ 던지지 않기로 한다. 지표가 선점을 죽이면 그 방송은 영영 공지되지 않는다.
 */
export interface LedgerMetrics {
  /** 선점 성공 — 지표 `live_detected_via{via}` · `youtube_detected_via{via}` */
  claimed(kind: AnnouncementKind, detectedVia: DetectedVia): void;
  /** ★ 선점 실패 = 원장이 중복을 막았다. **0 이 아니어야 정상이다** */
  conflict(kind: AnnouncementKind, detectedVia: DetectedVia): void;
}

export interface AnnouncementLedgerRepoOptions {
  /** 없어도 원장은 그대로 동작한다 — 지표만 비는 것이 옳은 실패 방향이다 */
  metrics?: LedgerMetrics;
}

interface Row {
  kind: string;
  event_key: string;
  detected_via: string;
  claimed_at: string;
  announced_at: string | null;
  message_id: string | null;
  attempts: number;
  last_error: string | null;
  seeded: number;
}

/** 기본 회수 건수. 대기열은 이벤트 단위라 길어야 몇 건이다 */
export const DEFAULT_PENDING_LIMIT = 20;

/**
 * `last_error` 최대 길이.
 *
 * ★ 자르는 이유: 디스코드가 HTML 오류 페이지를 통째로 돌려주는 일이 있고,
 *   그걸 그대로 넣으면 한 행이 수십 KB 가 된다 (chzzkbot 의 같은 규율).
 */
export const MAX_LAST_ERROR = 500;

export function createAnnouncementLedgerRepo(
  db: Db,
  opts: AnnouncementLedgerRepoOptions = {},
): AnnouncementLedgerRepo {
  const insert = db.prepare<
    { kind: string; key: string; via: string; at: string; seeded: number },
    never
  >(`
    INSERT INTO announcement_ledger (kind, event_key, detected_via, claimed_at, seeded)
    VALUES (@kind, @key, @via, @at, @seeded)
    ON CONFLICT (kind, event_key) DO NOTHING
  `);

  // ★ 성공에서는 `attempts` 를 **올리지 않는다** (chzzkbot 의 규칙을 그대로 승계).
  //   이 값은 "몇 번 실패했는가" 이고 운영자가 발송이 얼마나 고생했는지 읽는 자리다.
  //   성공에도 올리면 한 번에 나간 건이 `attempts=1, last_error=NULL` 로 남아
  //   "한 번 실패했다 성공" 으로 읽힌다.
  const sent = db.prepare<{ kind: string; key: string; msg: string; at: string }, never>(`
    UPDATE announcement_ledger
       SET announced_at = @at, message_id = @msg, last_error = NULL
     WHERE kind = @kind AND event_key = @key
  `);

  /**
   * **보내지 않고 종결한다.**
   *
   * ★★ `announced_at` 은 채우고 `message_id` 는 **비워 둔다.** 이 조합이 *"보내지
   *   않고 닫았다"* 의 표식이다 — `markSent` 는 둘을 **항상 같이** 채우므로 둘은
   *   언제든 갈린다:
   *
   *   ```
   *   message_id IS NOT NULL  → 발송했다
   *   message_id IS NULL      → 보내지 않고 종결했다 (사유는 last_error)
   *   ```
   *
   * ★ 그래서 `announced_at` 의 뜻은 *"공지한 시각"* 이 아니라 **"이 행이 종결된
   *   시각"** 이다. 이름이 새 뜻을 다 담지 못하는 것은 알고 있다 — 정식 칸
   *   (`suppressed_at`)은 마이그레이션 002 를 열 때 승격한다(런북 §8-a).
   *   그때까지 이 조합이 정보 손실 없이 같은 일을 한다.
   *
   * ★ `attempts` 는 올리지 않는다. 시도한 적이 없다 — 보내지 않기로 **판단**한 것이다.
   */
  const suppressed = db.prepare<{ kind: string; key: string; reason: string; at: string }, never>(`
    UPDATE announcement_ledger
       SET announced_at = @at, message_id = NULL, last_error = @reason
     WHERE kind = @kind AND event_key = @key AND announced_at IS NULL
  `);

  // ★ RETURNING 으로 올라간 값을 한 번에 받는다. UPDATE 뒤에 다시 SELECT 하면
  //   그 사이에 다른 경로가 끼어들 수 있다 (그래서 db.ts 가 SQLite 3.35 를 요구한다).
  const failed = db.prepare<
    { kind: string; key: string; detail: string },
    { attempts: number }
  >(`
    UPDATE announcement_ledger
       SET attempts = attempts + 1, last_error = @detail
     WHERE kind = @kind AND event_key = @key
    RETURNING attempts
  `);

  // ★ `announced_at IS NULL` 부분 인덱스(idx_ledger_pending)를 탄다.
  //
  // ★ chzzkbot 과 달리 **`attempts < max` 상한을 걸지 않는다.**
  //   상류는 "받는 쪽 주소가 아예 틀린" 경우를 상정해 상한을 걸었지만, 여기서
  //   보내는 곳은 우리가 설정한 디스코드 채널 하나뿐이고 대기열은 방송·업로드
  //   단위라 하루 수 건이다. 상한을 걸면 디스코드가 오래 죽어 있던 방송이
  //   **영영 안 나간다**(§3-a 2위). 상한 없이 두면 최악이 "늦게 나간다"(1위)다.
  // ★★★ **시드 행을 여기서 걸러야 한다** — 발송 지점에서만 거르면 회수 창이 굶는다.
  //
  //   시드 행은 설계상 **영원히** `announced_at IS NULL` 이고(선점만 하고 공지하지
  //   않는 것이 시딩의 정의다) 기동 시딩이라 **가장 오래됐다.** 즉 `claimed_at ASC`
  //   정렬의 영구 상위권이다. 개수(채널당 15건)가 `LIMIT` 을 넘는 순간 창이 통째로
  //   시드로 채워지고, **진짜 미발송 행은 영영 회수되지 않는다.**
  //   실제로 2026-09-08 방송 공지 1건과 업로드 1건이 이 상태로 이틀을 갇혔다.
  //
  // ★ 두 표식을 **둘 다** 본다 — `main.ts` 재발송 지점과 같은 조건이다.
  //   한쪽만 걸면 반쪽짜리 시드 행이 창을 계속 차지한다. 그런 행이 존재할 수 있다는
  //   것은 `invariant-guards.test.ts` 의 HALFA·HALFB 가 이미 못 박아 뒀다.
  //
  // ★ 부분 인덱스 `idx_ledger_pending`(WHERE announced_at IS NULL)은 그대로 탄다.
  //   추가 조건은 인덱스가 좁힌 뒤에 걸린다.
  const selectPending = db.prepare<{ lim: number }, Row>(`
    SELECT kind, event_key, detected_via, claimed_at, announced_at, message_id,
           attempts, last_error, seeded
      FROM announcement_ledger
     WHERE announced_at IS NULL
       AND seeded = 0
       AND detected_via <> 'seed'
     ORDER BY claimed_at ASC, kind ASC, event_key ASC
     LIMIT @lim
  `);

  const selectOne = db.prepare<{ kind: string; key: string }, Row>(`
    SELECT kind, event_key, detected_via, claimed_at, announced_at, message_id,
           attempts, last_error, seeded
      FROM announcement_ledger
     WHERE kind = @kind AND event_key = @key
  `);

  const toPending = (r: Row): PendingAnnouncement => ({
    kind: r.kind as AnnouncementKind,
    eventKey: r.event_key,
    detectedVia: r.detected_via as DetectedVia,
    claimedAt: r.claimed_at,
    attempts: r.attempts,
    ...(r.last_error === null ? {} : { lastError: r.last_error }),
  });

  return {
    claim(kind, eventKey, at, detectedVia, claimOpts): boolean {
      const won = withFullSync(
        db,
        () =>
          insert.run({
            kind,
            key: eventKey,
            via: detectedVia,
            at,
            seeded: claimOpts?.seeded === true ? 1 : 0,
          }).changes === 1,
      );
      try {
        if (won) opts.metrics?.claimed(kind, detectedVia);
        else opts.metrics?.conflict(kind, detectedVia);
      } catch {
        /* 지표가 선점 판정을 바꾸지 않는다 (Principle 2) */
      }
      return won;
    },

    markSent(kind, eventKey, messageId, at): void {
      sent.run({ kind, key: eventKey, msg: messageId, at });
    },

    markSuppressed(kind, eventKey, reason, at): void {
      suppressed.run({ kind, key: eventKey, reason, at });
    },

    markFailed(kind, eventKey, error, at): number {
      // ★ 시각을 사유 앞에 붙인다. §8 데이터 모델에 실패 시각 컬럼이 없는데,
      //   "언제부터 못 나가고 있는가" 는 멈춘 행을 읽을 때 제일 먼저 필요한 값이다.
      //   컬럼을 새로 만드는 대신 사유 문자열이 그 사실을 싣는다.
      const detail = `${at} ${error}`.slice(0, MAX_LAST_ERROR);
      const row = failed.get({ kind, key: eventKey, detail });
      // 선점하지 않은 키면 고칠 행이 없다 — 올린 횟수도 없으므로 0 이다.
      return row?.attempts ?? 0;
    },

    pendingRetries(limit = DEFAULT_PENDING_LIMIT): PendingAnnouncement[] {
      return selectPending.all({ lim: limit }).map(toPending);
    },

    get(kind, eventKey): LedgerRow | undefined {
      const r = selectOne.get({ kind, key: eventKey });
      if (r === undefined) return undefined;
      return {
        ...toPending(r),
        ...(r.announced_at === null ? {} : { announcedAt: r.announced_at }),
        ...(r.message_id === null ? {} : { messageId: r.message_id }),
        seeded: r.seeded === 1,
      };
    },
  };
}
