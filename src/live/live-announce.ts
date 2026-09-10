import type { LiveApiChannel } from '../chzzk/live-api-schema.js';
import type { LiveStartedEvent } from '../chzzk/live-event-schema.js';
import type { AnnouncementLedgerRepo } from '../store/repos/announcement-ledger-repo.js';

/**
 * 라이브 공지의 **내용**과 그 공지가 필요로 하는 **포트** (계획 §S5).
 *
 * ★ 왜 임베드를 여기서 만드는가.
 *   웹훅 라우트(L8)와 폴러(L4)가 같은 공지를 만든다. 문안을 각자 두면
 *   "웹훅으로 온 방송"과 "폴링이 찾은 방송"이 서로 다른 모양으로 나가고,
 *   그건 시청자가 아니라 우리만 아는 구분이다.
 *
 * ★ 이 파일은 L4(live) 라 L7(discord) 을 import 할 수 없다. 그래서
 *   `LiveEmbedFields` 는 `discord/announcer.ts` 의 `EmbedSpec` 과 **구조적으로
 *   같게** 선언한다. 두 타입이 갈리는 것은 테스트가 막는다 —
 *   `const spec: EmbedSpec = buildLiveEmbedSpec(...)` 한 줄이 typecheck 에서 깨진다.
 */

// ══════════════════════════════════════════════════════════════════
//  임베드
// ══════════════════════════════════════════════════════════════════

/** `discord/announcer.ts` 의 `EmbedSpec` 과 구조적으로 같다 (위 머리말 참조) */
export interface LiveEmbedFields {
  title: string;
  url?: string;
  description?: string;
  /** ISO-8601. ★★ **`openedAt` 이다.** 수신 시각도 `openDate` 도 아니다 */
  timestamp?: string;
  color?: number;
  /** 푸터에 작게 적힌다 — `api-poll` 이 계속 보이면 웹훅이 죽어 있다는 뜻이다 */
  detectedVia?: string;
  /** 본문 아래 큰 이미지의 URL. `EmbedSpec.image` 와 같은 칸이다 */
  image?: string;
}

/** 치지직 라이브 주소. 채널 id 를 그대로 붙인다 */
export const CHZZK_LIVE_URL_PREFIX = 'https://chzzk.naver.com/live/';

/** 치지직 초록. 유튜브 공지와 눈으로 구분되게 한다 */
export const LIVE_EMBED_COLOR = 0x00_ff_a3;

/** 채널 이름이 응답에 없을 때 쓰는 이름 */
export const FALLBACK_CHANNEL_NAME = '방송';

/**
 * ★ `'recovery'` 는 US-006(§S7)이 쓴다.
 *
 *   기동 복구는 **폴링과 같은 판정식·같은 임베드**를 쓴다 — 복구 전용 규칙을 따로
 *   두면 두 벌이 되고, 한쪽만 고쳤을 때 갈라진다(계획 §S7). 다른 것은 감지 경로
 *   라벨 하나뿐이며, 그 라벨은 지표 `live_detected_via` 의 축이다.
 */
export type LiveDetectedVia = 'webhook' | 'api-poll' | 'recovery';

export interface LiveEmbedInput {
  channelId: string;
  channelName?: string | undefined;
  /** ★ 웹훅 경로에만 있다. 폴링 응답에는 상류가 싣지 않는다 */
  liveTitle?: string | undefined;
  /**
   * ISO-8601 UTC.
   *
   * ★★ **`openDate` 를 여기에 넣지 않는다.** 시간대 표기 없는 KST 원문이라
   *   서버 시간대로 해석돼 9시간 어긋난다 (계획 §5.1).
   *   없으면 타임스탬프를 **싣지 않는다** — 수신 시각으로 대신하면 임베드가
   *   "방송이 방금 시작됐다"고 거짓말을 한다.
   */
  openedAt?: string | undefined;
  /**
   * 방송 썸네일. **1순위 그림 후보**다 (상류가 실어 보낼 때만 있다).
   *
   * ★ 방송 시작 직후에는 치지직이 아직 썸네일을 안 주기도 한다. 상류는 방송을
   *   인식할 때 한 번만 훑으므로, 그때 없었으면 그 방송은 끝까지 없다.
   */
  liveImageUrl?: string | undefined;
  /** 채널 프로필 이미지. **썸네일이 없을 때의 2순위**다 */
  channelImageUrl?: string | undefined;
  detectedVia: LiveDetectedVia;
}

