import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseLiveStartedEvent } from '../../src/chzzk/live-event-schema.js';
import { jobFromWebhook } from '../../src/live/live-announce.js';

/**
 * ★★ **`openDate` 를 `new Date()` 에 넣지 않는다** — 회귀 고정 (계획 §5.1).
 *
 * `openDate` 는 시간대 표기가 **없는** 치지직 KST 원문이다(`"2026-09-07 03:56:39"`).
 * node 는 이 값을 파싱해 주지만 **서버 로컬 시간대로 해석한다.** UTC 로 도는
 * 호스트에서는 9시간 어긋난 시각이 임베드에 실리고, 그것도 조용히 실린다 —
 * 예외가 없으므로 아무도 모른다.
 *
 * **시각 계산은 `openedAt`, 신원·중복 판정은 `openDate`/`liveHash`.**
 *
 * 이 테스트는 두 층에서 고정한다:
 *   ① 소스 수준 — `new Date(...)` / `Date.parse(...)` 의 인자에 `openDate` 가 없다
 *   ② 동작 수준 — 임베드 타임스탬프가 `openedAt` 과 정확히 같다
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * 주석을 지운다.
 *
 * ★ 지우지 않으면 **이 규율을 설명한 주석 자체가 위반으로 잡힌다.**
 *   (`live-announce.ts` 머리말이 정확히 "openDate 를 new Date 에 넣지 않는다" 라고 적고 있다)
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

const DATE_WITH_OPENDATE =
  /(?:new\s+Date\s*\(|Date\s*\.\s*parse\s*\()[^)]*\bopen_?[Dd]ate\b/;

describe('★★ openDate 를 시각으로 해석하지 않는다 (소스 수준)', () => {
  const files = walk(SRC);

  it('src 아래 파일을 실제로 훑는다 (스캔 자체가 비어 있으면 이 테스트는 아무것도 안 한다)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('★ new Date(...) / Date.parse(...) 의 인자에 openDate 가 들어간 곳이 없다', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf-8'));
      for (const [i, line] of code.split('\n').entries()) {
        if (DATE_WITH_OPENDATE.test(line)) {
          offenders.push(`${file}:${String(i + 1)} — ${line.trim()}`);
        }
      }
      // 줄바꿈을 넘겨 쓴 경우도 잡는다.
      if (DATE_WITH_OPENDATE.test(code.replace(/\s+/g, ' '))) {
        offenders.push(`${file} (여러 줄에 걸침)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('그물이 실제로 작동한다 — 위반 표본을 넣으면 잡힌다', () => {
    // 그물이 아무것도 못 잡는 정규식이면 위 테스트는 영원히 초록이다.
    for (const sample of [
      'const t = new Date(channel.openDate);',
      'const t = new Date(event.openDate).toISOString();',
      'const ms = Date.parse(row.open_date);',
      'const t = new Date(\n  session.openDate,\n);',
    ]) {
      expect(DATE_WITH_OPENDATE.test(stripComments(sample).replace(/\s+/g, ' '))).toBe(true);
    }
    // 정상 사용은 잡지 않는다.
    for (const ok of [
      'const t = new Date(event.openedAt);',
      'const t = new Date(at).toISOString();',
      "const label = `${openDate} 시작`;",
    ]) {
      expect(DATE_WITH_OPENDATE.test(stripComments(ok).replace(/\s+/g, ' ')), ok).toBe(false);
    }
  });
});

describe('★ openDate 를 시각으로 해석하지 않는다 (동작 수준)', () => {
  it('임베드 타임스탬프는 openedAt 과 정확히 같다 — openDate 로 만든 값과 다르다', () => {
    const parsed = parseLiveStartedEvent({
      event: 'live.started',
      version: 1,
      channelId: 'c3355ea2b3bea6c646789510796379d6',
      // KST 03:56:39 == UTC 18:56:39 (전날). 두 값이 **9시간** 차이 난다.
      openDate: '2026-09-07 03:56:39',
      openedAt: '2026-09-06T18:56:39.000Z',
      liveHash: 'df09256e',
      detectedAt: '2026-09-06T18:57:31.000Z',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const job = jobFromWebhook(parsed.event);
    expect(job.embed.timestamp).toBe('2026-09-06T18:56:39.000Z');

    // ★ openDate 를 그냥 Date 에 넣으면 **프로세스 시간대에 따라 값이 달라진다.**
    //   그 사실 자체가 이 규율의 근거다. KST(+09:00) 호스트에서만 우연히 맞고,
    //   운영 호스트가 UTC 면 9시간 어긋난다.
    const naive = new Date(parsed.event.openDate).toISOString();
    const localOffsetMin = -new Date('2026-09-07T00:00:00Z').getTimezoneOffset();
    if (localOffsetMin === 540) {
      // 이 머신이 마침 KST 다 — 우연히 같아진다. 그 우연이 곧 함정이다.
      expect(naive).toBe(job.embed.timestamp);
    } else {
      expect(job.embed.timestamp).not.toBe(naive);
    }
    // 우리 값은 시간대와 무관하게 항상 openedAt 이다.
    expect(job.embed.timestamp).toBe(parsed.event.openedAt);
  });
});
