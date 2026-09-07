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
  detectedVia: LiveDetectedVia;
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

  return {
    title,
    url: `${CHZZK_LIVE_URL_PREFIX}${input.channelId}`,
    description,
    // ★ openedAt 이 없으면 타임스탬프 자체를 뺀다. 대체값을 넣지 않는다.
    ...(input.openedAt === undefined ? {} : { timestamp: input.openedAt }),
    color: LIVE_EMBED_COLOR,
    detectedVia: input.detectedVia,
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
}

/** **절대 reject 하지 않는다** (계약상 `announcer` 가 그렇게 만들어져 있다) */
export type LiveAnnounceFn = (job: LiveAnnounceJob) => Promise<void>;

export function liveAnnounceLabel(liveHash: string): string {
  return `live_start ${liveHash}`;
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
      detectedVia: 'webhook',
    }),
    label: liveAnnounceLabel(event.liveHash),
    ...(receivedAtMs === undefined ? {} : { webhookReceivedAtMs: receivedAtMs }),
    openedAt: event.openedAt,
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
      openedAt: channel.openedAt,
      detectedVia: via,
    }),
    label: liveAnnounceLabel(liveHash),
    // ★ `webhookReceivedAtMs` 는 넣지 않는다 — 이 경로에는 웹훅이 없다.
    //   `openedAt` 은 관측 전용 지표라 경로를 가리지 않는다.
    openedAt: channel.openedAt,
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