/**
 * 임베드에 실어도 되는 그림 주소인가.
 *
 * ★★ **이 검사의 목적은 그림이 아니라 공지다.**
 *   `image.url` 이 URL 로 파싱되지 않으면 디스코드는 임베드 하나가 아니라
 *   **요청 전체를 400 으로 거절한다** — 그림 한 장 때문에 방송 공지가 통째로
 *   사라진다. 그림이 빠지는 것은 견딜 수 있고 공지가 사라지는 것은 못 견디므로,
 *   조금이라도 미심쩍으면 **그림만 버린다.**
 *
 * ★★ **세 검사 중 상류와 겹치는 것은 `{` 하나뿐이다** (상류 코드 확인, 2026-09-09).
 *   상류는 `{type}` 을 `720` 으로 **먼저 채운 뒤** 그래도 `{` 가 남았는지**만** 본다 —
 *   URL 로 파싱되는지도, `http(s)` 인지도 보지 않는다. 즉 치지직이 URL 이 아닌
 *   문자열(상대 경로, `"none"` 같은 값)을 주면 **상류를 그대로 통과해 우리에게 온다.**
 *   아래 두 검사는 중복이 아니라 이 계통에서 **유일한** 검사다. 지우지 말 것.
 *
 * ★ 겹치는 `{` 한 줄도 남겨 둔다. 자리표시자가 남은 주소는 어떤 경우에도 그림이
 *   아니라 오탐이 있을 수 없고, 뚫렸을 때의 증상이 하필 *"디스코드가 404 를 조용히
 *   삼켜 빈 자리만 남는"* 것이라 로그로도 안 잡히기 때문이다 (§S6 `maxresdefault` 와
 *   같은 함정).
 */
function usableImageUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  if (url.includes('{') || url.includes('}')) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  return url;
}

/**
 * 실을 그림 하나를 고른다 — **썸네일 → 채널 프로필** 순.
 *
 * ★ 두 후보를 **각각** 검사한다. 썸네일이 이상해서 버려지면 채널 프로필로 내려온다 —
 *   1순위를 고르고 나서 검사하면 그 경우에 그림이 통째로 사라진다.
 */
export interface LiveImageCandidates {
  liveImageUrl?: string | undefined;
  channelImageUrl?: string | undefined;
}

export function pickLiveImage(input: LiveImageCandidates): string | undefined {
  return usableImageUrl(input.liveImageUrl) ?? usableImageUrl(input.channelImageUrl);
}

/** 상류가 주는 그림 칸 이름. 로그에 그대로 찍는다 */
export type LiveImageField = 'liveImageUrl' | 'channelImageUrl';

/**
 * **무엇을 실었나.** `docs/runbook-ops.md` §8-d 의 첫 칸이다.
 *
 * ★★ 이 값은 *"우리 검사가 발동했는가"* 를 **말해 주지 않는다.** 그건 별개 질문이고
 *   `droppedImageFields` 가 답한다. 한 칸에 욱여넣으면 **가장 흔한 사고 모양이
 *   `channel`(= 정상) 로 분류돼 아무도 안 본다** — 썸네일이 못 쓸 값이고 채널 프로필은
 *   멀쩡한 경우가 그것이다. 두 질문을 갈라 두는 이유가 이것 하나다.
 */
export type LiveImageSource =
  | 'live'
  | 'channel'
  | 'none'
  /**
   * ★ **그림 정보 자체가 없는 경로.** 아웃박스 재발송이 유일하다 — 원장·`live_sessions`
   *   어디에도 그림 주소 컬럼이 없어(§8-a: 마이그레이션 `002` 선행) 재조립할 재료가 없다.
   *
   * ★★ 이것을 `none` 으로 뭉치지 않는다. `none` 은 *"상류가 안 보냈다"* 이고 이 값은
   *   *"우리가 안 들고 있다"* 라서, 뭉치면 진단하는 사람이 있지도 않은 상류 사고를
   *   찾으러 간다. 서로 다른 사정을 한 값에 넣지 않는다.
   */
  | 'unavailable';

