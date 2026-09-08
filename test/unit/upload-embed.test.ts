import { describe, expect, it } from 'vitest';

import {
  UPLOAD_EMBED_COLOR,
  buildUploadEmbedSpec,
  buildUploadPayload,
  thumbnailUrl,
  videoUrl,
} from '../../src/discord/upload-embed.js';
import type { FeedEntry } from '../../src/youtube/feed-parse.js';

const entry = (over: Partial<FeedEntry> = {}): FeedEntry => ({
  videoId: 'kp6ZDCJpGIA',
  title: '까마귀의 드럼 챌린지 #shorts',
  publishedAt: '2026-09-07T11:00:16+00:00',
  updatedAt: '2026-09-07T11:00:16+00:00',
  channelId: 'UC_rXopl6s9UnZwyqfPZtLpg',
  ...over,
});

describe('유튜브 업로드 임베드 — 썸네일', () => {
  it('썸네일 URL 은 videoId 만으로 결정된다 — 피드에서 읽지 않는다', () => {
    expect(thumbnailUrl('kp6ZDCJpGIA')).toBe('https://i.ytimg.com/vi/kp6ZDCJpGIA/hqdefault.jpg');
  });

  /**
   * ★★ 이 테스트가 지키는 것은 화질이 아니라 **존재 보장**이다.
   *
   *   `maxresdefault` 는 HD 업로드에만 있고, 없으면 404 다. 디스코드는 그 404 를
   *   조용히 삼켜 **이미지 자리를 빈 채로** 렌더한다 — "가끔 그림이 안 나오는" 상태가
   *   되고 로그에도 안 남는다. `hqdefault` 는 모든 영상에 항상 있다.
   */
  it('★ maxresdefault 를 쓰지 않는다 — HD 업로드에만 존재해 404 가 난다', () => {
    const u = thumbnailUrl('abc');
    expect(u).toContain('hqdefault');
    expect(u).not.toContain('maxresdefault');
  });

  it('videoId 를 URL 인코딩한다 — 링크와 썸네일이 같은 규칙을 쓴다', () => {
    const odd = 'a/b?c';
    expect(thumbnailUrl(odd)).toContain(encodeURIComponent(odd));
    expect(videoUrl(odd)).toContain(encodeURIComponent(odd));
  });

  it('임베드 spec 에 image 가 실린다', () => {
    expect(buildUploadEmbedSpec(entry(), 'rss').image).toBe(thumbnailUrl('kp6ZDCJpGIA'));
  });

  it('★ 발송 payload 까지 image 가 살아서 간다 — spec 만 채우고 빠뜨리면 안 보인다', () => {
    const p = buildUploadPayload(entry(), 'websub');
    // 디스코드 API 형태는 { url } 객체다. 문자열 그대로 넣으면 무시된다.
    expect(p.embeds?.[0]?.image).toEqual({ url: thumbnailUrl('kp6ZDCJpGIA') });
  });

  it('제목·색·타임스탬프는 그대로다 — 썸네일 추가가 기존 필드를 건드리지 않는다', () => {
    const e = buildUploadPayload(entry(), 'rss').embeds?.[0];
    expect(e?.title).toBe('까마귀의 드럼 챌린지 #shorts');
    expect(e?.url).toBe(videoUrl('kp6ZDCJpGIA'));
    expect(e?.color).toBe(UPLOAD_EMBED_COLOR);
    expect(e?.timestamp).toBe('2026-09-07T11:00:16+00:00');
    expect(e?.footer).toEqual({ text: '감지: rss' });
  });

  /** ★ 쇼츠·프리미어를 구분하지 않는다 (AC-22) — 썸네일 경로도 같다 */
  it('영상 종류를 가리지 않는다 — 제목이 비어도 썸네일은 붙는다', () => {
    const e = buildUploadPayload(entry({ title: '' }), 'rss').embeds?.[0];
    expect(e?.title).toBe('(제목 없음)');
    expect(e?.image).toEqual({ url: thumbnailUrl('kp6ZDCJpGIA') });
  });
});
