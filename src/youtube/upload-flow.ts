import type { Clock } from '../runtime/clock.js';
import type {
  AnnouncementLedgerRepo,
  DetectedVia,
} from '../store/repos/announcement-ledger-repo.js';
import type { YoutubeChannelRepo } from '../store/repos/youtube-channel-repo.js';
import type { FeedEntry } from './feed-parse.js';

/**
 * 업로드 처리 — **WebSub 푸시와 RSS 폴백이 지나는 같은 문** (계획 §5.3 · AC-23~26).
 *
 * ★★ 두 경로가 이 한 함수를 공유하는 것이 핵심이다.
 *   계획이 못 박은 중복 흡수 지점은 `claim(kind='youtube_upload', eventKey=videoId)`
 *   **하나**다. 경로별로 선점 코드를 따로 쓰면 그 둘이 갈리는 날 같은 영상이 두 번
 *   나간다 — 되돌릴 수 없는 종류의 오류(§3-a 3위)다.
 *
 * ★★ 역할 분담을 코드가 아니라 **주석으로 정직하게 남긴다**:
 *   **WebSub 이 지연(AC-21)을, RSS 가 누락 0(AC-25)을 진다.**
 *   RSS 폴백은 "1분"을 지키는 장치가 아니다. WebSub 이 죽은 동안 발견된 영상은
 *   1분을 넘겨 공지될 수 있고 **그것은 설계된 동작이다.** 두 경로의 차이는
 *   `detected_via` 뿐이고, 그 라벨이 곧 WebSub 건강도 지표가 된다.
 *
 * ★★ **영상 종류로 거르지 않는다** (AC-22). 이 파일에 필터 분기가 없는 것은
 *   피드에 종류가 없기 때문이다 — `feed-parse.ts` 머리말 참조.
 *
 * ★★ **발송 실패에 원장 행을 지우지 않는다** (계획 §5.3). 재시도는 아웃박스가
 *   담당하고, 지우면 폴백이 같은 영상을 재선점해 **중복**이 난다.
 */

/** 공지 한 건의 결과. `discord/announcer.ts` 를 감싼 것을 composition-root 가 꽂는다 */
export type UploadSendResult = { ok: true; messageId: string } | { ok: false; reason: string };

/**
 * 실제 발송 포트.
 *
 * ★ 함수로 주입받는 이유: `youtube`(L5)는 `discord`(L7)를 import 할 수 없다.
 *   임베드 조립은 `discord/upload-embed.ts` 가, 배선은 composition-root 가 한다.
 */
export type UploadSender = (entry: FeedEntry, detectedVia: DetectedVia) => Promise<UploadSendResult>;

export interface UploadFlowResult {
  /** AC-26 시딩으로 선점만 한 건수. 이 값이 0 이 아니면 공지는 반드시 0 이다 */
  seeded: number;
  /** 이번에 선점에 성공한 건수 */
  claimed: number;
  /** 발송까지 성공한 건수 */
  announced: number;
  /** 이미 다른 경로가 선점하고 있던 건수 (= 중복 흡수) */
  duplicate: number;
  /** 선점은 했으나 발송에 실패한 건수. 행은 남아 아웃박스가 회수한다 */
  failed: number;
  /** 설정에 없는 채널이라 아무것도 하지 않았다 */
  unknownChannel: boolean;
}

export interface UploadFlowEvent {
  channelId: string;
  videoId: string;
  detectedVia: DetectedVia;
  outcome: 'seeded' | 'announced' | 'duplicate' | 'failed';
  reason?: string;
}

export interface UploadFlowOptions {
  ledger: AnnouncementLedgerRepo;
  channels: YoutubeChannelRepo;
  clock: Clock;
  send: UploadSender;
  /** 진단·지표. 던지면 안 된다 */
  onEvent?: (e: UploadFlowEvent) => void;
}