/** ★ `unavailable` 을 돌려주지 않는다 — 그건 후보 유무의 문제가 아니라 경로의 성질이다 */
export function liveImageSource(input: LiveImageCandidates): LiveImageSource {
  const picked = pickLiveImage(input);
  if (picked === undefined) return 'none';
  return picked === input.liveImageUrl ? 'live' : 'channel';
}

/**
 * **무엇을 버렸나** — 상류가 실어 보냈는데 `usableImageUrl` 이 되돌린 칸들.
 *
 * ★★ 비어 있지 않다는 것은 **그 자체로 "우리 쪽을 뒤져라"** 다. 어떤 그림이 실제로
 *   실렸는지와 무관하다 — 2순위가 받아 줘서 공지가 멀쩡해 보여도, 1순위가 버려졌다는
 *   사실은 치지직 형식이 우리가 아는 모양이 아니라는 뜻이고 그 기록은 **여기에만**
 *   남는다(상류는 `{` 만 보므로 이 값은 상류 로그를 통과한 것이다).
 *
 * ★ 2순위를 안전한 대체로 전제하지 않는다. 상류도 *"채널 프로필에 자리표시자가 없다"* 를
 *   **확인된 사실이 아니라 추정**이라고 적어 뒀다 — 근거의 수준이 썸네일과 같다.
 *   그래서 실제로 쓰지 않은 칸이라도 못 쓸 값이면 그대로 싣는다.
 *
 * ★ `none`(키가 안 옴) 과 "전부 버림" 도 이 값으로 갈린다: 비어 있으면 상류가 안 보낸
 *   것이고, 두 칸이 들어 있으면 우리가 전부 버린 것이다.
 */
export function droppedImageFields(input: LiveImageCandidates): readonly LiveImageField[] {
  const dropped: LiveImageField[] = [];
  if (input.liveImageUrl !== undefined && usableImageUrl(input.liveImageUrl) === undefined) {
    dropped.push('liveImageUrl');
  }
  if (input.channelImageUrl !== undefined && usableImageUrl(input.channelImageUrl) === undefined) {
    dropped.push('channelImageUrl');
  }
  return dropped;
}

/**
 * ★ 제목이 없을 때의 문안을 따로 둔다 (계획 §S5).
 *
 *   폴링 경로에는 `liveTitle` 이 **구조적으로** 없다 — 상류가 의도적으로 싣지
 *   않는다(캐시된 제목은 방송 중 바뀐 제목과 다르기 때문). 그래서 이건 예외
 *   처리가 아니라 **정규 경로 둘 중 하나**이고, "제목 없음" 같은 자리표시자를
 *   쓰면 그 자리표시자가 시청자에게 그대로 보인다.
 */
export function buildLiveEmbedSpec(input: LiveEmbedInput): LiveEmbedFields {
  const name = input.channelName ?? FALLBACK_CHANNEL_NAME;
  const title = input.liveTitle ?? `${name} 방송이 시작되었습니다`;
  const description =
    input.liveTitle === undefined
      ? `${name} 채널이 방송 중입니다. 아래 링크에서 바로 보실 수 있습니다.`
      : `${name} 채널에서 방송이 시작되었습니다.`;
  const image = pickLiveImage(input);

  return {
    title,
    url: `${CHZZK_LIVE_URL_PREFIX}${input.channelId}`,
    description,
    // ★ openedAt 이 없으면 타임스탬프 자체를 뺀다. 대체값을 넣지 않는다.
    ...(input.openedAt === undefined ? {} : { timestamp: input.openedAt }),
    color: LIVE_EMBED_COLOR,
    detectedVia: input.detectedVia,
    // ★ 그림도 같은 규율이다 — 쓸 만한 후보가 없으면 칸 자체를 뺀다.
    //   자리표시자 그림을 넣으면 그게 시청자에게 그대로 보인다.
    ...(image === undefined ? {} : { image }),
  };
}

// ══════════════════════════════════════════════════════════════════
//  공지 작업
// ══════════════════════════════════════════════════════════════════

