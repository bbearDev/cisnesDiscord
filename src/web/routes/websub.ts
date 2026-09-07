import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Route, RouteRequest, RouteResponse } from '../server.js';

/**
 * WebSub 수신구 — 계획 §S6 (AC-20 · AC-23 · **AC-P5**).
 *
 * 두 가지를 받는다:
 *   `GET`  — 허브의 검증. `hub.challenge` 를 **그대로 에코**한다.
 *   `POST` — 푸시. `X-Hub-Signature` **HMAC-SHA1** 검증 후 Atom 파싱.
 *
 * ★★ **서명 검증 실패는 계약대로 조용히 202 로 답하되, 반드시 지표를 올린다** (AC-P5).
 *   계획이 이 한 줄을 수용 기준으로 승격시킨 이유가 전부다 —
 *   *"지표가 없으면 '시크릿 불일치'와 '허브가 안 보냄'을 구분할 수 없어
 *   원인 특정이 불가능하다."* 두 상태 모두 겉으로는 **공지가 안 나온다**로만
 *   보이는데, 전자는 우리 DB 를 고쳐야 하고 후자는 구독을 다시 걸어야 한다.
 *   `websub_signature_failures{channel}` 이 0 인지 아닌지가 그 갈림길이다.
 *
 * ★ 왜 4xx 가 아니라 202 인가. WebSub 허브는 실패 응답을 구독 해지 신호로 읽고
 *   재시도를 쌓는다. 우리가 시크릿을 잘못 들고 있는 동안 허브가 구독을 끊으면
 *   고친 뒤에도 푸시가 오지 않는다 — 자기 발등을 찍는 실패 모드다.
 *
 * ★ 모르는 채널의 검증 GET 에는 **404** 를 준다. WebSub 명세가 요구하는 응답이고,
 *   그래야 남이 우리 콜백을 자기 토픽에 등록해 놓는 일이 성립하지 않는다.
 */

/** 공개 경로. 리버스 프록시 화이트리스트에 이 경로와 OAuth 콜백 둘만 있다 */
export const WEBSUB_PATH = '/websub';

/** 콜백 URL 에 실리는 채널 식별자. `websub-client.ts` 의 `callbackFor` 와 짝이다 */
export const CHANNEL_PARAM = 'channel';

export const SIGNATURE_HEADER = 'x-hub-signature';

/** 지표 이름 — AC-P5 */
export const SIGNATURE_FAILURE_METRIC = 'websub_signature_failures';

/**
 * 모르는 채널의 지표 라벨.
 *
 * ★ 요청이 준 값을 그대로 라벨에 쓰지 않는다. 라벨은 공격자가 고르는 문자열이
 *   되어 **카디널리티가 무한**해지고, 그러면 지표 저장소가 먼저 죽는다.
 *   우리가 아는 채널이 아니면 전부 이 한 버킷이다.
 */
export const UNKNOWN_CHANNEL_LABEL = '__unknown__';

/**
 * 허용하는 서명 알고리즘.
 *
 * 계약은 HMAC-SHA1 이다(유튜브 허브가 보내는 것). 더 강한 것을 함께 받아 두는
 * 것은 공짜이고, 목록으로 **가둬** 두는 것이 핵심이다 — 헤더가 고르는 대로
 * 아무 다이제스트나 열어 주면 알고리즘 선택 자체가 공격 표면이 된다.
 */
const ALLOWED_ALGOS: readonly string[] = ['sha1', 'sha256', 'sha512'];

const SIGNATURE = /^([a-z0-9]+)=([0-9a-fA-F]+)$/;

export type SignatureFailure =
  | 'missing-channel'
  | 'unknown-channel'
  | 'missing-header'
  | 'malformed-header'
  | 'unsupported-algo'
  | 'mismatch';

/**
 * ★ 서명 대조. **`timingSafeEqual`** 을 쓴다 — 문자열 `===` 는 앞에서부터 다른
 *   자리에서 끊기므로 비교 시간이 정답과의 접두어 길이를 흘린다.
 */
