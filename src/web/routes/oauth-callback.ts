import type { FollowerChecker, FollowerLookup } from '../../chzzk/follower-check.js';
import {
  buildAuthorizeUrl,
  type ViewerIdentity,
  type ViewerTokenClient,
} from '../../chzzk/oauth/viewer-token.js';
import { applyGate, type GateGateway, type GateOutcome } from '../../discord/gate.js';
import {
  badStateMessage,
  duplicateChannelMessage,
  exchangeFailedMessage,
  gateFailedMessage,
  linkedMessage,
  notFollowerMessage,
  unknownMessage,
} from '../../discord/messages.js';
import type { Clock } from '../../runtime/clock.js';
import type { LinkRepo } from '../../store/repos/link-repo.js';
import type { Route, RouteRequest, RouteResponse } from '../server.js';
import type { ConsumedSession, VerificationResult, VerificationSessionStore } from '../session.js';

/**
 * OAuth 인가 시작·콜백 (AC-2 · AC-3 · AC-4 · AC-5 · AC-10).
 *
 * ★★★ **`state` 검증이 토큰 교환보다 먼저다.**
 *   순서가 반대면 공격자가 밀어넣은 `code` 를 **이미 소모한 뒤에** 거부하게 되고,
 *   그건 거부가 아니라 *"조용히 남의 토큰을 발급받아 버린 것"* 이다.
 *   §5.6.2 가 *"외부인은 토큰 교환까지 도달하지 못한다"* 라고 적을 수 있는 근거가
 *   **오직 이 순서 하나**다 — 바꾸면 무인증 공개 표면이 하나 생긴다.
 *
 * ★ 경로가 둘인 이유. `/인증` 은 디스코드 답장이라 **쿠키를 심을 수 없다.**
 *   그래서 `/oauth/start` 가 사이에 서서 nonce 를 심고 치지직으로 넘긴다 —
 *   AC-3 의 그물 B 가 존재할 수 있는 유일한 자리다.
 *
 *   /인증 (디스코드)  →  /oauth/start  →  치지직 인가  →  /oauth/callback
 *        state 발급        nonce 쿠키        사용자 동의       ★ state 먼저 검증
 *
 * ★ 왕복 예산 10초 (§5.6.1). 교환 + `users/me` + 팔로워 조회 3회가 이 예산을 나눠 쓴다.
 *   초과는 **실패가 아니라 `unknown`** 이다 — §3-a.
 *
 * ★ 응답은 최소 HTML 이다. 서버 공통 CSP 가 `default-src 'none'` 이라 스크립트도
 *   스타일시트도 없다 — 그래서 실수로 무언가를 얹어도 브라우저가 막는다.
 */

export const OAUTH_START_PATH = '/oauth/start';
export const OAUTH_CALLBACK_PATH = '/oauth/callback';

/** nonce 쿠키 이름. `Path=/oauth` 라 두 경로에만 실린다 */
export const NONCE_COOKIE = 'cisnes_oauth';

/**
 * 인증 왕복 전체 예산 (§5.6.1 "작업 전체 예산" 열).
 *
 * ★ 회당 타임아웃(교환 5초 + `users/me` 5초 + 팔로워 3초 = 13초)보다 **짧다.**
 *   그게 의도다 — 셋이 각자 상한까지 쓰면 사람이 13초를 기다린다.
 *   `http-budget` 이 남은 예산과 회당 타임아웃 중 **짧은 쪽**을 쓰므로
 *   총 대기가 이 값을 넘지 않는다.
 */
export const AUTH_ROUNDTRIP_BUDGET_MS = 10_000;

export interface GuildTarget {
  guildId: string;
  /** 인증 완료 시 부여할 역할 (`guild_config.verified_role_id`) */
  verifiedRoleId: string;
}

export interface OAuthStartDeps {
  sessions: VerificationSessionStore;
  clientId: string;
  /** 치지직 앱에 등록된 값과 **정확히 같아야** 한다 */
  redirectUri: string;
  /** `auth.sessionTtlMin` — 쿠키 수명을 state 수명에 맞춘다 */
  sessionTtlMin: number;
  /** `web.publicBaseUrl`. https 면 쿠키에 `Secure` 를 붙인다 */
  publicBaseUrl: string;
  authorizeUrl?: string;
  onLog?: (message: string, extra?: Record<string, unknown>) => void;
}