/**
 * 발송기에 넘기는 한 건.
 *
 * ★ 발송기(`discord/announcer.ts`, L7)를 여기서 부르지 않는다. L4 는 L7 을 모른다.
 *   composition-root 가 `announce` 함수를 꽂는다 — 아웃박스(L1)가 같은 형태다.
 */
export interface LiveAnnounceJob {
  /** 원장 `event_key`. **받은 `liveHash` 그대로** — 우리가 계산하지 않는다 */
  liveHash: string;
  detectedVia: LiveDetectedVia;
  embed: LiveEmbedFields;
  /** 로그·경보 문구용. 예: `live_start df09256e` */
  label: string;
  /**
   * ★★ 웹훅을 **받은 시각**(epoch ms). 웹훅 경로에만 있다.
   *
   *   지표 `live_webhook_to_post_ms` 의 시작점이고, 그것이 곧 **AC-15 의 판정
   *   축**이다(§2). 라우트에서 재서 여기 실어 보내는 이유는 발송이 **비동기**라
   *   그렇다 — 라우트는 2xx 를 먼저 돌려주고 나가므로, 게시가 끝나는 시각을
   *   아는 쪽은 발송 경로뿐이다. 두 시각이 다른 모듈에 있으니 하나를 실어 보낼
   *   수밖에 없다.
   *
   * ★ 폴링·복구 경로에는 **없다.** 웹훅을 받은 적이 없으니 시작점이 없고,
   *   그 자리에 폴 시각을 넣으면 AC-15 가 *"우리가 늦게 물어본 시간"* 을
   *   자기 지연으로 세게 된다.
   */
  webhookReceivedAtMs?: number | undefined;
  /**
   * `openedAt`(ISO-8601 UTC). 지표 `live_opened_to_post_ms` 의 시작점.
   *
   * ★ **관측 전용이다 — 합격 판정에 쓰지 않는다** (§2). 임베드에도 같은 값이
   *   들어가지만 거기서 다시 꺼내 쓰지 않는다. 임베드는 사람이 읽는 표시이고
   *   이 칸은 기계가 읽는 축이라, 한쪽 문안이 바뀌면 다른 쪽이 조용히 망가진다.
   */
  openedAt?: string | undefined;
  /**
   * 임베드에 **무엇을 실었나** (`live` · `channel` · `none`).
   *
   * ★ 공지 발송 지점에서 로그로 남는다. 웹훅·폴링·기동복구 **세 경로가 전부** 이 구조체를
   *   지나므로, 관측을 여기 실으면 경로마다 배선을 따로 하지 않아도 된다 — 특히 기동
   *   복구에는 이벤트 채널 자체가 없어서 다른 방법이 없다.
   */
  imageSource: LiveImageSource;
  /**
   * **무엇을 버렸나.** 비어 있으면 아예 싣지 않는다.
   *
   * ★★ 이 칸이 보이면 **그것만으로 우리 쪽을 뒤질 이유**다. `imageSource` 가 무엇이든
   *   상관없다 — 2순위가 받아 줘서 공지가 멀쩡해 보이는 경우가 오히려 흔하다.
   */
  droppedImageFields?: readonly LiveImageField[] | undefined;
}

/** **절대 reject 하지 않는다** (계약상 `announcer` 가 그렇게 만들어져 있다) */
export type LiveAnnounceFn = (job: LiveAnnounceJob) => Promise<void>;

export function liveAnnounceLabel(liveHash: string): string {
  return `live_start ${liveHash}`;
}

/**
 * 그림 관측 두 칸을 만든다.
 *
 * ★ 두 빌더가 이 함수를 공유한다. 각자 적으면 한쪽 경로만 고친 날 **폴링으로 온 방송의
 *   그림 사고가 조용해진다** — 하필 폴링이 도는 상황은 웹훅이 죽어 있을 때다.
 */
function liveImageObservation(
  input: LiveImageCandidates,
): Pick<LiveAnnounceJob, 'imageSource' | 'droppedImageFields'> {
  const dropped = droppedImageFields(input);
  return {
    imageSource: liveImageSource(input),
    // 비어 있으면 칸을 싣지 않는다 — 로그 줄에 `imageDropped: []` 가 늘 떠 있으면
    // 그게 신호였다는 사실이 흐려진다.
    ...(dropped.length === 0 ? {} : { droppedImageFields: dropped }),
  };
}