export interface UploadFlow {
  /**
   * 발견분 전부를 같은 문으로 통과시킨다.
   *
   * @param detectedVia `'websub'`(푸시) 또는 `'rss'`(폴백). 시딩은 내부에서 `'seed'` 로 바꾼다
   */
  handle(
    channelId: string,
    entries: readonly FeedEntry[],
    detectedVia: Extract<DetectedVia, 'websub' | 'rss'>,
  ): Promise<UploadFlowResult>;
}

const EMPTY: UploadFlowResult = {
  seeded: 0,
  claimed: 0,
  announced: 0,
  duplicate: 0,
  failed: 0,
  unknownChannel: false,
};

export function createUploadFlow(opts: UploadFlowOptions): UploadFlow {
  const { ledger, channels, clock, send } = opts;

  const emit = (e: UploadFlowEvent): void => {
    try {
      opts.onEvent?.(e);
    } catch {
      /* 진단이 공지를 죽이면 안 된다 (Principle 2) */
    }
  };

  return {
    async handle(channelId, entries, detectedVia): Promise<UploadFlowResult> {
      const channel = channels.get(channelId);
      if (channel === undefined) {
        // 설정에 없는 채널이다. 선점하면 나중에 그 채널을 추가했을 때
        // 첫 업로드가 "이미 선점됨"으로 사라진다.
        return { ...EMPTY, unknownChannel: true };
      }

      const at = clock.date().toISOString();

      // ── AC-26 최초 시딩 ────────────────────────────────────────────
      // ★ `seeded_at` 이 판정이다. **채널당 한 번뿐**이고, 그 한 번을
      //   `markSeeded` 의 `WHERE seeded_at IS NULL` 이 강제한다.
      if (channel.seededAt === undefined) {
        let seeded = 0;
        for (const e of entries) {
          // ★ 선점만 한다. 발송하지 않는다 — 그것이 AC-26 의 전부다.
          //   `seeded=1` 은 스키마 CHECK 상 `kind='youtube_upload'` 에서만 legal 하다.
          if (ledger.claim('youtube_upload', e.videoId, at, 'seed', { seeded: true })) {
            seeded += 1;
            emit({ channelId, videoId: e.videoId, detectedVia: 'seed', outcome: 'seeded' });
          }
        }
        channels.markSeeded(channelId, at);
        return { ...EMPTY, seeded };
      }

      // ── 통상 경로 ─────────────────────────────────────────────────
      let claimed = 0;
      let announced = 0;
      let duplicate = 0;
      let failed = 0;

      for (const e of entries) {
        // ★★ 멱등 키는 `videoId` **단독**이다 (AC-23). 제목·설명·`updated` 를 넣으면
        //   WebSub 이 제목 수정마다 푸시하므로 **수정 1회당 새 공지**가 나간다.
        //   그리고 이 원장은 SQLite 에 있으므로 재기동해도 판정이 그대로다 (AC-24).
        if (!ledger.claim('youtube_upload', e.videoId, at, detectedVia)) {
          duplicate += 1;
          emit({ channelId, videoId: e.videoId, detectedVia, outcome: 'duplicate' });
          continue;
        }
        claimed += 1;

        const r = await send(e, detectedVia);
        if (r.ok) {
          ledger.markSent('youtube_upload', e.videoId, r.messageId, clock.date().toISOString());
          announced += 1;
          emit({ channelId, videoId: e.videoId, detectedVia, outcome: 'announced' });
          continue;
        }

        // ★★ 지우지 않는다. 아웃박스가 이 행을 회수해 다시 보낸다.
        ledger.markFailed('youtube_upload', e.videoId, r.reason, clock.date().toISOString());
        failed += 1;
        emit({
          channelId,
          videoId: e.videoId,
          detectedVia,
          outcome: 'failed',
          reason: r.reason,
        });
      }

      return { seeded: 0, claimed, announced, duplicate, failed, unknownChannel: false };
    },
  };
}
