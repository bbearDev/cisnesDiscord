import type { Db } from '../db.js';

/**
 * `guild_config` 저장소 — 계획 §8 (가정 5).
 *
 * 채널·역할 id 는 길드마다 다르므로 설정 파일이 아니라 DB 에 둔다.
 * `config/config.yaml` 은 *"이 프로세스가 어떻게 도는가"* 이고 여기는
 * *"이 서버에서 어디에 쓰는가"* 다.
 *
 * ★★ **`single()` 이 이 파일의 요점이다.**
 *   §8 의 `verification_sessions` 에는 **`guild_id` 컬럼이 없다.** 그래서 OAuth
 *   콜백은 길드를 세션에서 읽을 수 없고 여기서 해석해야 한다
 *   (`web/routes/oauth-callback.ts` 의 `resolveGuild`). 단일 길드 배포가 전제이며,
 *   다길드로 넓히려면 **002 마이그레이션이 먼저다.**
 *
 * ★ 그래서 `single()` 은 행이 **정확히 하나일 때만** 그 행을 준다.
 *   0건이면 아직 설정하지 않은 것이고 2건 이상이면 어느 쪽인지 알 수 없다 —
 *   둘 다 `undefined` 다. **조용히 첫 행을 고르지 않는다**: 그렇게 하면
 *   "남의 서버 역할을 부여했다" 가 되고, 그건 되돌릴 수 없는 종류의 오류다(§3-a 3위).
 *   콜백은 이 `undefined` 를 받아 `no-guild` 로 인증을 끝낸다.
 */

export interface GuildConfigRow {
  guildId: string;
  /** 인증 완료 시 부여할 역할 */
  verifiedRoleId?: string | undefined;
  /** 인증 패널(임베드 + 버튼)이 놓이는 게이트 채널. `/인증채널` 이 채운다 */
  gateChannelId?: string | undefined;
  /** 방송 시작 공지 */
  liveChannelId?: string | undefined;
  /** 유튜브 업로드 공지 */
  uploadChannelId?: string | undefined;
  /** 운영 경보 (AC-P1~P7) */
  opsChannelId?: string | undefined;
  updatedAt: string;
}

export type GuildConfigInput = Omit<GuildConfigRow, 'updatedAt'>;

export interface GuildConfigRepo {
  get(guildId: string): GuildConfigRow | undefined;
  list(): GuildConfigRow[];
  /** ★ 행이 **정확히 하나**일 때만 그 행. 0건·2건 이상이면 `undefined` (위 머리말) */
  single(): GuildConfigRow | undefined;
  /** 지정한 필드만 덮어쓴다. 주지 않은 필드는 기존 값을 유지한다 */
  upsert(input: GuildConfigInput, at: string): void;
}

interface Row {
  guild_id: string;
  verified_role_id: string | null;
  gate_channel_id: string | null;
  live_channel_id: string | null;
  upload_channel_id: string | null;
  ops_channel_id: string | null;
  updated_at: string;
}

const COLUMNS =
  'guild_id, verified_role_id, gate_channel_id, live_channel_id, upload_channel_id, ops_channel_id, updated_at';

function toRow(r: Row): GuildConfigRow {
  return {
    guildId: r.guild_id,
    ...(r.verified_role_id === null ? {} : { verifiedRoleId: r.verified_role_id }),
    ...(r.gate_channel_id === null ? {} : { gateChannelId: r.gate_channel_id }),
    ...(r.live_channel_id === null ? {} : { liveChannelId: r.live_channel_id }),
    ...(r.upload_channel_id === null ? {} : { uploadChannelId: r.upload_channel_id }),
    ...(r.ops_channel_id === null ? {} : { opsChannelId: r.ops_channel_id }),
    updatedAt: r.updated_at,
  };
}

export function createGuildConfigRepo(db: Db): GuildConfigRepo {
  const selectOne = db.prepare<{ id: string }, Row>(
    `SELECT ${COLUMNS} FROM guild_config WHERE guild_id = @id`,
  );
  const selectAll = db.prepare<[], Row>(
    `SELECT ${COLUMNS} FROM guild_config ORDER BY guild_id ASC`,
  );
  const upsert = db.prepare<
    {
      id: string;
      role: string | null;
      gate: string | null;
      live: string | null;
      upload: string | null;
      ops: string | null;
      at: string;
    },
    never
  >(`
    INSERT INTO guild_config
      (guild_id, verified_role_id, gate_channel_id, live_channel_id, upload_channel_id, ops_channel_id, updated_at)
    VALUES (@id, @role, @gate, @live, @upload, @ops, @at)
    ON CONFLICT (guild_id) DO UPDATE SET
      -- ★ COALESCE — 주지 않은 필드는 지우지 않는다. 운영자가 채널 하나만 바꾸려다
      --   나머지 셋을 NULL 로 만드는 사고가 이 한 줄로 성립하지 않는다.
      verified_role_id  = COALESCE(excluded.verified_role_id, guild_config.verified_role_id),
      gate_channel_id   = COALESCE(excluded.gate_channel_id, guild_config.gate_channel_id),
      live_channel_id   = COALESCE(excluded.live_channel_id, guild_config.live_channel_id),
      upload_channel_id = COALESCE(excluded.upload_channel_id, guild_config.upload_channel_id),
      ops_channel_id    = COALESCE(excluded.ops_channel_id, guild_config.ops_channel_id),
      updated_at        = excluded.updated_at
  `);

  return {
    get(guildId): GuildConfigRow | undefined {
      const r = selectOne.get({ id: guildId });
      return r === undefined ? undefined : toRow(r);
    },

    list(): GuildConfigRow[] {
      return selectAll.all().map(toRow);
    },

    single(): GuildConfigRow | undefined {
      const rows = selectAll.all();
      // ★ 정확히 하나일 때만. 아무 길드나 고르지 않는다 (위 머리말).
      return rows.length === 1 && rows[0] !== undefined ? toRow(rows[0]) : undefined;
    },

    upsert(input, at): void {
      upsert.run({
        id: input.guildId,
        role: input.verifiedRoleId ?? null,
        gate: input.gateChannelId ?? null,
        live: input.liveChannelId ?? null,
        upload: input.uploadChannelId ?? null,
        ops: input.opsChannelId ?? null,
        at,
      });
    },
  };
}