export interface OAuthCallbackDeps {
  sessions: VerificationSessionStore;
  viewerToken: ViewerTokenClient;
  followers: FollowerChecker;
  links: LinkRepo;
  gateway: GateGateway;
  clock: Clock;
  /**
   * 길드 설정.
   *
   * ⚠️ §8 의 `verification_sessions` 에는 **`guild_id` 컬럼이 없다.** 그래서 콜백은
   *   길드를 세션에서 읽을 수 없고 `guild_config` 에서 해석한다. 배포가 단일 길드라는
   *   전제(가정 5)가 여기서 실제 제약이 된다 — 다길드로 넓히려면 002 마이그레이션이
   *   먼저다. 조용히 아무 길드나 고르지 않도록 **없으면 실패**로 끝낸다.
   */
  resolveGuild: () => GuildTarget | undefined;
  /**
   * 서버 닉네임을 치지직 채널명으로 맞출지 (AC-6). 기본 `true`.
   * 가정 6 — 이후 재동기화 잡은 만들지 않는다.
   */
  syncNickname?: boolean;
  /** DD-3 — 왕복 시간 */
  onRoundTrip?: (ms: number) => void;
  onResult?: (result: VerificationResult) => void;
  onLog?: (message: string, extra?: Record<string, unknown>) => void;
}

// ══════════════════════════════════════════════════════════════════
//  HTML
// ══════════════════════════════════════════════════════════════════

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 문안 한 덩어리를 페이지로 감싼다.
 *
 * ★ 마크다운 강조(`**…**`)는 디스코드용이라 여기서는 지운다. 문안을 두 벌로
 *   나누면 R-4 요건(스냅샷 시각 + 재시도 시각)이 한쪽에서만 지켜진다.
 */
export function renderPage(title: string, body: string): string {
  const lines = body
    .replace(/\*\*/g, '')
    .split('\n')
    .map((l) => `<p>${escapeHtml(l)}</p>`)
    .join('\n');
  return [
    '<!doctype html>',
    '<html lang="ko"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(title)}</title></head><body>`,
    `<h1>${escapeHtml(title)}</h1>`,
    lines,
    '</body></html>',
  ].join('\n');
}

function page(status: number, title: string, body: string, headers?: Record<string, string | string[]>): RouteResponse {
  return {
    status,
    contentType: 'text/html; charset=utf-8',
    body: renderPage(title, body),
    ...(headers === undefined ? {} : { headers }),
  };
}

/** 쿠키 헤더에서 이름 하나를 꺼낸다. 없으면 `undefined` */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

function cookieHeader(name: string, value: string, maxAgeSec: number, secure: boolean): string {
  // ★ SameSite=Lax — 치지직에서 돌아오는 것은 **최상위 GET 이동**이라 Lax 로도 실린다.
  //   Strict 로 두면 그 이동에 쿠키가 안 실려 정상 흐름이 nonce-mismatch 가 된다.
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/oauth',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${String(maxAgeSec)}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

function clearCookieHeader(name: string, secure: boolean): string {
  return cookieHeader(name, '', 0, secure);
}

function isHttps(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).protocol === 'https:';
  } catch {
    // 파싱조차 안 되면 안전한 쪽으로 — Secure 를 붙인다.
    return true;
  }
}

// ══════════════════════════════════════════════════════════════════
//  /oauth/start
// ══════════════════════════════════════════════════════════════════

export function createOAuthStartRoute(deps: OAuthStartDeps): Route {
  const secure = isHttps(deps.publicBaseUrl);
  const log = (message: string, extra?: Record<string, unknown>): void => {
    try {
      deps.onLog?.(message, extra);
    } catch {
      /* 로그가 응답을 죽이면 안 된다 */
    }
  };

  return {
    method: 'GET',
    path: OAUTH_START_PATH,
    handle(req: RouteRequest): RouteResponse {
      const state = req.url.searchParams.get('s') ?? '';
      const attached = deps.sessions.attachNonce(state);
      if (!attached.ok) {
        log('인가 시작 거부', { reason: attached.reason });
        return page(400, '인증을 시작할 수 없습니다', badStateMessage());
      }

      const target = buildAuthorizeUrl({
        clientId: deps.clientId,
        redirectUri: deps.redirectUri,
        state,
        ...(deps.authorizeUrl === undefined ? {} : { authorizeUrl: deps.authorizeUrl }),
      });

      // 302 + 쿠키. 본문은 리다이렉트를 따라가지 않는 클라이언트용 안내다.
      return {
        status: 302,
        contentType: 'text/html; charset=utf-8',
        body: renderPage('치지직으로 이동합니다', target),
        headers: {
          Location: target,
          'Set-Cookie': cookieHeader(
            NONCE_COOKIE,
            attached.nonce,
            deps.sessionTtlMin * 60,
            secure,
          ),
        },
      };
    },
  };
}

