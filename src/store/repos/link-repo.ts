// 출처: chzzkbot src/store/repos/enrollment-repo.ts — "제약이 판정한다 · 거부는 아무것도
//       바꾸지 않는다" 는 규율을 옮겼다 (계획 §14). 스키마는 이 저장소의 것이다.
import type { Db } from '../db.js';

/**
 * ★ 계정 연동 — **중복 연동을 조건문이 아니라 제약이 막는다** (AC-7).
 *
 * `account_links` 에는 두 제약이 있고 **뜻이 서로 다르다.**
 *
 *   PRIMARY KEY (discord_user_id, guild_id)   한 디스코드 계정은 길드당 연동 1건
 *   UNIQUE      (guild_id, chzzk_channel_id)  ★ 한 치지직 계정으로 여러 디스코드
 *                                               계정이 인증받는 것을 막는다 = AC-7
 *
 * 둘을 같은 오류로 접으면 **AC-12(a) 멱등 안내**와 **AC-7 거부**가 뒤섞인다 —
 * 앞은 "이미 하셨습니다"(정상)이고 뒤는 "남이 쓰고 있습니다"(거부 + 운영 기록)다.
 * 그래서 `link()` 가 셋을 구분해 돌려준다.
 *
 * ★★ **거부는 기존 행을 건드리지 않는다** (AC-8). UPSERT 를 쓰지 않는 이유가 이것이다 —
 *   `ON CONFLICT DO UPDATE` 한 줄이면 남의 연동을 조용히 빼앗는 기능이 된다.
 *
 * ★ `/연동해제` 는 **행을 지운다.** soft-delete 를 두지 않는다 (AC-9) —
 *   지워지지 않은 행은 UNIQUE 제약을 계속 점유해서, 해제한 사람이 다시 인증할 때
 *   자기 자신 때문에 막힌다.
 */

export interface AccountLink {
  discordUserId: string;
  guildId: string;
  chzzkChannelId: string;
  chzzkChannelName: string;
  linkedAt: string;
}

export interface LinkInput {
  discordUserId: string;
  guildId: string;
  chzzkChannelId: string;
  chzzkChannelName: string;
  /** ISO-8601 UTC */
  at: string;
}

export type LinkOutcome =
  /** 새로 연동됐다 */
  | { ok: true; created: true; link: AccountLink }
  /**
   * AC-12(a) — **이미 이 디스코드 계정으로 연동돼 있다.**
   * 오류가 아니다. 기존 행을 그대로 두고 안내만 한다. 역할 부여는 멱등이므로
   * 호출부가 그대로 진행해도 된다.
   */
  | { ok: true; created: false; link: AccountLink }
  /**
   * ★ AC-7 — 이 치지직 채널이 **다른 디스코드 계정**에 이미 묶여 있다.
   * 거부하고 `ops_events` 에 남긴다. 기존 행은 무변화다 (AC-8).
   */
  | { ok: false; reason: 'duplicate-channel'; existing: AccountLink };

/** `ops_events.kind` — AC-8 이 요구하는 운영 기록 */
export const OPS_EVENT_DUPLICATE_CHANNEL = 'link_duplicate_channel';

export interface OpsEventRow {
  id: number;
  kind: string;
  detail: string | undefined;
  at: string;
}

export interface LinkRepo {
  /** **던지지 않는다.** 제약 위반을 판정으로 바꿔 돌려준다 */
  link(input: LinkInput): LinkOutcome;
  get(guildId: string, discordUserId: string): AccountLink | undefined;
  /** UNIQUE (guild_id, chzzk_channel_id) 쪽 조회 */
  getByChannel(guildId: string, chzzkChannelId: string): AccountLink | undefined;
  /** AC-9 — **삭제한다.** 지운 행을 돌려준다. 없었으면 `undefined` */
  unlink(guildId: string, discordUserId: string): AccountLink | undefined;
  /** 진단·테스트용. `kind` 를 주면 그 종류만 */
  opsEvents(kind?: string): OpsEventRow[];
  count(guildId: string): number;
}

interface Row {
  discord_user_id: string;
  guild_id: string;
  chzzk_channel_id: string;
  chzzk_channel_name: string;
  linked_at: string;
}

interface OpsRow {
  id: number;
  kind: string;
  detail: string | null;
  at: string;
}

const toLink = (r: Row): AccountLink => ({
  discordUserId: r.discord_user_id,
  guildId: r.guild_id,
  chzzkChannelId: r.chzzk_channel_id,
  chzzkChannelName: r.chzzk_channel_name,
  linkedAt: r.linked_at,
});

const COLUMNS =
  'discord_user_id, guild_id, chzzk_channel_id, chzzk_channel_name, linked_at';

