// 출처: chzzkbot src/web/live-api.ts 의 라우트 계약(경로·헤더 이름·응답 모양)과
//       src/chzzk/http-client.ts 의 "실패를 던지지 않고 값으로 돌려준다" 규율 (계획 §14)
import type { HttpBudget } from '../runtime/http-budget.js';
import {
  LIVE_API_VERSION,
  LiveApiResponseSchema,
  type LiveApiChannel,
  type LiveApiFailure,
  type LiveApiResponse,
} from './live-api-schema.js';

/**
 * `GET /api/live` 클라이언트 — cisnesDiscord 가 chzzkbot 을 부르는 **유일한 아웃바운드** (계획 §S5).
 *
 * ★★ **무필터로 부른다. `?channel=` 을 절대 붙이지 않는다.**
 *   계약 §2 가 *"`?channel=` 은 응답을 줄이는 편의일 뿐 권한 경계가 아니다"* 라고
 *   경고했고, 그보다 중요한 이유가 따로 있다:
 *   필터를 붙이면 응답에 **우리 채널만** 오므로 *"설정에 없는 채널이 보이면 경보"*
 *   (§5.2-c 보호 목록 (b), 경보 종류 `unknown_channel`)가 **영영 발화하지 않는다.**
 *   실측으로 chzzkbot 은 지금 이미 2채널(시스네·아이곰)을 서빙 중이다.
 *
 * ★ **거르는 것은 우리다** (R5). 토큰 하나가 chzzkbot 에 등록된 모든 채널을 열기
 *   때문에, 응답을 그대로 믿으면 남의 방송이 시스네 서버에 공지된다 —
 *   시청자가 즉시 알아보는 종류의 오알림이고 §3-a 3위(가장 나쁨)다.
 *
 * ★ **절대 던지지 않는다.** 모든 실패가 판별 유니온으로 나오고, 판정기가 그것을
 *   전부 `unknown` 으로 접는다. 던지면 폴 루프 안에서 try/catch 가 판정을 대신하게
 *   되고, 그 순간 판정이 `live-state.ts` 밖으로 샌다 (§10 시나리오 1).
 */

/** 상류 `LIVE_EVENT_TOKEN_HEADER` === `LIVE_API_TOKEN_HEADER`. **여기서만 정의한다** */
export const CHZZKBOT_TOKEN_HEADER = 'x-chzzkbot-token';

/**
 * 조회 경로. **쿼리 문자열이 없는 상수다.**
 *
 * ★ 상수로 둔 이유가 곧 테스트 지점이다 — 누가 `?channel=` 을 붙이려면 이 줄을
 *   고쳐야 하고, 테스트가 이 값에 물음표가 없다는 것과 실제 요청 URL 을 함께 본다.
 */
export const LIVE_API_PATH = '/api/live';

export interface LiveApiClientOptions {
  /** `chzzkbot.baseUrl` — 기본 `http://127.0.0.1:8080` */
  baseUrl: string;
  /** `.env` 의 `LIVE_API_TOKEN`. **봇 토큰과 같은 등급이다** (계획 §S2) */
  token: string;
  http: HttpBudget;
  /**
   * `live.channelId` — 우리 대상 채널 하나 (단수. 배열이 아니다).
   * 응답 재필터(R5)의 기준이자 `unknown_channel` 판정의 기준이다.
   */
  channelId: string;
}

export interface LiveApiFetchOptions {
  /** 작업 전체 예산의 마감 시각(epoch ms). 없으면 회당 3초(`CALL_TIMEOUT_MS`)만 적용된다 */
  deadlineAt?: number;
}

export type LiveApiFetchResult =
  | {
      ok: true;
      response: LiveApiResponse;
      /** 우리 채널. 응답에 없으면 `undefined` — 판정기가 `unknown` 으로 받는다 */
      target: LiveApiChannel | undefined;
      /** ★ 우리 설정에 없는 채널들. 비어 있지 않으면 `unknown_channel` 경보 대상 */
      unknownChannelIds: readonly string[];
    }
  | { ok: false; failure: LiveApiFailure; status?: number; detail?: string };

export interface LiveApiClient {
  /** **절대 reject 하지 않는다** */
  fetch(opts?: LiveApiFetchOptions): Promise<LiveApiFetchResult>;
  /** 실제로 부르는 주소. 테스트가 `?channel=` 부재를 여기서 단언한다 */
  readonly url: string;
}

/** 끝의 슬래시를 정리해 `baseUrl` 에 경로가 붙어 있어도 이중 슬래시가 안 생기게 한다 */
function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/**
 * 응답을 우리 채널로 거른다 (R5).
 *
 * ★ 순수 함수로 떼어 둔다. 채널 필터는 "가정 방어"가 아니라 **필수 요건**이고
 *   (§5.1 rev.5 실측), 필수 요건은 소켓 없이 픽스처만으로 검증할 수 있어야 한다.
 */
export function selectChannel(
  response: LiveApiResponse,
  channelId: string,
): { target: LiveApiChannel | undefined; unknownChannelIds: string[] } {
  let target: LiveApiChannel | undefined;
  const unknownChannelIds: string[] = [];
  for (const ch of response.channels) {
    if (ch.channelId === channelId) {
      target = ch;
    } else {
      unknownChannelIds.push(ch.channelId);
    }
  }
  return { target, unknownChannelIds };
}

export function createLiveApiClient(opts: LiveApiClientOptions): LiveApiClient {
  const url = joinUrl(opts.baseUrl, LIVE_API_PATH);

  return {
    url,

    async fetch(fetchOpts = {}): Promise<LiveApiFetchResult> {
      const res = await opts.http.request('live-api', url, {
        method: 'GET',
        headers: { [CHZZKBOT_TOKEN_HEADER]: opts.token, accept: 'application/json' },
        ...(fetchOpts.deadlineAt === undefined ? {} : { deadlineAt: fetchOpts.deadlineAt }),
      });

      if (!res.ok) {
        // ★ 여기서 종류를 판정에 쓰지 않는다. 그대로 위로 올려 판정기가 접게 한다.
        return res.kind === 'http'
          ? { ok: false, failure: 'http', status: res.status }
          : res.kind === 'network'
            ? { ok: false, failure: 'network', detail: res.detail }
            : res.kind === 'bad-body'
              ? { ok: false, failure: 'bad-body', detail: res.detail }
              : { ok: false, failure: res.kind };
      }

      const parsed = LiveApiResponseSchema.safeParse(res.body);
      if (!parsed.success) {
        return {
          ok: false,
          failure: 'schema',
          detail: parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join(' / ')
            .slice(0, 300),
        };
      }

      // ★ 버전이 다르면 **모양이 맞아도 스키마 불일치로 접는다.** 상류가 계약을
      //   올린 것이고, 우리가 아는 의미로 해석하면 안 된다. `unknown` 이 쌓이면
      //   AC-P2 가 15분 안에 사람을 부른다 — 조용히 오해석하는 것보다 낫다.
      if (parsed.data.version !== LIVE_API_VERSION) {
        return {
          ok: false,
          failure: 'schema',
          detail:
            `응답 version=${String(parsed.data.version)} — 우리가 아는 값은 ` +
            `${String(LIVE_API_VERSION)} 입니다. 상류 계약이 바뀌었습니다.`,
        };
      }

      const { target, unknownChannelIds } = selectChannel(parsed.data, opts.channelId);
      return { ok: true, response: parsed.data, target, unknownChannelIds };
    },
  };
}
