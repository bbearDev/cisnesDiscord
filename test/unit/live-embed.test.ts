import { describe, it, expect } from 'vitest';

import { buildAnnouncementEmbed, type EmbedSpec } from '../../src/discord/announcer.js';
import { LiveApiResponseSchema } from '../../src/chzzk/live-api-schema.js';
import { selectChannel } from '../../src/chzzk/live-api-client.js';
import { parseLiveStartedEvent } from '../../src/chzzk/live-event-schema.js';
import {
  buildLiveEmbedSpec,
  CHZZK_LIVE_URL_PREFIX,
  jobFromPoll,
  jobFromWebhook,
  liveAnnounceLabel,
  liveImageSource,
  pickLiveImage,
} from '../../src/live/live-announce.js';
import { judgeLiveState } from '../../src/live/live-state.js';
import { loadJsonFixture } from '../e2e/harness/fake-chzzkbot.js';

/**
 * 라이브 공지 임베드 (계획 §S5).
 *
 * ★★ 이 파일이 지키는 두 문장:
 *   ① **타임스탬프는 `openedAt` 이다.** 수신 시각도 `openDate` 도 아니다.
 *   ② **제목은 웹훅 경로에만 있다.** 폴링 응답에는 그 칸이 구조적으로 없으므로
 *      제목 없는 문안을 따로 둔다.
 */

const OURS = 'c3355ea2b3bea6c646789510796379d6';

describe('★ EmbedSpec 구조 계약 — 레이어 때문에 타입을 나눠 놓은 자리', () => {
  it('buildLiveEmbedSpec 의 결과가 announcer 의 EmbedSpec 으로 그대로 통한다', () => {
    // `live`(L4) 는 `discord`(L7) 를 import 할 수 없어 타입을 따로 선언했다.
    // 두 타입이 갈리면 **이 한 줄이 typecheck 에서 깨진다.**
    const spec: EmbedSpec = buildLiveEmbedSpec({
      channelId: OURS,
      channelName: '시스네',
      liveTitle: '오늘은 잡담방송',
      openedAt: '2026-09-06T18:56:39.000Z',
      detectedVia: 'webhook',
    });
    const embed = buildAnnouncementEmbed(spec);
    expect(embed).toMatchObject({
      title: '오늘은 잡담방송',
      url: `${CHZZK_LIVE_URL_PREFIX}${OURS}`,
      timestamp: '2026-09-06T18:56:39.000Z',
      footer: { text: '감지: webhook' },
    });
  });
});