export function createLinkRepo(db: Db): LinkRepo {
  const selectByUser = db.prepare<{ guild: string; user: string }, Row>(
    `SELECT ${COLUMNS} FROM account_links WHERE guild_id = @guild AND discord_user_id = @user`,
  );
  const selectByChannel = db.prepare<{ guild: string; channel: string }, Row>(
    `SELECT ${COLUMNS} FROM account_links WHERE guild_id = @guild AND chzzk_channel_id = @channel`,
  );
  const insert = db.prepare<
    { user: string; guild: string; channel: string; name: string; at: string },
    never
  >(`
    INSERT INTO account_links (discord_user_id, guild_id, chzzk_channel_id, chzzk_channel_name, linked_at)
    VALUES (@user, @guild, @channel, @name, @at)
  `);
  const del = db.prepare<{ guild: string; user: string }, never>(
    'DELETE FROM account_links WHERE guild_id = @guild AND discord_user_id = @user',
  );
  const insertOps = db.prepare<{ kind: string; detail: string; at: string }, never>(
    'INSERT INTO ops_events (kind, detail, at) VALUES (@kind, @detail, @at)',
  );
  const selectOps = db.prepare<{ kind: string | null }, OpsRow>(
    'SELECT id, kind, detail, at FROM ops_events WHERE @kind IS NULL OR kind = @kind ORDER BY id ASC',
  );
  const countLinks = db.prepare<{ guild: string }, { n: number }>(
    'SELECT COUNT(*) AS n FROM account_links WHERE guild_id = @guild',
  );

  /**
   * ★ 한 트랜잭션 안에서 읽고 쓴다.
   *
   *   조회 → 판정 → INSERT 를 트랜잭션 밖에서 하면 그 사이에 다른 경로가 끼어들어
   *   두 판정이 모두 "비어 있다" 를 보고 둘 다 INSERT 를 시도한다. 하나는
   *   제약에 걸려 예외가 되는데, 그 예외는 **판정이 아니라 스택 트레이스**로 나간다.
   *   (D1 단일 이벤트 루프라 실제 동시성은 없지만, 제약이 판정을 대신한다는
   *   Principle 1 을 코드 모양으로도 지킨다.)
   */
  const linkTx = db.transaction((input: LinkInput): LinkOutcome => {
    const mine = selectByUser.get({ guild: input.guildId, user: input.discordUserId });
    if (mine !== undefined) {
      // AC-12(a). **기존 행을 갱신하지 않는다** — 같은 사람이 다른 치지직 계정으로
      // 갈아타는 것은 `/연동해제` 를 거쳐야 하는 운영 동작이지 인증의 부작용이 아니다.
      return { ok: true, created: false, link: toLink(mine) };
    }

    const holder = selectByChannel.get({
      guild: input.guildId,
      channel: input.chzzkChannelId,
    });
    if (holder !== undefined) {
      // ★ AC-7 거부 + AC-8 기록. 여기서 기존 행에 손대는 문장은 하나도 없다.
      insertOps.run({
        kind: OPS_EVENT_DUPLICATE_CHANNEL,
        detail: JSON.stringify({
          guildId: input.guildId,
          chzzkChannelId: input.chzzkChannelId,
          attemptedBy: input.discordUserId,
          heldBy: holder.discord_user_id,
        }),
        at: input.at,
      });
      return { ok: false, reason: 'duplicate-channel', existing: toLink(holder) };
    }

    insert.run({
      user: input.discordUserId,
      guild: input.guildId,
      channel: input.chzzkChannelId,
      name: input.chzzkChannelName,
      at: input.at,
    });
    return {
      ok: true,
      created: true,
      link: {
        discordUserId: input.discordUserId,
        guildId: input.guildId,
        chzzkChannelId: input.chzzkChannelId,
        chzzkChannelName: input.chzzkChannelName,
        linkedAt: input.at,
      },
    };
  });

  return {
    link: (input) => linkTx(input),

    get(guildId, discordUserId): AccountLink | undefined {
      const r = selectByUser.get({ guild: guildId, user: discordUserId });
      return r === undefined ? undefined : toLink(r);
    },

    getByChannel(guildId, chzzkChannelId): AccountLink | undefined {
      const r = selectByChannel.get({ guild: guildId, channel: chzzkChannelId });
      return r === undefined ? undefined : toLink(r);
    },

    unlink(guildId, discordUserId): AccountLink | undefined {
      const existing = selectByUser.get({ guild: guildId, user: discordUserId });
      if (existing === undefined) return undefined;
      del.run({ guild: guildId, user: discordUserId });
      return toLink(existing);
    },

    opsEvents(kind): OpsEventRow[] {
      return selectOps.all({ kind: kind ?? null }).map((r) => ({
        id: r.id,
        kind: r.kind,
        detail: r.detail ?? undefined,
        at: r.at,
      }));
    },

    count(guildId): number {
      return countLinks.get({ guild: guildId })?.n ?? 0;
    },
  };
}
