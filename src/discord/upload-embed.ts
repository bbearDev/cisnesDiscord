import type { DetectedVia } from '../store/repos/announcement-ledger-repo.js';
import type { FeedEntry } from '../youtube/feed-parse.js';
import { buildAnnouncementEmbed, type EmbedSpec } from './announcer.js';
import type { SendPayload } from './client.js';

/**
 * 유튜브 업로드 공지 임베드 — 계획 §S6.
 *
 * ★ 왜 `youtube/` 가 아니라 여기 있는가.
 *   임베드는 디스코드(L7)의 표현 형식이고 `youtube`(L5)는 그 위를 import 할 수 없다.
 *   레이어 규칙이 이 배치를 강제한다 — 그래서 `upload-flow.ts` 는 발송을
 *   **함수 포트로 주입받고** composition-root 가 이 파일을 그 자리에 꽂는다.
 *
 * ★★ **영상 종류로 문안을 가르지 않는다** (AC-22). 쇼츠·프리미어·라이브 다시보기를
 *   구분하려면 피드에 없는 정보를 별도 API 로 가져와야 한다. 네 종류가 같은 문안을
 *   쓰는 것은 타협이 아니라 **가진 정보의 정확한 반영**이다.
 *
 * ★ 타임스탬프는 `publishedAt` 이다 — `updatedAt` 이 아니다.
 *   제목 수정 재푸시가 와도 공지는 1건뿐이지만(AC-23), 만약 `updatedAt` 을 썼다면
 *   그 1건의 시각이 "언제 올라왔나"가 아니라 "언제 마지막으로 손댔나"가 된다.
 *   라이브 공지가 `openedAt` 을 쓰는 것과 같은 이유다 (§S5).
 */

/** 유튜브 브랜드 레드. 라이브 공지와 눈으로 구분되는 것이 목적이다 */
export const UPLOAD_EMBED_COLOR = 0xff_00_00;

export function videoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

/**
 * 영상 썸네일 URL. `videoId` 만으로 결정된다 — 피드에서 따로 읽지 않는다.
 *
 * ★★ **`hqdefault` 를 쓴다. `maxresdefault` 가 아니다.**
 *   `maxresdefault` 는 **HD 로 업로드된 영상에만 존재**하고, 없으면 404 다.
 *   디스코드는 그 404 를 조용히 삼켜 **이미지 자리를 빈 채로** 렌더한다 —
 *   즉 "가끔 그림이 안 나오는" 상태가 되고, 그게 왜 그런지는 로그에도 안 남는다.
 *   `hqdefault`(480×360)는 모든 영상에 항상 있고 임베드 폭에도 충분하다.
 *
 * ★ 쇼츠도 같은 경로를 쓴다 (AC-22 — 영상 종류로 갈라 다루지 않는다).
 */
export function thumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
}

/** 제목이 비어 있을 때의 문안. 빈 제목 임베드는 디스코드가 거절한다 */
export const UNTITLED = '(제목 없음)';

export function buildUploadEmbedSpec(entry: FeedEntry, detectedVia: DetectedVia): EmbedSpec {
  return {
    title: entry.title === '' ? UNTITLED : entry.title,
    url: videoUrl(entry.videoId),
    color: UPLOAD_EMBED_COLOR,
    ...(entry.publishedAt === '' ? {} : { timestamp: entry.publishedAt }),
    image: thumbnailUrl(entry.videoId),
    // ★ 감지 경로를 푸터에 남긴다 — `rss` 가 계속 보이면 WebSub 이 죽어 있다는 뜻이고,
    //   사람이 지표를 안 봐도 눈으로 알아챈다 (계획 §11).
    detectedVia,
  };
}

export function buildUploadPayload(entry: FeedEntry, detectedVia: DetectedVia): SendPayload {
  return { embeds: [buildAnnouncementEmbed(buildUploadEmbedSpec(entry, detectedVia))] };
}

/** 로그·경보 문구에 쓰는 사람이 읽는 이름 */
export function uploadLabel(entry: FeedEntry): string {
  return `youtube_upload ${entry.videoId}`;
}