describe('★★ 타임스탬프는 openedAt 이다', () => {
  it('웹훅 경로 — openedAt 이 그대로 실린다', () => {
    const parsed = parseLiveStartedEvent(loadJsonFixture('chzzkbot/webhook-live-started.json'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const job = jobFromWebhook(parsed.event);
    expect(job.embed.timestamp).toBe(parsed.event.openedAt);
    // ★ openDate 는 임베드 어디에도 나타나지 않는다.
    expect(JSON.stringify(job.embed)).not.toContain(parsed.event.openDate);
  });

  it('폴링 경로 — openedAt 이 그대로 실린다', () => {
    const parsed = LiveApiResponseSchema.parse(loadJsonFixture('chzzkbot/api-live-announce.json'));
    const { target } = selectChannel(parsed, OURS);
    const j = judgeLiveState({ kind: 'channel', channel: target! });
    expect(j.state).toBe('announce');
    if (j.state !== 'announce') return;

    const job = jobFromPoll(j.channel, j.liveHash);
    expect(job.embed.timestamp).toBe('2026-09-06T18:56:39.000Z');
    expect(JSON.stringify(job.embed)).not.toContain('2026-09-07 03:56:39');
  });

  it('★ openedAt 이 없으면 타임스탬프를 아예 싣지 않는다 (수신 시각으로 대신하지 않는다)', () => {
    const spec = buildLiveEmbedSpec({ channelId: OURS, detectedVia: 'api-poll' });
    expect('timestamp' in spec).toBe(false);
    expect(buildAnnouncementEmbed(spec).timestamp).toBeUndefined();
  });
});

describe('★★ 제목이 없는 경로의 문안', () => {
  it('웹훅: liveTitle 이 제목이 된다', () => {
    const spec = buildLiveEmbedSpec({
      channelId: OURS,
      channelName: '시스네',
      liveTitle: '오늘은 잡담방송',
      openedAt: '2026-09-06T18:56:39.000Z',
      detectedVia: 'webhook',
    });
    expect(spec.title).toBe('오늘은 잡담방송');
    expect(spec.description).toContain('시스네');
  });

  it('폴링: 제목 칸이 없으므로 채널 이름으로 된 문안을 쓴다', () => {
    const spec = buildLiveEmbedSpec({
      channelId: OURS,
      channelName: '시스네',
      openedAt: '2026-09-06T18:56:39.000Z',
      detectedVia: 'api-poll',
    });
    expect(spec.title).toBe('시스네 방송이 시작되었습니다');
    // 자리표시자를 쓰지 않는다 — 쓰면 시청자에게 그대로 보인다.
    expect(spec.title).not.toContain('undefined');
    expect(spec.description).not.toContain('undefined');
    expect(spec.description).not.toMatch(/제목\s*(없음|미상)/);
  });

  it('채널 이름조차 없어도 undefined 가 새지 않는다', () => {
    const spec = buildLiveEmbedSpec({ channelId: OURS, detectedVia: 'api-poll' });
    expect(spec.title).not.toContain('undefined');
    expect(spec.description ?? '').not.toContain('undefined');
  });
});

describe('감지 경로 · 라벨 · 링크', () => {
  it('★ detectedVia 가 푸터에 남는다 — api-poll 이 계속 보이면 웹훅이 죽어 있다는 뜻', () => {
    expect(buildAnnouncementEmbed(buildLiveEmbedSpec({ channelId: OURS, detectedVia: 'api-poll' })).footer)
      .toEqual({ text: '감지: api-poll' });
  });

  it('링크는 치지직 라이브 주소다', () => {
    expect(buildLiveEmbedSpec({ channelId: OURS, detectedVia: 'webhook' }).url).toBe(
      `https://chzzk.naver.com/live/${OURS}`,
    );
  });

  it('라벨은 원장 키를 그대로 싣는다', () => {
    expect(liveAnnounceLabel('df09256e')).toBe('live_start df09256e');
    const parsed = parseLiveStartedEvent(loadJsonFixture('chzzkbot/webhook-live-started.json'));
    if (!parsed.ok) throw new Error('픽스처가 계약을 만족하지 않는다');
    expect(jobFromWebhook(parsed.event)).toMatchObject({
      liveHash: 'df09256e',
      detectedVia: 'webhook',
      label: 'live_start df09256e',
    });
  });
});

describe('★★ 방송 썸네일 — 없을 수 있고, 그때 채널 프로필로 내려간다', () => {
  const THUMB = 'https://video-phinf.pstatic.net/live/df09256e/thumbnail_720.jpg';
  const PROFILE = 'https://nng-phinf.pstatic.net/profile/c3355ea2/profile.jpg';

  it('웹훅 경로 — 발송 임베드까지 살아서 간다 (spec 만 채우고 빠뜨리면 안 보인다)', () => {
    const parsed = parseLiveStartedEvent(loadJsonFixture('chzzkbot/webhook-live-started.json'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const job = jobFromWebhook(parsed.event);
    expect(job.embed.image).toBe(THUMB);
    expect(buildAnnouncementEmbed(job.embed).image).toEqual({ url: THUMB });
  });

  it('★ 폴링 경로에도 **같은 이름의 칸**이 실려 온다 (liveTitle 과 다른 점이다)', () => {
    const parsed = LiveApiResponseSchema.parse(loadJsonFixture('chzzkbot/api-live-announce.json'));
    const { target } = selectChannel(parsed, OURS);
    const j = judgeLiveState({ kind: 'channel', channel: target! });
    expect(j.state).toBe('announce');
    if (j.state !== 'announce') return;

    const job = jobFromPoll(j.channel, j.liveHash);
    expect(job.embed.image).toBe(THUMB);
  });

  it('★★ 썸네일이 없으면 채널 프로필이 대신 실린다 — 방송 시작 직후의 정상 상태다', () => {
    const spec = buildLiveEmbedSpec({
      channelId: OURS,
      channelName: '시스네',
      channelImageUrl: PROFILE,
      detectedVia: 'webhook',
    });
    expect(spec.image).toBe(PROFILE);
  });

  it('★ 둘 다 없으면 image 칸 자체를 싣지 않는다 (자리표시자 그림을 넣지 않는다)', () => {
    const spec = buildLiveEmbedSpec({ channelId: OURS, detectedVia: 'webhook' });
    expect('image' in spec).toBe(false);
    expect(buildAnnouncementEmbed(spec).image).toBeUndefined();
  });

  it('★★ 못 쓸 주소는 그림만 버린다 — 공지 자체는 그대로 나간다', () => {
    // image.url 이 URL 로 안 읽히면 디스코드는 **요청 전체**를 400 으로 거절한다.
    // 그림 한 장 때문에 방송 공지가 사라지는 것이 이 검사가 막는 사고다.
    const spec = buildLiveEmbedSpec({
      channelId: OURS,
      channelName: '시스네',
      liveImageUrl: 'not a url at all',
      channelImageUrl: 'ftp://nope.example/pic.jpg',
      detectedVia: 'webhook',
    });
    expect('image' in spec).toBe(false);
    expect(spec.title).toBe('시스네 방송이 시작되었습니다');
    expect(buildAnnouncementEmbed(spec).title).toBe('시스네 방송이 시작되었습니다');
  });

  it('★ 1순위가 못 쓸 주소면 2순위로 내려간다 — 후보를 각각 검사하기 때문이다', () => {
    expect(pickLiveImage({ liveImageUrl: 'javascript:alert(1)', channelImageUrl: PROFILE })).toBe(PROFILE);
  });

  it('자리표시자가 남은 주소는 싣지 않는다 (상류도 막지만 증상이 로그에 안 남는다)', () => {
    expect(pickLiveImage({ liveImageUrl: 'https://video-phinf.pstatic.net/image_{type}.jpg' })).toBeUndefined();
  });

  it('http · https 만 통과시킨다', () => {
    expect(pickLiveImage({ liveImageUrl: 'http://example.com/a.jpg' })).toBe('http://example.com/a.jpg');
    expect(pickLiveImage({ liveImageUrl: 'data:image/png;base64,AAAA' })).toBeUndefined();
    expect(pickLiveImage({})).toBeUndefined();
  });
});

describe('★ 그림이 어디서 왔는지 — none 과 dropped 는 고칠 곳이 다르다', () => {
  const THUMB = 'https://video-phinf.pstatic.net/live/df09256e/thumbnail_720.jpg';
  const PROFILE = 'https://nng-phinf.pstatic.net/profile/c3355ea2/profile.jpg';

  it('썸네일을 썼으면 live', () => {
    expect(liveImageSource({ liveImageUrl: THUMB, channelImageUrl: PROFILE })).toBe('live');
  });

  it('썸네일이 없어 프로필로 내려왔으면 channel', () => {
    expect(liveImageSource({ channelImageUrl: PROFILE })).toBe('channel');
  });

  it('★ 키가 아예 안 왔으면 none — 단, 이 값은 더 못 쪼갠다', () => {
    // 치지직이 안 준 경우와 상류 가드가 버린 경우가 여기서 섞인다.
    // 둘 다 우리에게는 키가 오지 않으므로 구분은 chzzkbot 로그에만 있다 (런북 §8-d).
    expect(liveImageSource({})).toBe('none');
  });

  it('★★ 실려 왔는데 우리가 버렸으면 dropped — 이때만 우리 쪽을 뒤진다', () => {
    expect(liveImageSource({ liveImageUrl: 'ftp://x/y.jpg' })).toBe('dropped');
  });
});
