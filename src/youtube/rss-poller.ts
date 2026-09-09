import type { StuckAlert, StuckWatch } from '../live/stuck-watch.js';
import type { Clock, Disposable } from '../runtime/clock.js';
import type { YoutubeChannelRepo } from '../store/repos/youtube-channel-repo.js';
import { parseFeed } from './feed-parse.js';
import type { TextClient } from './http-text.js';
import type { UploadFlow, UploadFlowResult } from './upload-flow.js';

/**
 * RSS 폴백 폴러 — 계획 §5.3 C3 (AC-25 · AC-P4).
 *
 * ★★ **이 폴러가 지는 것은 "누락 0"(AC-25)이지 "1분"(AC-21)이 아니다.**
 *   계획이 정직하게 적으라고 한 문장 그대로다: *"RSS 폴백은 누락 0 을 지키는
 *   장치이지 1분을 지키는 장치가 아니다."* 피드 갱신 자체가 수 분 늦으므로
 *   WebSub 이 죽은 동안 발견된 영상은 1분을 넘겨 공지된다 — **설계된 동작**이고,
 *   폴백 발동률(`detected_via='rss'`)을 WebSub 건강도 지표로 쓴다.
 *
 * ★★ **연속 실패를 스스로 세지 않는다** (AC-P4). 폴 결과를 그대로
 *   `live/stuck-watch.ts` 의 `'rss'` 도메인에 넘긴다. 계획 §S6 표가
 *   *"폴 결과(성공/실패)를 stuck-watch 에 넘길 뿐 스트릭을 스스로 세지 않는다"*
 *   라고 못 박았고, 카운터를 폴 루프에 흩는 것이 §10 시나리오 1 완화책의
 *   정확한 위반 형태다.
 *
 * ★ 실패로 세는 것은 **가져오기·파싱**뿐이다. 발송 실패는 폴의 실패가 아니다 —
 *   그건 아웃박스와 AC-19 의 영역이고, 여기서 함께 세면 디스코드 장애가
 *   "RSS 가 죽었다"로 오진된다.
 *
 * ★ 이그레스·DNS 가 죽으면 RSS 와 WebSub 이 **함께** 죽는다 (계획 §5.3 rev.3).
 *   RSS 는 즉시, WebSub 은 리스 만료 시점에 **지연되어** 죽으므로 처음에는
 *   "RSS 만 고장" 으로 보인다. 그래서 이 폴러 자신의 건강도를 감시한다.
 */

/**
 * 폴 대상 주소.
 *
 * ⚠️ WebSub 토픽(`/xml/feeds/videos.xml`)과 **경로가 다르다.** 둘 다 같은 피드를
 *   주지만 토픽은 허브가 문자열 정확 일치로 비교하는 식별자라 섞으면 안 된다
 *   (`websub-client.ts` 의 `TOPIC_URL_BASE` 주석 참조).
 */
export const YOUTUBE_FEED_URL_BASE = 'https://www.youtube.com/feeds/videos.xml';

/**
 * ★★ 연속 실패 시 폴 간격을 물린다 (실배포 관측, 2026-09-09).
 *
 *   `rssPollSec`(60초) 고정으로 돌던 초판은 상류가 우리를 조이기 시작해도
 *   **같은 속도로 계속 때렸다.** 그날 실측: 첫 실패 02:01 이후 320회 실패가
 *   쌓이는 동안 간격은 정확히 60초를 유지했다. 같은 시각 **휴대폰(다른 IP)에서는
 *   같은 피드가 정상**이었고, 대조군으로 쓴 제3자 채널까지 같은 404 를 받았다 —
 *   즉 채널이 아니라 **우리 IP 가 걸린 것**이고, 고정 간격 폴링이 그 상태를
 *   스스로 연장하고 있었다.
 *
 * ★ 성공하면 **즉시** 기본 간격으로 돌아온다. 천천히 회복하면 상류가 풀린 뒤에도
 *   한참 느린 채로 남아, 그 사이 업로드가 늦게 잡힌다.
 *
 * ★ 상한을 두는 이유: RSS 는 WebSub 이 죽었을 때의 **유일한 폴백**이다. 무한히
 *   물리면 폴백이 사실상 사라진다. 15분이면 AC-24(업로드 공지)의 체감 한계 안이다.
 */
export const RSS_BACKOFF_FACTOR = 2;
export const RSS_BACKOFF_MAX_SEC = 900;

export function feedUrl(channelId: string): string {
  return `${YOUTUBE_FEED_URL_BASE}?channel_id=${encodeURIComponent(channelId)}`;
}

/**
 * 채널 1건의 작업 전체 예산 (§5.6.1).
 *
 * ★ 회당 타임아웃(`rss-poll` 5초)과 별개다. 429 백오프까지 포함해 한 채널이
 *   10초를 넘게 붙잡지 못하게 한다 — 채널 5개면 폴 한 바퀴가 최악 50초이고,
 *   그래야 기본 주기 60초 안에 끝난다.
 */
export const RSS_CHANNEL_BUDGET_MS = 10_000;

export type RssPollOutcome =
  | { ok: true; channelId: string; entries: number; skipped: number; flow: UploadFlowResult }
  | { ok: false; channelId: string; reason: string };

export interface RssPollerOptions {
  http: TextClient;
  flow: UploadFlow;
  channels: YoutubeChannelRepo;
  /** 설정 `youtube.channels` */
  configured: readonly { channelId: string; label: string }[];
  clock: Clock;
  stuck: StuckWatch;
  /** 설정 `youtube.rssPollSec` (기본 60) */
  pollSec: number;
  onAlert?: (a: StuckAlert) => void | Promise<void>;
  onLog?: (message: string, extra?: Record<string, unknown>) => void;
  /** 테스트 주입점 */
  feedUrlFor?: (channelId: string) => string;
}