export function verifySignature(
  secret: string,
  body: Buffer,
  header: string | undefined,
): { ok: true } | { ok: false; reason: SignatureFailure } {
  if (header === undefined || header.trim() === '') return { ok: false, reason: 'missing-header' };
  const m = SIGNATURE.exec(header.trim());
  if (m === null) return { ok: false, reason: 'malformed-header' };

  const algo = (m[1] ?? '').toLowerCase();
  const hex = m[2] ?? '';
  if (!ALLOWED_ALGOS.includes(algo)) return { ok: false, reason: 'unsupported-algo' };

  const expected = createHmac(algo, secret).update(body).digest();
  const got = Buffer.from(hex, 'hex');
  // 길이가 다르면 timingSafeEqual 이 던진다. 던지게 두면 서명 실패 하나가 500 이 된다.
  if (got.length !== expected.length) return { ok: false, reason: 'mismatch' };
  return timingSafeEqual(got, expected) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

// ══════════════════════════════════════════════════════════════════
//  지표 — AC-P5
// ══════════════════════════════════════════════════════════════════

export interface SignatureFailureCounter {
  record(channel: string, reason: SignatureFailure): void;
  count(channel: string): number;
  readonly total: number;
  snapshot(): { channel: string; count: number }[];
}

/**
 * `websub_signature_failures{channel}`.
 *
 * ★ 라우트 안에 카운터를 숨기지 않고 밖으로 뺀다. 지표는 **읽히기 위해** 존재하는데
 *   라우트 내부 변수는 아무도 읽을 수 없다 — 그러면 AC-P5 는 "코드에 있지만
 *   관측되지 않는" 상태가 되고, 그건 없는 것과 같다.
 */
export function createSignatureFailureCounter(): SignatureFailureCounter {
  const counts = new Map<string, number>();
  let total = 0;
  return {
    record(channel): void {
      counts.set(channel, (counts.get(channel) ?? 0) + 1);
      total += 1;
    },
    count: (channel) => counts.get(channel) ?? 0,
    get total() {
      return total;
    },
    snapshot: () => [...counts].map(([channel, count]) => ({ channel, count })),
  };
}

// ══════════════════════════════════════════════════════════════════
//  라우트
// ══════════════════════════════════════════════════════════════════

export interface WebSubVerifyInput {
  channelId: string;
  mode: string;
  topic: string;
  leaseSecondsRaw?: string | undefined;
}

export interface WebSubRouteDeps {
  /** 채널별 HMAC 시크릿. 모르는 채널이면 undefined (`websub-client.secretFor`) */
  secretFor(channelId: string): string | undefined;
  /** 검증 GET 판정 + 리스 기록 (`websub-client.verify`) */
  verify(input: WebSubVerifyInput): { accepted: boolean; reason?: string };
  /** 서명이 맞은 푸시 본문. 파싱·선점·발송은 호출부가 한다 */
  onPush(channelId: string, xml: string): Promise<void>;
  /** ★★ AC-P5 — 이것이 없으면 조용한 202 의 원인을 특정할 수 없다 */
  onSignatureFailure(channel: string, reason: SignatureFailure): void;
  onLog?: (message: string, extra?: Record<string, unknown>) => void;
}

const TEXT = 'text/plain; charset=utf-8';

/** 허브에게 돌려주는 "받았다". 본문은 비운다 */
const ACCEPTED: RouteResponse = { status: 202, contentType: TEXT, body: '' };
const NOT_FOUND: RouteResponse = { status: 404, contentType: TEXT, body: '' };

export function createWebSubRoutes(deps: WebSubRouteDeps): Route[] {
  const log = (message: string, extra?: Record<string, unknown>): void => {
    try {
      deps.onLog?.(message, extra);
    } catch {
      /* 로그가 응답을 죽이면 안 된다 */
    }
  };

  const get: Route = {
    method: 'GET',
    path: WEBSUB_PATH,
    handle(req: RouteRequest): RouteResponse {
      const p = req.url.searchParams;
      const channelId = p.get(CHANNEL_PARAM);
      const mode = p.get('hub.mode');
      const topic = p.get('hub.topic');
      const challenge = p.get('hub.challenge');

      if (channelId === null || mode === null || topic === null || challenge === null) {
        log('websub 검증 요청에 필수 파라미터가 없습니다', { path: WEBSUB_PATH });
        return NOT_FOUND;
      }

      const leaseRaw = p.get('hub.lease_seconds');
      const v = deps.verify({
        channelId,
        mode,
        topic,
        ...(leaseRaw === null ? {} : { leaseSecondsRaw: leaseRaw }),
      });
      if (!v.accepted) {
        // 요청한 적 없는 구독이다. 명세가 404 를 요구한다.
        log('websub 검증을 거절했습니다', { reason: v.reason ?? '알 수 없음' });
        return NOT_FOUND;
      }

      // ★ 챌린지를 **그대로** 돌려준다. 감싸거나 JSON 으로 만들면 허브가 거절한다.
      return { status: 200, contentType: TEXT, body: challenge };
    },
  };

  const post: Route = {
    method: 'POST',
    path: WEBSUB_PATH,
    async handle(req: RouteRequest): Promise<RouteResponse> {
      const raw = req.url.searchParams.get(CHANNEL_PARAM);
      const secret = raw === null ? undefined : deps.secretFor(raw);
      // 모르는 채널이면 지표 라벨을 한 버킷으로 접는다 (위 UNKNOWN_CHANNEL_LABEL 주석).
      const label = secret === undefined ? UNKNOWN_CHANNEL_LABEL : raw;

      if (secret === undefined || raw === null) {
        deps.onSignatureFailure(label ?? UNKNOWN_CHANNEL_LABEL, raw === null ? 'missing-channel' : 'unknown-channel');
        log('websub 푸시의 채널을 알 수 없습니다', { channel: label });
        return ACCEPTED;
      }

      const headerRaw = req.headers[SIGNATURE_HEADER];
      const header = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
      const sig = verifySignature(secret, req.body, header);
      if (!sig.ok) {
        // ★★ 조용히 202. **그러나 지표는 반드시 올린다** (AC-P5).
        deps.onSignatureFailure(raw, sig.reason);
        log('websub 서명 검증 실패', { channel: raw, reason: sig.reason });
        return ACCEPTED;
      }

      // ★ 여기서 처리를 기다린다. 원장 선점이 커밋된 뒤에 202 를 돌려주면
      //   허브가 재시도해도 같은 `videoId` 는 이미 선점돼 중복이 나지 않는다.
      //   먼저 202 를 주고 뒤에서 처리하면 그 사이의 크래시가 곧 누락이다.
      await deps.onPush(raw, req.body.toString('utf8'));
      return ACCEPTED;
    },
  };

  return [get, post];
}
