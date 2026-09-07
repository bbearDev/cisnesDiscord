/**
 * 유튜브 Atom 피드 파서 — 계획 §S6 (AC-22 · AC-23).
 *
 * ★★ **영상 종류를 판별하지 않는다** (AC-22).
 *   이 파일에 `duration` · `liveStreamingDetails` · 쇼츠/프리미어 분기가 없는 것은
 *   빠뜨린 게 아니라 **피드에 그 정보가 없기 때문**이다. `feed-mixed.xml` 의 네
 *   항목(롱폼·쇼츠·예약공개·라이브 다시보기)은 구조가 완전히 같다. 종류로 거르려면
 *   Data API 를 따로 불러야 하고, 계획은 그 선행조건(키·할당량)을 지지 않기로 했다.
 *   그래서 여기서 나오는 것은 **모두 공지 대상**이다.
 *
 * ★★ **깨진 XML 에 던지지 않는다.**
 *   던지면 폴 루프가 예외로 끊기고, 그러면 §S6 이 요구한 *"실패를 세어
 *   `stuck-watch` 에 넘긴다"*(AC-P4)가 성립하지 않는다. 파서는 결과값으로만 말한다 —
 *   `ok: false` + 빈 목록이고, 세는 일은 호출부가 한다.
 *
 * ★ 의존성을 늘리지 않는다.
 *   읽어야 하는 것이 요소 다섯 개(`yt:videoId` · `title` · `published` · `updated` ·
 *   `yt:channelId`)뿐이라 XML 라이브러리를 넣을 이유가 없다. 대신 **정규식으로 긁지
 *   않는다** — 정규식은 닫히지 않은 태그를 정상으로 읽어 `feed-broken.xml` 에서
 *   반쪽 엔트리를 만들어 낸다. 여는/닫는 태그를 스택으로 맞추는 최소 스캐너를 쓴다.
 */

export interface FeedEntry {
  /** ★ 멱등 키는 이것 **단독**이다 (AC-23). 제목·`updated` 를 키에 넣지 않는다 */
  videoId: string;
  title: string;
  /** ISO-8601 원문 그대로. 정규화하지 않는다 — 비교에 쓰지 않기 때문이다 */
  publishedAt: string;
  updatedAt: string;
  channelId: string;
}

export interface ParsedFeed {
  /** XML 이 성립했는가. `false` 면 호출부가 폴 실패로 센다 (AC-P4) */
  ok: boolean;
  /** 피드 수준 `yt:channelId`. 없으면 첫 엔트리의 것을 쓴다 */
  channelId: string;
  entries: FeedEntry[];
  /** `ok: false` 의 사유. 로그 한 줄로 원인을 특정할 수 있어야 한다 */
  reason?: string;
  /** `videoId` 가 없어 버린 엔트리 수. 0 이 아니면 피드 형식이 바뀐 것이다 */
  skipped: number;
}

// ══════════════════════════════════════════════════════════════════
//  텍스트
// ══════════════════════════════════════════════════════════════════

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

const ENTITY = /&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g;

/** 아는 것만 푼다. 모르는 참조는 **원문 그대로 남긴다** — 임의로 지우면 제목이 조용히 바뀐다 */
export function decodeEntities(s: string): string {
  return s.replace(ENTITY, (whole: string, name: string) => {
    if (name.startsWith('#')) {
      const hex = name.startsWith('#x') || name.startsWith('#X');
      const n = Number.parseInt(hex ? name.slice(2) : name.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(n) || n < 0 || n > 0x10_ff_ff) return whole;
      // ★ 짝 없는 서로게이트(D800–DFFF)를 만들지 않는다. `String.fromCodePoint` 는
      //   이 범위를 막지 않지만, 그렇게 만들어진 문자열은 UTF-8 로 직렬화될 때
      //   깨진다 — 제목이 로그·디스코드 임베드로 그대로 나가는 자리라 원문을 남긴다.
      if (n >= 0xd8_00 && n <= 0xdf_ff) return whole;
      return String.fromCodePoint(n);
    }
    return NAMED_ENTITIES[name] ?? whole;
  });
}

// ══════════════════════════════════════════════════════════════════
//  스캐너
// ══════════════════════════════════════════════════════════════════

interface Elem {
  name: string;
  text: string;
}

/** 요소 이름으로 허용하는 모양. `yt:videoId` 처럼 접두어가 붙는다 */
const TAG_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*/;

/** `<id>yt:video:XXXX</id>` — `yt:videoId` 가 없는 축약 피드를 위한 폴백 */
const ID_VIDEO = /^yt:video:(.+)$/;

