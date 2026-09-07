import type { Db } from '../db.js';

/**
 * WebSub 구독 상태 — 계획 §8 `websub_subscriptions` (AC-20 · AC-P5 · AC-P7).
 *
 * ★★ **`lease_seconds` 는 허브가 준 값을 그대로 저장한다.** 상수 5일을 박지 않는다
 *   (계획 §5.3 "WebSub 운영 규칙"). 허브가 다른 값을 주면 상수는 **조용히 틀리고**,
 *   그 결과는 리스가 만료된 뒤에야 — 푸시가 멈춘 뒤에야 — 드러난다.
 *   그래서 이 표에는 갱신 시점을 적는 컬럼이 없다. 시점은 `lease_seconds` 에서
 *   유도한다(50%). 값 하나를 두 곳에 적으면 그 둘이 갈리는 날이 온다.
 *
 * ★ `secret` 은 **채널마다 다르다** (AC-P5). 하나를 공유하면 한 채널의 시크릿이
 *   새는 순간 모든 채널에 위조 푸시를 넣을 수 있다. 위조 푸시는 원장 선점을
 *   가져가므로 **진짜 업로드를 영영 못 나가게** 만든다 — 누락이다.
 *
 * ★ `last_renew_error` 는 **연속 횟수를 세지 않는다.** 연속 판정은
 *   `live/stuck-watch.ts` 하나가 소유한다 (AC-P7). 여기는 "마지막에 왜 실패했나"
 *   를 사람이 읽는 자리다 — 재기동해도 남아야 하므로 DB 에 둔다.
 */

export interface WebSubSubRow {
  channelId: string;
  secret: string;
  /** 허브가 준 리스 길이(초). 검증 콜백을 아직 못 받았으면 undefined */
  leaseSeconds?: number | undefined;
  /** 마지막으로 **구독 요청을 보낸** 시각. 재요청 쿨다운의 기준이다 */
  subscribedAt?: string | undefined;
  /** 검증 콜백 시각 + `lease_seconds`. 미검증이면 undefined */
  expiresAt?: string | undefined;
  lastRenewError?: string | undefined;
}

export interface WebSubSubRepo {
  /**
   * 없으면 시크릿과 함께 만들고, 있으면 **기존 시크릿을 그대로 둔다.**
   *
   * ★ 매 기동마다 새 시크릿을 쓰면 허브는 옛 시크릿으로 서명한 푸시를 계속 보내고
   *   우리는 그것을 전부 서명 실패로 버린다 — `websub_signature_failures` 만
   *   올라가고 업로드는 조용히 사라진다.
   */
  ensure(channelId: string, secret: string): WebSubSubRow;
  get(channelId: string): WebSubSubRow | undefined;
  list(): WebSubSubRow[];
  /** 구독 요청을 보냈다 (허브가 202 로 받았다). 검증은 아직이다 */
  markRequested(channelId: string, at: string): void;
  /** ★ 검증 콜백에서 받은 리스를 기록한다. `leaseSeconds` 를 모르면 둘 다 NULL 이다 */
  recordLease(channelId: string, leaseSeconds: number | undefined, expiresAt: string | undefined): void;
  setRenewError(channelId: string, error: string, at: string): void;
  clearRenewError(channelId: string): void;
  /** 구독을 지운다 (unsubscribe 검증 수신). 시크릿도 함께 사라진다 */
  remove(channelId: string): void;
}

/** `last_renew_error` 상한. 허브가 HTML 오류 페이지를 통째로 주는 일이 있다 */
export const MAX_RENEW_ERROR = 500;

interface Row {
  channel_id: string;
  secret: string;
  lease_seconds: number | null;
  subscribed_at: string | null;
  expires_at: string | null;
  last_renew_error: string | null;
}

function toRow(r: Row): WebSubSubRow {
  return {
    channelId: r.channel_id,
    secret: r.secret,
    ...(r.lease_seconds === null ? {} : { leaseSeconds: r.lease_seconds }),
    ...(r.subscribed_at === null ? {} : { subscribedAt: r.subscribed_at }),
    ...(r.expires_at === null ? {} : { expiresAt: r.expires_at }),
    ...(r.last_renew_error === null ? {} : { lastRenewError: r.last_renew_error }),
  };
}

export function createWebSubSubRepo(db: Db): WebSubSubRepo {
  const insert = db.prepare<{ id: string; secret: string }, never>(`
    INSERT INTO websub_subscriptions (channel_id, secret)
    VALUES (@id, @secret)
    ON CONFLICT (channel_id) DO NOTHING
  `);

  const selectOne = db.prepare<{ id: string }, Row>(`
    SELECT channel_id, secret, lease_seconds, subscribed_at, expires_at, last_renew_error
      FROM websub_subscriptions
     WHERE channel_id = @id
  `);

  const selectAll = db.prepare<[], Row>(`
    SELECT channel_id, secret, lease_seconds, subscribed_at, expires_at, last_renew_error
      FROM websub_subscriptions
     ORDER BY channel_id ASC
  `);

  const requested = db.prepare<{ id: string; at: string }, never>(`
    UPDATE websub_subscriptions SET subscribed_at = @at WHERE channel_id = @id
  `);

  const lease = db.prepare<{ id: string; lease: number | null; exp: string | null }, never>(`
    UPDATE websub_subscriptions
       SET lease_seconds = @lease, expires_at = @exp, last_renew_error = NULL
     WHERE channel_id = @id
  `);

  const renewError = db.prepare<{ id: string; detail: string }, never>(`
    UPDATE websub_subscriptions SET last_renew_error = @detail WHERE channel_id = @id
  `);

  const clearError = db.prepare<{ id: string }, never>(`
    UPDATE websub_subscriptions SET last_renew_error = NULL WHERE channel_id = @id
  `);

  const del = db.prepare<{ id: string }, never>(`
    DELETE FROM websub_subscriptions WHERE channel_id = @id
  `);

  return {
    ensure(channelId, secret): WebSubSubRow {
      insert.run({ id: channelId, secret });
      const r = selectOne.get({ id: channelId });
      // FK 가 켜져 있으므로 youtube_channels 행이 없으면 여기서 던진다.
      // 그게 옳다 — 채널 없는 구독은 갱신 잡이 유령 채널을 계속 재구독한다.
      if (r === undefined) throw new Error(`websub 구독 행을 만들지 못했습니다: ${channelId}`);
      return toRow(r);
    },

    get(channelId): WebSubSubRow | undefined {
      const r = selectOne.get({ id: channelId });
      return r === undefined ? undefined : toRow(r);
    },

    list(): WebSubSubRow[] {
      return selectAll.all().map(toRow);
    },

    markRequested(channelId, at): void {
      requested.run({ id: channelId, at });
    },

    recordLease(channelId, leaseSeconds, expiresAt): void {
      lease.run({
        id: channelId,
        lease: leaseSeconds ?? null,
        exp: expiresAt ?? null,
      });
    },

    setRenewError(channelId, error, at): void {
      // ★ 시각을 사유 앞에 붙인다 (원장 `markFailed` 와 같은 규율). "언제부터 못 갱신하고
      //   있는가" 가 멈춘 구독을 읽을 때 제일 먼저 필요한 값인데 컬럼이 없다.
      const detail = `${at} ${error}`.slice(0, MAX_RENEW_ERROR);
      renewError.run({ id: channelId, detail });
    },

    clearRenewError(channelId): void {
      clearError.run({ id: channelId });
    },

    remove(channelId): void {
      del.run({ id: channelId });
    },
  };
}
