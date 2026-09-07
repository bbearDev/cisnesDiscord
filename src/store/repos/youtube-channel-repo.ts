// 출처: chzzkbot src/store/repos/processed-repo.ts 의 "UPDATE … WHERE 조건이 곧 판정" 규율
//       (계획 §14 · Principle 5 "차용은 복사한다")
import type { Db } from '../db.js';

/**
 * 감시 대상 유튜브 채널 — 계획 §8 `youtube_channels` (AC-20 · AC-26).
 *
 * ★★ 이 저장소가 지키는 불변식은 하나다: **`seeded_at` 은 채널당 한 번만 선다.**
 *   AC-26 의 "빈 DB 로 처음 기동하면 현재 피드를 `seeded=1` 로 선점만 하고 공지하지
 *   않는다" 는 이 한 줄에 걸려 있다. 두 번 서면 두 번째 시딩이 **그 사이에 올라온
 *   신규 업로드까지 `seeded=1` 로 덮어** 영영 공지되지 않게 만든다 — 누락(§3-a 2위)이다.
 *   그래서 판정을 조건문이 아니라 `WHERE seeded_at IS NULL` 에 둔다.
 *
 * ★ `upsert` 는 **`seeded_at` 을 건드리지 않는다.** 설정에서 라벨만 바꾸고 재기동하는
 *   것은 흔한 일이고, 그때 시딩 표식이 날아가면 위 사고가 그대로 일어난다.
 */

export interface YoutubeChannelRow {
  channelId: string;
  label: string;
  /** AC-26 시딩 완료 시각. undefined 면 아직 시딩하지 않았다 */
  seededAt?: string | undefined;
  lastRssPollAt?: string | undefined;
}

export interface YoutubeChannelRepo {
  /** 설정의 채널을 DB 에 반영한다. **`seeded_at` 은 보존한다** */
  upsert(channelId: string, label: string): void;
  get(channelId: string): YoutubeChannelRow | undefined;
  list(): YoutubeChannelRow[];
  /**
   * AC-26 시딩 완료 표식. **이번에 처음 섰으면 `true`.**
   *
   * ★ 반환값이 판정이다. `UPDATE … WHERE seeded_at IS NULL` 의 `changes` 가
   *   곧 "내가 시딩한 쪽인가" 라, 호출부가 다시 조회해 분기할 필요가 없다.
   */
  markSeeded(channelId: string, at: string): boolean;
  markPolled(channelId: string, at: string): void;
}

interface Row {
  channel_id: string;
  label: string;
  seeded_at: string | null;
  last_rss_poll_at: string | null;
}

function toRow(r: Row): YoutubeChannelRow {
  return {
    channelId: r.channel_id,
    label: r.label,
    ...(r.seeded_at === null ? {} : { seededAt: r.seeded_at }),
    ...(r.last_rss_poll_at === null ? {} : { lastRssPollAt: r.last_rss_poll_at }),
  };
}

export function createYoutubeChannelRepo(db: Db): YoutubeChannelRepo {
  // ★ DO UPDATE 에 label 만 적는다. seeded_at · last_rss_poll_at 을 빼먹은 게 아니라
  //   **일부러 뺀 것**이다 (위 머리말).
  const upsert = db.prepare<{ id: string; label: string }, never>(`
    INSERT INTO youtube_channels (channel_id, label)
    VALUES (@id, @label)
    ON CONFLICT (channel_id) DO UPDATE SET label = excluded.label
  `);

  const selectOne = db.prepare<{ id: string }, Row>(`
    SELECT channel_id, label, seeded_at, last_rss_poll_at
      FROM youtube_channels
     WHERE channel_id = @id
  `);

  const selectAll = db.prepare<[], Row>(`
    SELECT channel_id, label, seeded_at, last_rss_poll_at
      FROM youtube_channels
     ORDER BY channel_id ASC
  `);

  const seed = db.prepare<{ id: string; at: string }, never>(`
    UPDATE youtube_channels
       SET seeded_at = @at
     WHERE channel_id = @id AND seeded_at IS NULL
  `);

  const polled = db.prepare<{ id: string; at: string }, never>(`
    UPDATE youtube_channels SET last_rss_poll_at = @at WHERE channel_id = @id
  `);

  return {
    upsert(channelId, label): void {
      upsert.run({ id: channelId, label });
    },

    get(channelId): YoutubeChannelRow | undefined {
      const r = selectOne.get({ id: channelId });
      return r === undefined ? undefined : toRow(r);
    },

    list(): YoutubeChannelRow[] {
      return selectAll.all().map(toRow);
    },

    markSeeded(channelId, at): boolean {
      return seed.run({ id: channelId, at }).changes === 1;
    },

    markPolled(channelId, at): void {
      polled.run({ id: channelId, at });
    },
  };
}