// ══════════════════════════════════════════════════════════════════
//  /oauth/callback
// ══════════════════════════════════════════════════════════════════

/** 판정 → `verification_sessions.is_follower` (3상태. `undefined` 가 `unknown`) */
function isFollowerOf(lookup: FollowerLookup): boolean | undefined {
  if (lookup.verdict === 'yes') return true;
  if (lookup.verdict === 'no') return false;
  // ★ `unknown` 을 0 으로 접지 않는다. 접으면 나중에 이 행을 읽는 사람이
  //   "미팔로우로 판정됐다" 로 읽는다 — 사실이 아니다.
  return undefined;
}

export function createOAuthCallbackRoute(deps: OAuthCallbackDeps): Route {
  const syncNickname = deps.syncNickname ?? true;
  const log = (message: string, extra?: Record<string, unknown>): void => {
    try {
      deps.onLog?.(message, extra);
    } catch {
      /* 로그가 응답을 죽이면 안 된다 */
    }
  };

  function settle(state: string, result: VerificationResult, lookup?: FollowerLookup): void {
    deps.sessions.finish(state, result, lookup === undefined ? undefined : isFollowerOf(lookup));
    try {
      deps.onResult?.(result);
    } catch {
      /* 지표가 응답을 죽이면 안 된다 */
    }
  }

  /**
   * 팔로워 `yes` 이후 — 연동 + 게이트.
   *
   * ★ AD-2 재조회도 **같은 함수**를 지난다. 두 벌로 쓰면 재조회 경로에서만
   *   중복 연동 검사(AC-7)를 빠뜨리는 사고가 난다.
   */
  async function grant(
    session: ConsumedSession,
    identity: ViewerIdentity,
    guild: GuildTarget,
  ): Promise<{ result: VerificationResult; message: string; gate?: GateOutcome }> {
    const outcome = deps.links.link({
      discordUserId: session.discordUserId,
      guildId: guild.guildId,
      chzzkChannelId: identity.channelId,
      chzzkChannelName: identity.channelName,
      at: deps.clock.date().toISOString(),
    });

    if (!outcome.ok) {
      // ★ AC-7/8 — 거부. 기존 행은 그대로다. `ops_events` 는 저장소가 이미 남겼다.
      log('중복 채널 연동 거부', {
        guildId: guild.guildId,
        attemptedBy: session.discordUserId,
        heldBy: outcome.existing.discordUserId,
      });
      return {
        result: 'duplicate-channel',
        message: duplicateChannelMessage(identity.channelName),
      };
    }

    const gate = await applyGate(deps.gateway, {
      guildId: guild.guildId,
      userId: session.discordUserId,
      roleId: guild.verifiedRoleId,
      ...(syncNickname ? { nickname: identity.channelName } : {}),
    });

    for (const f of gate.failures) {
      // ★ 닉네임 실패도 **반드시 기록한다** (AC-11 후단). 성공 처리하되 흔적을 남긴다.
      log('게이트 부분 실패', { part: f.part, kind: f.kind, detail: f.detail });
    }

    if (!gate.verified) {
      return { result: 'gate-failed', message: gateFailedMessage(gate), gate };
    }
    return {
      result: outcome.created ? 'linked' : 'already-linked',
      message: linkedMessage(identity.channelName, gate),
      gate,
    };
  }

  async function handle(req: RouteRequest): Promise<RouteResponse> {
    const secure = true;
    const clearCookie = { 'Set-Cookie': clearCookieHeader(NONCE_COOKIE, secure) };
    const started = deps.clock.now();

    const providerError = req.url.searchParams.get('error');
    if (providerError !== null && providerError !== '') {
      log('치지직이 인가를 거부했습니다', { error: providerError });
      return page(
        400,
        '인증이 취소됐습니다',
        '치지직에서 동의가 완료되지 않았습니다. `/인증` 을 다시 실행해 주십시오.',
        clearCookie,
      );
    }

    // ── ★★★ state 먼저. 교환은 이 아래에서만 일어난다 ──────────
    const state = req.url.searchParams.get('state') ?? undefined;
    const gate = deps.sessions.consume(
      state,
      readCookie(req.headers.cookie, NONCE_COOKIE),
    );
    if (!gate.ok) {
      log('인가 콜백 state 검증 실패', { reason: gate.reason });
      return page(400, '인증 요청을 확인하지 못했습니다', badStateMessage(), clearCookie);
    }
    const session = gate.session;

    const code = req.url.searchParams.get('code') ?? '';
    if (code === '') {
      settle(session.state, 'exchange-failed');
      return page(400, '인증을 완료하지 못했습니다', exchangeFailedMessage(), clearCookie);
    }

    const guild = deps.resolveGuild();
    if (guild === undefined) {
      // 길드 설정이 없으면 어느 서버의 어느 역할을 줄지 모른다. 아무 데나 주지 않는다.
      settle(session.state, 'no-guild');
      log('길드 설정을 찾지 못했습니다 — 인증을 진행할 수 없습니다');
      return page(
        500,
        '서버 설정이 준비되지 않았습니다',
        '운영자에게 알려 주십시오. 인증은 진행되지 않았습니다.',
        clearCookie,
      );
    }

    const deadlineAt = started + AUTH_ROUNDTRIP_BUDGET_MS;

    // ── ① 토큰 교환 → users/me → 폐기 + revoke ──────────────────
    const identified = await deps.viewerToken.identify({ code, state, deadlineAt });
    if (!identified.ok) {
      settle(session.state, 'exchange-failed');
      // ★ `detail` 을 함께 남긴다. `reason` 만으로는 'exchange-failed' 밖에 안 남아
      //   **상류가 왜 거절했는지**(401 INVALID_CLIENT 인지 403 코드 오류인지)를 잃는다.
      //   실배포에서 이 한 칸이 없어 자격증명 오설정을 찾는 데 오래 걸렸다 (2026-09-08).
      log('시청자 신원 확인 실패', { reason: identified.reason, detail: identified.detail });
      return page(502, '인증을 완료하지 못했습니다', exchangeFailedMessage(), clearCookie);
    }
    const identity = identified.identity;

    // ── ② 팔로워 판정 (상류 단건 조회 1회) ──────────────────────
    const lookup = await deps.followers.check(identity.channelId, session.clickedAt, {
      deadlineAt,
    });
    const now = deps.clock.now();

    try {
      deps.onRoundTrip?.(now - started);
    } catch {
      /* 지표가 응답을 죽이면 안 된다 */
    }

    // ── ③ 3상태 분기 ───────────────────────────────────────────
    if (lookup.verdict === 'unknown') {
      // ★★ **거부가 아니라 보류다.** 역할을 주지도, `no` 로 접지도 않는다.
      settle(session.state, 'unknown', lookup);
      return page(200, '팔로워 여부를 확인하지 못했습니다', unknownMessage(lookup, now), clearCookie);
    }

    if (lookup.verdict === 'no') {
      settle(session.state, 'not-follower', lookup);
      // ★ AD-2 — 판정표 4 가 예약을 요구할 때만, **정확히 1회**.
      deps.followers.scheduleRecheck(identity.channelId, lookup, (again) => {
        if (again.verdict !== 'yes') return;
        void grant(session, identity, guild)
          .then((r) => {
            settle(session.state, r.result, again);
            log('AD-2 재조회로 인증 완료', { result: r.result });
          })
          .catch((e: unknown) => {
            log('AD-2 재조회 후 처리 중 예외', {
              detail: e instanceof Error ? e.message : String(e),
            });
          });
      });
      return page(200, '아직 팔로워로 확인되지 않았습니다', notFollowerMessage(lookup, now), clearCookie);
    }

    // ── ④ yes — 연동 + 게이트 ──────────────────────────────────
    const granted = await grant(session, identity, guild);
    settle(session.state, granted.result, lookup);
    const status = granted.result === 'linked' || granted.result === 'already-linked' ? 200 : 409;
    return page(
      status,
      granted.result === 'duplicate-channel' ? '이미 연동된 계정입니다' : '인증 결과',
      granted.message,
      clearCookie,
    );
  }

  return {
    method: 'GET',
    path: OAUTH_CALLBACK_PATH,
    async handle(req: RouteRequest): Promise<RouteResponse> {
      try {
        return await handle(req);
      } catch (e: unknown) {
        // ★ 여기서 새면 사용자는 빈 500 을 보고 우리는 원인을 잃는다 (Principle 2).
        log('인가 콜백 처리 중 예외', { detail: e instanceof Error ? e.message : String(e) });
        return page(
          500,
          '인증 처리 중 오류가 발생했습니다',
          '잠시 후 `/인증` 을 다시 실행해 주십시오.',
        );
      }
    },
  };
}
