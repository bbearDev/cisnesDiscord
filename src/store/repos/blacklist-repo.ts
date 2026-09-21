import type { Db } from '../db.js';
import type { AccountLink } from './link-repo.js';

/**
 * 인증 차단 목록 저장소 — `002_blacklist.sql`.
 *
 * ★ 이 테이블은 **현재 차단 상태**만 담는다 (`account_links` 와 같은 원칙). 해제하면 행을
 *   지우고, "언제 누가 차단·해제했나" 는 `ops_events` 가 받는다. soft-delete 를 두면
 *   "차단됐던 사람" 과 "차단된 사람" 이 한 테이블에 섞여 콜백의 판정 한 줄이 두 줄이 된다.
 *
 * ★★ `add()` 가 **연동 행까지 한 트랜잭션에서** 처리한다 — 그 시점의 `account_links` 행을 읽어
 *   치지직 채널을 차단 행에 복사하고, 연동 행을 지운다. 명령이 두 저장소를 차례로 부르면
 *   그 사이에 프로세스가 죽었을 때 "차단됨 + 연동됨" 이 공존한다 (인증은 막히지만
 *   `/연동상태` 가 계속 "연동됨" 을 보인다). 두 문장이 한 뜻이면 한 트랜잭션이어야 한다.
 *
 * ★★ `findBlocking()` 이 이 파일의 요점이다. 콜백은 디스코드 계정과 치지직 채널 **둘 다**로
 *   묻는다 — 새 디스코드 계정으로 같은 치지직 계정을 다시 붙이는 우회를 막는 자리다.
 *   인증 버튼은 치지직 채널을 아직 모르므로 디스코드 계정으로만 묻는다.
 *
 * ★ `add()` 는 던지지 않는다. 이미 있는 사람은 판정(`already-blacklisted`)으로 돌려주고
 *   **기존 행을 갱신하지 않는다** — 사유를 덮어쓰고 싶으면 해제 후 다시 추가하는 운영
 *   동작이지, 두 번 누른 부작용이 아니다.
 */

export interface BlacklistEntry {
  guildId: string;
  discordUserId: string;
  /** 차단 시점에 연동돼 있던 치지직 채널. 연동이 없었으면 `undefined` */
  chzzkChannelId?: string | undefined;
  chzzkChannelName?: string | undefined;
  reason?: string | undefined;
  /** 차단한 운영자 */
  addedBy: string;
  /** ISO-8601 UTC */
  addedAt: string;
}

/** 치지직 채널은 받지 않는다 — 그 시점의 연동 행에서 저장소가 복사한다 (머리말 ★★) */
export type BlacklistAddInput = Pick<BlacklistEntry, 'guildId' | 'discordUserId' | 'reason' | 'addedBy' | 'addedAt'>;

export type BlacklistAddOutcome =
  | {
      ok: true;
      entry: BlacklistEntry;
      /** 함께 지운 연동 행. 연동이 없었으면 `undefined` — 그때는 디스코드 계정만 막힌다 */
      unlinked: AccountLink | undefined;
    }
  /** 이미 차단돼 있다. 기존 행도 연동 행도 무변화다 */
  | { ok: false; reason: 'already-blacklisted'; existing: BlacklistEntry };

/** `ops_events.kind` — 차단·해제 이력 */
export const OPS_EVENT_BLACKLIST_ADDED = 'blacklist_added';
export const OPS_EVENT_BLACKLIST_REMOVED = 'blacklist_removed';

export interface BlacklistRepo {
  /**
   * 차단 행 기록 + 연동 행 삭제를 **한 트랜잭션**에서. **던지지 않는다** — 이미 있으면
   * 판정으로 돌려주고 아무것도 바꾸지 않는다. 성공 시 `ops_events` 에 남긴다
   */
  add(input: BlacklistAddInput): BlacklistAddOutcome;
  /** 행을 **지운다.** 지운 행을 돌려주고 `ops_events` 에 남긴다. 없었으면 `undefined` */
  remove(guildId: string, discordUserId: string, by: string, at: string): BlacklistEntry | undefined;
  get(guildId: string, discordUserId: string): BlacklistEntry | undefined;
  /**
   * 이 디스코드 계정 **또는** 이 치지직 채널을 막는 행. 둘 다 걸리면 디스코드 계정 쪽이다.
   * 치지직 채널을 아직 모르는 호출부(인증 버튼)는 `chzzkChannelId` 를 비운다.
   */
  findBlocking(
    guildId: string,
    discordUserId: string,
    chzzkChannelId?: string,
  ): BlacklistEntry | undefined;
  /** 최근 차단이 앞이다 */
  list(guildId: string): BlacklistEntry[];
  count(guildId: string): number;
}

interface Row {
  guild_id: string;
  discord_user_id: string;
  chzzk_channel_id: string | null;
  chzzk_channel_name: string | null;
  reason: string | null;
  added_by: string;
  added_at: string;
}

/** `account_links` 중 여기서 읽는 만큼 (`link-repo.ts` 의 `Row` 와 같은 컬럼명) */
interface LinkRow {
  discord_user_id: string;
  guild_id: string;
  chzzk_channel_id: string;
  chzzk_channel_name: string;
  linked_at: string;
}

const toEntry = (r: Row): BlacklistEntry => ({
  guildId: r.guild_id,
  discordUserId: r.discord_user_id,
  chzzkChannelId: r.chzzk_channel_id ?? undefined,
  chzzkChannelName: r.chzzk_channel_name ?? undefined,
  reason: r.reason ?? undefined,
  addedBy: r.added_by,
  addedAt: r.added_at,
});

const COLUMNS =
  'guild_id, discord_user_id, chzzk_channel_id, chzzk_channel_name, reason, added_by, added_at';