/**
 * @param receivedAtMs 웹훅을 받은 시각(epoch ms). **AC-15 의 판정 축**을 여는 값이다
 */
export function jobFromWebhook(
  event: LiveStartedEvent,
  receivedAtMs?: number,
): LiveAnnounceJob {
  return {
    liveHash: event.liveHash,
    detectedVia: 'webhook',
    embed: buildLiveEmbedSpec({
      channelId: event.channelId,
      channelName: event.channelName,
      liveTitle: event.liveTitle,
      openedAt: event.openedAt,
      liveImageUrl: event.liveImageUrl,
      channelImageUrl: event.channelImageUrl,
      detectedVia: 'webhook',
    }),
    label: liveAnnounceLabel(event.liveHash),
    ...(receivedAtMs === undefined ? {} : { webhookReceivedAtMs: receivedAtMs }),
    openedAt: event.openedAt,
    ...liveImageObservation(event),
  };
}

/**
 * 조회 응답에서 공지 작업을 만든다.
 *
 * ★ `via` 로 **주기 폴링(`api-poll`)과 기동 복구(`recovery`)가 같은 함수를 쓴다.**
 *   둘은 감지 경로 라벨만 다르고 판정·임베드가 같다 — 복구 전용 빌더를 따로 두면
 *   "폴링 임베드만 고치고 복구 임베드는 낡은" 상태가 생긴다.
 */
export function jobFromPoll(
  channel: LiveApiChannel,
  liveHash: string,
  via: Extract<LiveDetectedVia, 'api-poll' | 'recovery'> = 'api-poll',
): LiveAnnounceJob {
  return {
    liveHash,
    detectedVia: via,
    embed: buildLiveEmbedSpec({
      channelId: channel.channelId,
      channelName: channel.channelName,
      // ★ liveTitle 을 넘기지 않는다 — 폴링 응답에는 그 칸이 없다.
      //   그림은 다르다: 두 칸 다 폴링 응답에도 **같은 이름으로** 실려 온다.
      openedAt: channel.openedAt,
      liveImageUrl: channel.liveImageUrl,
      channelImageUrl: channel.channelImageUrl,
      detectedVia: via,
    }),
    label: liveAnnounceLabel(liveHash),
    // ★ `webhookReceivedAtMs` 는 넣지 않는다 — 이 경로에는 웹훅이 없다.
    //   `openedAt` 은 관측 전용 지표라 경로를 가리지 않는다.
    openedAt: channel.openedAt,
    ...liveImageObservation(channel),
  };
}

/** 아웃박스가 다시 집은 라이브 한 건. `live_sessions` 에 남아 있는 것만 되살린다 */
export interface OutboxLiveInput {
  channelId: string;
  liveHash: string;
  /** 원래 감지 경로. 재발송이라고 바꾸지 않는다 — 그 방송을 무엇이 찾았는지가 사실이다 */
  detectedVia: LiveDetectedVia;
  liveTitle?: string | undefined;
  openedAt?: string | undefined;
}

/**
 * 아웃박스 재발송용 공지 작업 (§S3 FM5).
 *
 * ★★ **`imageSource` 가 `'unavailable'` 인 유일한 자리다.** 그림 주소를 저장하는 컬럼이
 *   `live_sessions` 에 없어(§8-a) 재조립할 재료가 없다. 여기에 `'none'` 을 적으면
 *   *"상류가 안 보냈다"* 와 뭉쳐서, 진단하는 사람이 **있지도 않은 상류 사고를 찾으러
 *   간다.** 그 오진은 로그에 아무 흔적도 남기지 않는다.
 *
 * ★ 이 함수가 존재하는 이유가 그것이다 — composition-root 에서 손으로 적은 리터럴이면
 *   타입 검사는 칸이 빠진 것만 잡고 **값이 틀린 것은 못 잡는다.** 다른 두 빌더와 같은
 *   자리에 두고 테스트로 못 박는다.
 *
 * ★ `webhookReceivedAtMs` · `openedAt` 을 작업에 싣지 않는다 — 둘 다 지연 지표의
 *   시작점이고, 재발송의 게시 시각을 원래 방송 시작 시각과 재면 그 지표가
 *   *"우리가 늦게 보낸 시간"* 을 방송 지연으로 센다. 임베드 타임스탬프에는 그대로 들어간다.
 */
