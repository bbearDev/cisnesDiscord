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