export function createBlacklistRepo(db: Db): BlacklistRepo {
  const selectByUser = db.prepare<{ guild: string; user: string }, Row>(
    `SELECT ${COLUMNS} FROM blacklist WHERE guild_id = @guild AND discord_user_id = @user`,
  );
  const selectByChannel = db.prepare<{ guild: string; channel: string }, Row>(
    `SELECT ${COLUMNS} FROM blacklist WHERE guild_id = @guild AND chzzk_channel_id = @channel`,
  );
  const selectAll = db.prepare<{ guild: string }, Row>(
    `SELECT ${COLUMNS} FROM blacklist WHERE guild_id = @guild ORDER BY added_at DESC, discord_user_id ASC`,
  );
  const insert = db.prepare<
    {
      guild: string;
      user: string;
      channel: string | null;
      name: string | null;
      reason: string | null;
      by: string;
      at: string;
    },
    never
  >(`
    INSERT INTO blacklist (guild_id, discord_user_id, chzzk_channel_id, chzzk_channel_name, reason, added_by, added_at)
    VALUES (@guild, @user, @channel, @name, @reason, @by, @at)
  `);
  const del = db.prepare<{ guild: string; user: string }, never>(
    'DELETE FROM blacklist WHERE guild_id = @guild AND discord_user_id = @user',
  );
  const insertOps = db.prepare<{ kind: string; detail: string; at: string }, never>(
    'INSERT INTO ops_events (kind, detail, at) VALUES (@kind, @detail, @at)',
  );
  const countRows = db.prepare<{ guild: string }, { n: number }>(
    'SELECT COUNT(*) AS n FROM blacklist WHERE guild_id = @guild',
  );
  const selectLink = db.prepare<{ guild: string; user: string }, LinkRow>(
    'SELECT discord_user_id, guild_id, chzzk_channel_id, chzzk_channel_name, linked_at FROM account_links WHERE guild_id = @guild AND discord_user_id = @user',
  );
  const deleteLink = db.prepare<{ guild: string; user: string }, never>(
    'DELETE FROM account_links WHERE guild_id = @guild AND discord_user_id = @user',
  );

  // ★ 조회 → 판정 → 연동 삭제 → INSERT 를 한 트랜잭션에 둔다 (머리말 ★★ · `link-repo.ts` 와 같은 이유).
  const addTx = db.transaction((input: BlacklistAddInput): BlacklistAddOutcome => {
    const existing = selectByUser.get({ guild: input.guildId, user: input.discordUserId });
    if (existing !== undefined) {
      return { ok: false, reason: 'already-blacklisted', existing: toEntry(existing) };
    }

    const link = selectLink.get({ guild: input.guildId, user: input.discordUserId });
    if (link !== undefined) deleteLink.run({ guild: input.guildId, user: input.discordUserId });

    const entry: BlacklistEntry = {
      guildId: input.guildId,
      discordUserId: input.discordUserId,
      chzzkChannelId: link?.chzzk_channel_id,
      chzzkChannelName: link?.chzzk_channel_name,
      reason: input.reason,
      addedBy: input.addedBy,
      addedAt: input.addedAt,
    };
    insert.run({
      guild: entry.guildId,
      user: entry.discordUserId,
      channel: entry.chzzkChannelId ?? null,
      name: entry.chzzkChannelName ?? null,
      reason: entry.reason ?? null,
      by: entry.addedBy,
      at: entry.addedAt,
    });
    insertOps.run({
      kind: OPS_EVENT_BLACKLIST_ADDED,
      detail: JSON.stringify({
        guildId: entry.guildId,
        discordUserId: entry.discordUserId,
        chzzkChannelId: entry.chzzkChannelId ?? null,
        reason: entry.reason ?? null,
        by: entry.addedBy,
      }),
      at: entry.addedAt,
    });
    return {
      ok: true,
      entry,
      unlinked:
        link === undefined
          ? undefined
          : {
              discordUserId: link.discord_user_id,
              guildId: link.guild_id,
              chzzkChannelId: link.chzzk_channel_id,
              chzzkChannelName: link.chzzk_channel_name,
              linkedAt: link.linked_at,
            },
    };
  });

  const removeTx = db.transaction(
    (guildId: string, discordUserId: string, by: string, at: string): BlacklistEntry | undefined => {
      const existing = selectByUser.get({ guild: guildId, user: discordUserId });
      if (existing === undefined) return undefined;
      del.run({ guild: guildId, user: discordUserId });
      insertOps.run({
        kind: OPS_EVENT_BLACKLIST_REMOVED,
        detail: JSON.stringify({
          guildId,
          discordUserId,
          chzzkChannelId: existing.chzzk_channel_id,
          by,
        }),
        at,
      });
      return toEntry(existing);
    },
  );

  return {
    add: (input) => addTx(input),

    remove: (guildId, discordUserId, by, at) => removeTx(guildId, discordUserId, by, at),

    get(guildId, discordUserId): BlacklistEntry | undefined {
      const r = selectByUser.get({ guild: guildId, user: discordUserId });
      return r === undefined ? undefined : toEntry(r);
    },

    findBlocking(guildId, discordUserId, chzzkChannelId): BlacklistEntry | undefined {
      const mine = selectByUser.get({ guild: guildId, user: discordUserId });
      if (mine !== undefined) return toEntry(mine);
      if (chzzkChannelId === undefined) return undefined;
      const byChannel = selectByChannel.get({ guild: guildId, channel: chzzkChannelId });
      return byChannel === undefined ? undefined : toEntry(byChannel);
    },

    list(guildId): BlacklistEntry[] {
      return selectAll.all({ guild: guildId }).map(toEntry);
    },

    count(guildId): number {
      return countRows.get({ guild: guildId })?.n ?? 0;
    },
  };
}
