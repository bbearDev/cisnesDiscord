import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { decodeEntities, parseFeed } from '../../src/youtube/feed-parse.js';

/**
 * 계획 §S6 — Atom 피드 파서 (AC-22 · AC-23).
 *
 * ★★ 이 파일이 고정하는 가장 중요한 사실 두 가지:
 *   ① `feed-mixed.xml` 의 네 항목은 **구조적으로 구별 불가능하다** — 종류 분기를
 *      쓸 근거가 애초에 피드에 없다는 것을 테스트가 증명한다 (AC-22).
 *   ② 깨진 XML 에 **던지지 않는다** — 던지면 폴 루프가 끊겨 AC-P4 의 실패 카운트가
 *      성립하지 않는다.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/youtube');

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

describe('parseFeed — feed-mixed.xml (AC-22)', () => {
  const parsed = parseFeed(fixture('feed-mixed.xml'));

  it('네 항목을 전부 읽는다 — 종류로 거르지 않는다', () => {
    expect(parsed.ok).toBe(true);
    expect(parsed.entries.map((e) => e.videoId)).toEqual([
      'LONGFORM001',
      'SHORTS00002',
      'PREMIERE0003',
      'LIVEVOD00004',
    ]);
    expect(parsed.skipped).toBe(0);
  });

  it('★★ 네 항목이 구조적으로 동일하다 — 종류를 가를 필드가 없다', () => {
    // 롱폼·쇼츠·예약공개·라이브다시보기가 **같은 키 집합**을 갖는다.
    // 이것이 AC-22 의 근거다: 구별할 데이터가 없으니 분기를 쓸 수 없다.
    const shapes = parsed.entries.map((e) => Object.keys(e).sort().join(','));
    expect(new Set(shapes).size).toBe(1);
    for (const e of parsed.entries) {
      expect(e.title).not.toBe('');
      expect(e.publishedAt).not.toBe('');
      expect(e.updatedAt).not.toBe('');
      expect(e.channelId).toBe('UCcisnesTest0000000001');
    }
  });

  it('media:group 안의 media:title 이 엔트리 제목을 덮지 않는다', () => {
    expect(parsed.entries[0]?.title).toBe('롱폼 영상 — 40분짜리 합방 다시보기');
  });

  it('피드 수준 title 이 엔트리로 새지 않는다', () => {
    expect(parsed.entries.some((e) => e.title === '시스네 테스트 채널')).toBe(false);
    expect(parsed.channelId).toBe('UCcisnesTest0000000001');
  });
});

describe('parseFeed — 푸시 본문', () => {
  it('push-single.xml — 축약 피드 1건', () => {
    const p = parseFeed(fixture('push-single.xml'));
    expect(p.ok).toBe(true);
    expect(p.entries).toHaveLength(1);
    expect(p.entries[0]).toMatchObject({
      videoId: 'PUSHVIDEO001',
      title: '푸시로 도착한 신규 업로드',
      channelId: 'UCcisnesTest0000000001',
      publishedAt: '2026-09-06T14:00:00+00:00',
      updatedAt: '2026-09-06T14:00:00+00:00',
    });
  });

  it('★ push-title-edited.xml — videoId 는 같고 제목·updated 만 다르다 (AC-23 의 전제)', () => {
    const a = parseFeed(fixture('push-single.xml')).entries[0];
    const b = parseFeed(fixture('push-title-edited.xml')).entries[0];
    expect(a?.videoId).toBe(b?.videoId);
    expect(a?.title).not.toBe(b?.title);
    expect(a?.updatedAt).not.toBe(b?.updatedAt);
    // publishedAt 은 같다 — 임베드 타임스탬프가 수정으로 흔들리지 않는 근거다.
    expect(a?.publishedAt).toBe(b?.publishedAt);
  });
});

describe('parseFeed — feed-15-seed.xml (AC-26)', () => {
  it('15건을 전부 읽는다', () => {
    const p = parseFeed(fixture('feed-15-seed.xml'));
    expect(p.ok).toBe(true);
    expect(p.entries).toHaveLength(15);
    expect(new Set(p.entries.map((e) => e.videoId)).size).toBe(15);
  });
});

describe('parseFeed — 깨진 XML', () => {
  it('★★ feed-broken.xml 에 던지지 않는다. 빈 결과 + 사유를 돌려준다', () => {
    let threw = false;
    let p: ReturnType<typeof parseFeed> | undefined;
    try {
      p = parseFeed(fixture('feed-broken.xml'));
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(p?.ok).toBe(false);
    expect(p?.entries).toEqual([]);
    expect(p?.reason).toMatch(/닫히지 않은/);
  });

  it('★ 잘린 문서에서 반쪽 엔트리를 만들어 내지 않는다', () => {
    // 정규식으로 긁으면 BROKEN000001 이 정상 엔트리로 나온다. 그것이 이 파서가
    // 스택을 쓰는 이유다 — 잘린 문서의 엔트리는 신뢰할 수 없다.
    const p = parseFeed(fixture('feed-broken.xml'));
    expect(p.entries.some((e) => e.videoId === 'BROKEN000001')).toBe(false);
  });

  it.each([
    ['닫는 태그 불일치', '<feed><entry></feeed>'],
    ['여는 태그 없이 닫힘', '</entry>'],
    ['닫히지 않은 주석', '<feed><!-- 끝나지 않음'],
    ['닫히지 않은 CDATA', '<feed><title><![CDATA[abc'],
    ['닫히지 않은 태그', '<feed><entry'],
  ])('%s → ok:false', (_name, xml) => {
    const p = parseFeed(xml);
    expect(p.ok).toBe(false);
    expect(p.entries).toEqual([]);
  });

  it('빈 문자열도 던지지 않는다', () => {
    expect(parseFeed('').ok).toBe(true);
    expect(parseFeed('').entries).toEqual([]);
  });
});

describe('parseFeed — 세부', () => {
  it('yt:videoId 가 없으면 <id>yt:video:…</id> 로 폴백한다', () => {
    const xml = `<feed><entry><id>yt:video:FALLBACK001</id><title>제목</title></entry></feed>`;
    const p = parseFeed(xml);
    expect(p.entries[0]?.videoId).toBe('FALLBACK001');
  });

  it('videoId 를 못 찾은 엔트리는 버리되 센다', () => {
    const xml = `<feed><entry><title>키 없음</title></entry></feed>`;
    const p = parseFeed(xml);
    expect(p.ok).toBe(true);
    expect(p.entries).toEqual([]);
    expect(p.skipped).toBe(1);
  });

  it('빈 요소(<link .../>)가 스택을 어지럽히지 않는다', () => {
    const xml = `<feed><entry><yt:videoId>V1</yt:videoId><link rel="alternate" href="https://x/?a=1&amp;b=2"/></entry></feed>`;
    const p = parseFeed(xml);
    expect(p.ok).toBe(true);
    expect(p.entries[0]?.videoId).toBe('V1');
  });

  it('속성값 안의 > 를 태그 끝으로 읽지 않는다', () => {
    const xml = `<feed><entry><link href="https://x/?q=a>b"/><yt:videoId>V2</yt:videoId></entry></feed>`;
    const p = parseFeed(xml);
    expect(p.ok).toBe(true);
    expect(p.entries[0]?.videoId).toBe('V2');
  });

  it('엔티티를 푼다 — 모르는 참조는 원문을 남긴다', () => {
    expect(decodeEntities('a&amp;b&lt;c&gt;d&quot;e&apos;f')).toBe(`a&b<c>d"e'f`);
    expect(decodeEntities('&#65;&#x42;')).toBe('AB');
    expect(decodeEntities('&nbsp;')).toBe('&nbsp;');
    expect(decodeEntities('&#xD800;')).toBe('&#xD800;');
  });

  it('제목의 엔티티가 풀린 채로 나온다', () => {
    const xml = `<feed><entry><yt:videoId>V3</yt:videoId><title>A &amp; B &lt;라이브&gt;</title></entry></feed>`;
    expect(parseFeed(xml).entries[0]?.title).toBe('A & B <라이브>');
  });

  it('CDATA 안의 & 를 두 번 풀지 않는다', () => {
    const xml = `<feed><entry><yt:videoId>V4</yt:videoId><title><![CDATA[A &amp; B]]></title></entry></feed>`;
    expect(parseFeed(xml).entries[0]?.title).toBe('A &amp; B');
  });

  it('피드 수준 yt:channelId 가 없으면 첫 엔트리의 것을 쓴다', () => {
    const xml = `<feed><entry><yt:videoId>V5</yt:videoId><yt:channelId>UCX</yt:channelId></entry></feed>`;
    expect(parseFeed(xml).channelId).toBe('UCX');
  });
});