export function jobFromOutbox(input: OutboxLiveInput): LiveAnnounceJob {
  return {
    liveHash: input.liveHash,
    detectedVia: input.detectedVia,
    embed: buildLiveEmbedSpec({
      channelId: input.channelId,
      liveTitle: input.liveTitle,
      openedAt: input.openedAt,
      detectedVia: input.detectedVia,
    }),
    label: liveAnnounceLabel(input.liveHash),
    imageSource: 'unavailable',
  };
}

// ══════════════════════════════════════════════════════════════════
//  포트
// ══════════════════════════════════════════════════════════════════

/**
 * 원장에서 우리가 쓰는 부분만.
 *
 * ★ 실제 저장소 타입에서 `Pick` 으로 뜬다. 손으로 다시 적으면 시그니처가 갈리는
 *   날 컴파일이 통과해 버리고, 그 자리가 하필 "공지를 선점하려던 순간"이다.
 */
export type LiveLedger = Pick<AnnouncementLedgerRepo, 'claim'>;

/** 세션 행 한 건 — `live_sessions` 컬럼과 1:1 이다 */
export interface LiveSessionRecord {
  liveHash: string;
  openDate: string;
  openedAt: string;
  liveTitle?: string | undefined;
  liveId?: string | undefined;
  categoryValue?: string | undefined;
  status: string;
}

/**
 * **이미 끝난 방송인가** — 아웃박스가 회수한 `live_start` 행을 보내도 되는지의 판정.
 *
 * ★★ 라이브 공지는 **시점이 곧 내용이다.** *"방송이 시작되었습니다"* 는 지금 켜져
 *   있다는 뜻이고, 끝난 뒤에 나가면 늦은 공지가 아니라 **거짓 공지**가 된다.
 *   그래서 업로드와 규칙이 다르다 — 업로드는 늦어도 "이 영상이 올라왔다" 가 참이다.
 *
 * ★ 이것은 §S7 이 그은 선의 **나머지 절반**이다. 기동 복구는 *"진행 중인 방송은
 *   현재 사실이므로 생략하지 않는다"* 고 했다. 그 문장의 대우가 여기다 —
 *   현재 사실이 아니게 된 방송은 공지 대상이 아니다.
 *
 * ★ 세션 행이 없으면 **보낸다**(`false`). 세션은 공지의 전제가 아니고(기록 실패가
 *   공지를 막지 않는다), 모르는 것을 종료로 치면 멀쩡한 공지가 사라진다.
 */
export function isEndedLiveResend(
  session: { status?: string | undefined; closedAt?: string | undefined } | undefined,
): boolean {
  if (session === undefined) return false;
  return session.status === 'ended' || session.closedAt !== undefined;
}

/**
 * `live_sessions` 포트.
 *
 * ★ 저장소 구현은 US-007 composition-root 가 꽂는다. 여기서 인터페이스로 두는
 *   이유는 **`ended` 의 용도가 두 가지뿐**이기 때문이다 (계획 §5.1):
 *   `live_sessions.status` 갱신과 AC-31 판정. 공지는 만들지 않는다.
 *
 * ★ `closeOpen` 이 채널을 받지 않는 이유: `live_sessions` 에는 `channel_id` 컬럼이
 *   없다(§8 스키마). 우리 대상 채널은 단수(`live.channelId`)이므로 "열려 있는
 *   세션"과 "그 채널의 열려 있는 세션"이 같다. 다채널은 Non-Goal 이다.
 */
export interface LiveSessionStore {
  /** `announce` — 신원이 확정된 세션을 기록한다 (이미 있으면 갱신) */
  record(session: LiveSessionRecord, at: string): void;
  /** `ended` — 아직 닫히지 않은 세션을 닫는다. 닫은 행 수를 돌려준다 */
  closeOpen(at: string): number;
}