export interface RssPoller {
  /** 채널 1건. 테스트와 주기 폴이 같은 함수를 탄다 */
  pollOnce(channelId: string): Promise<RssPollOutcome>;
  /** 설정된 채널 전부 */
  pollAll(): Promise<RssPollOutcome[]>;
  /** 주기 폴 시작. 즉시 1회 돌고 그 뒤 `pollSec` 마다 */
  start(): Promise<RssPollOutcome[]>;
  /** 지표 `youtube_rss_fail_streak{channel}` */
  failStreaks(): { channelId: string; streak: number }[];
  stop(): void;
}

export function createRssPoller(opts: RssPollerOptions): RssPoller {
  const { http, flow, channels, clock, stuck } = opts;
  const urlFor = opts.feedUrlFor ?? feedUrl;
  const known = new Map(opts.configured.map((c) => [c.channelId, c.label]));
  let timer: Disposable | undefined;

  const log = (message: string, extra?: Record<string, unknown>): void => {
    try {
      opts.onLog?.(message, extra);
    } catch {
      /* 로그가 폴을 죽이면 안 된다 (Principle 2) */
    }
  };

  /** ★ 여기가 AC-P4 의 전부다 — 관측을 넘기고, 돌아온 발화를 그대로 올린다 */
  async function observe(channelId: string, bad: boolean, at: number): Promise<void> {
    const alert = stuck.observe('rss', channelId, bad, at);
    if (alert === undefined) return;
    try {
      await opts.onAlert?.(alert);
    } catch {
      /* 경보 실패가 폴 루프를 죽이면 안 된다 */
    }
  }

  async function pollOnce(channelId: string): Promise<RssPollOutcome> {
    const label = known.get(channelId);
    if (label === undefined) {
      // 설정에 없는 채널을 폴하지 않는다. 실패로 세지도 않는다 — 배선 실수이지
      // 상류 장애가 아니다.
      return { ok: false, channelId, reason: '설정에 없는 채널' };
    }
    channels.upsert(channelId, label);

    const at = clock.now();
    const r = await http.request('rss-poll', urlFor(channelId), {
      deadlineAt: at + RSS_CHANNEL_BUDGET_MS,
    });

    if (!r.ok) {
      const reason = `${r.kind}: ${r.detail}`;
      await observe(channelId, true, at);
      log('rss 폴 실패', { channelId, reason });
      return { ok: false, channelId, reason };
    }

    // ★ 던지지 않는다. 깨진 XML 은 실패로 **세어** 넘어간다 (feed-parse 머리말).
    const parsed = parseFeed(r.text);
    if (!parsed.ok) {
      const reason = `parse: ${parsed.reason ?? '알 수 없는 형식 오류'}`;
      await observe(channelId, true, at);
      log('rss 피드 파싱 실패', { channelId, reason });
      return { ok: false, channelId, reason };
    }

    await observe(channelId, false, at);
    channels.markPolled(channelId, clock.date().toISOString());

    // ★★ 발견분 **전부**가 WebSub 과 같은 문을 지난다 (AC-25). 종류로 거르지 않고
    //    (AC-22), 키는 `videoId` 단독이며 (AC-23), 이미 푸시로 선점된 것은
    //    여기서 `duplicate` 로 흡수된다.
    const result = await flow.handle(channelId, parsed.entries, 'rss');
    if (parsed.skipped > 0) {
      log('rss 피드에 videoId 가 없는 엔트리가 있습니다', {
        channelId,
        skipped: parsed.skipped,
      });
    }
    return { ok: true, channelId, entries: parsed.entries.length, skipped: parsed.skipped, flow: result };
  }

  async function pollAll(): Promise<RssPollOutcome[]> {
    const out: RssPollOutcome[] = [];
    // ★ 순차로 돈다. 전역 동시성 상한(8)은 `http-budget` 이 이미 지키지만,
    //   채널을 한꺼번에 띄우면 한 바퀴의 최악 지연이 채널 수와 무관해지는 대신
    //   예산 슬롯을 통째로 점유해 인증·라이브 폴이 뒤로 밀린다.
    for (const channelId of known.keys()) {
      out.push(await pollOnce(channelId));
    }
    return out;
  }

  return {
    pollOnce,
    pollAll,

    async start(): Promise<RssPollOutcome[]> {
      const first = await pollAll();
      timer?.dispose();

      // ★ `setInterval` 이 아니라 **자기 재예약**이다. 간격이 매 회 달라지므로
      //   고정 주기 타이머로는 표현할 수 없다.
      let delaySec = opts.pollSec;
      const schedule = (): void => {
        timer?.dispose();
        timer = clock.setTimeout(() => {
          void (async () => {
            const out = await pollAll();
            // ★ 한 채널이라도 성공하면 정상 속도로 돌아온다. 전부 실패할 때만 물린다 —
            //   채널 하나의 일시적 실패가 다른 채널의 감지까지 늦추면 안 된다.
            const anyOk = out.some((o) => o.ok);
            delaySec = anyOk
              ? opts.pollSec
              : Math.min(delaySec * RSS_BACKOFF_FACTOR, RSS_BACKOFF_MAX_SEC);
            schedule();
          })();
        }, delaySec * 1_000);
      };
      schedule();
      return first;
    },

    failStreaks(): { channelId: string; streak: number }[] {
      const now = clock.now();
      return [...known.keys()].map((channelId) => ({
        channelId,
        streak: stuck.value('rss', channelId, now),
      }));
    },

    stop(): void {
      timer?.dispose();
      timer = undefined;
    },
  };
}