export function parseFeed(xml: string): ParsedFeed {
  const stack: Elem[] = [];
  const entries: FeedEntry[] = [];
  let feedChannelId = '';
  let skipped = 0;

  /** 지금 읽고 있는 `<entry>`. 없으면 undefined */
  let current: Partial<FeedEntry> | undefined;
  /** `<entry>` 를 밀어 넣은 직후의 스택 깊이. 직계 자식 판정에 쓴다 */
  let entryDepth = -1;

  const fail = (reason: string): ParsedFeed => ({
    ok: false,
    channelId: '',
    entries: [],
    reason,
    skipped,
  });

  const addText = (t: string): void => {
    const top = stack[stack.length - 1];
    if (top !== undefined) top.text += t;
  };

  const finishEntry = (): void => {
    const e = current;
    current = undefined;
    entryDepth = -1;
    if (e === undefined) return;
    const videoId = e.videoId ?? '';
    if (videoId === '') {
      // 키가 없으면 선점할 수 없다. 버리되 **센다** — 0 이 아니면 형식이 바뀐 것이다.
      skipped += 1;
      return;
    }
    entries.push({
      videoId,
      title: e.title ?? '',
      publishedAt: e.publishedAt ?? '',
      updatedAt: e.updatedAt ?? '',
      channelId: e.channelId ?? feedChannelId,
    });
  };

  /** 닫힌 요소 하나를 소비한다. 스택은 이미 pop 된 상태다 */
  const consume = (el: Elem): void => {
    const depth = stack.length;
    const text = decodeEntities(el.text).trim();

    if (el.name === 'entry' && current !== undefined && depth === entryDepth - 1) {
      finishEntry();
      return;
    }

    if (current !== undefined && depth === entryDepth) {
      // `<entry>` 의 **직계 자식만** 본다. `media:group` 안의 `media:title` 이나
      // `author` 안의 `name` 이 제목을 덮어쓰지 않게 하는 것이 이 깊이 조건이다.
      switch (el.name) {
        case 'yt:videoId':
          current.videoId = text;
          break;
        case 'yt:channelId':
          current.channelId = text;
          break;
        case 'title':
          current.title = text;
          break;
        case 'published':
          current.publishedAt = text;
          break;
        case 'updated':
          current.updatedAt = text;
          break;
        case 'id': {
          if (current.videoId === undefined) {
            const m = ID_VIDEO.exec(text);
            if (m?.[1] !== undefined) current.videoId = m[1];
          }
          break;
        }
        default:
          break;
      }
      return;
    }

    // 피드 수준 채널 id — 루트의 직계 자식이고 엔트리 밖일 때만.
    if (current === undefined && depth === 1 && el.name === 'yt:channelId') {
      feedChannelId = text;
    }
  };

  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) addText(xml.slice(i, lt));

    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt + 4);
      if (e < 0) return fail('닫히지 않은 주석');
      i = e + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt + 9);
      if (e < 0) return fail('닫히지 않은 CDATA');
      // CDATA 는 엔티티를 풀지 않는다. 나중에 한 번 더 풀리지 않도록 그대로 넣는다.
      addText(xml.slice(lt + 9, e).replace(/&/g, '&amp;'));
      i = e + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const e = xml.indexOf('?>', lt + 2);
      if (e < 0) return fail('닫히지 않은 처리 명령');
      i = e + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      const e = xml.indexOf('>', lt + 2);
      if (e < 0) return fail('닫히지 않은 선언');
      i = e + 1;
      continue;
    }

    // ★ 따옴표 안의 '>' 를 태그 끝으로 읽지 않는다. 피드의 링크에는 쿼리스트링이 붙는다.
    let j = lt + 1;
    let quote = '';
    for (; j < xml.length; j++) {
      const c = xml.charAt(j);
      if (quote !== '') {
        if (c === quote) quote = '';
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        continue;
      }
      if (c === '>') break;
    }
    if (j >= xml.length) return fail('닫히지 않은 태그');

    const raw = xml.slice(lt + 1, j);
    i = j + 1;

    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      const top = stack.pop();
      if (top === undefined) return fail(`여는 태그 없이 닫혔습니다: </${name}>`);
      if (top.name !== name) return fail(`태그가 맞지 않습니다: <${top.name}> ↔ </${name}>`);
      consume(top);
      continue;
    }

    const m = TAG_NAME.exec(raw);
    if (m === null) return fail('태그 이름이 올바르지 않습니다');
    const name = m[0];
    // 빈 요소는 내용이 없다 — 스택에 넣지 않는다.
    if (raw.endsWith('/')) continue;

    stack.push({ name, text: '' });
    if (name === 'entry' && current === undefined) {
      current = {};
      entryDepth = stack.length;
    }
  }

  // ★★ 여기가 `feed-broken.xml` 을 잡는 자리다. 닫히지 않은 요소가 남아 있으면
  //    문서가 잘린 것이고, 잘린 문서에서 읽어낸 엔트리는 **믿을 수 없다.**
  if (stack.length > 0) {
    return fail(`닫히지 않은 요소: <${stack[stack.length - 1]?.name ?? '?'}>`);
  }

  const first = entries[0];
  return {
    ok: true,
    channelId: feedChannelId !== '' ? feedChannelId : (first?.channelId ?? ''),
    entries,
    skipped,
  };
}
