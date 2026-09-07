// 출처: chzzkbot src/chzzk/oauth/refresh-client.ts (토큰 경로·본문 파서) 와
//       src/web/oauth-callback.ts (교환 → users/me 순서). **저장 경로는 옮기지 않았다** —
//       상류는 토큰을 DB 에 넣지만 우리는 넣지 않는다 (AC-10, 계획 §5.2).
import { z } from 'zod';

import type { HttpBudget } from '../../runtime/http-budget.js';
import { envelopeMessage, unwrapEnvelope } from '../api/envelope.js';
import { displayNameOf, fetchUserMe } from '../api/user-api.js';

/**
 * 시청자 토큰 — **1회 사용 후 폐기 + `revoke`** (AC-10, 계획 §5.2).
 *
 * ★★ **우리가 보관하는 치지직 토큰은 하나도 없다.**
 *   이 모듈이 그 사실을 **타입으로** 강제한다: `identify()` 가 돌려주는 것은
 *   `{ channelId, channelName }` 뿐이고 토큰은 함수 지역 변수 밖으로 나가지 않는다.
 *   호출부가 실수로 DB 에 넣을 수 있는 값이 애초에 존재하지 않는다.
 *
 * ★ **`revoke` 를 부르는 이유**: AC-10 은 *"보관하지 않는다"* 인데 **잊는 것만으로는
 *   토큰이 사라지지 않는다** — 치지직 쪽에 Access 1일 · Refresh 30일이 그대로 남는다.
 *   revoke 1회로 그것을 실제로 없앤다.
 *
 * ★ **fire-and-forget 이다.** 실패해도 인증은 이미 성공했으므로 되돌리지 않고
 *   기록만 한다 — §3-a: *"이미 이룬 것을 정리 실패로 취소하는 것이 더 나쁘다."*
 *   지표 `viewer_token_revoke_failures` 로 잔여 권한이 쌓이는지 본다.
 *
 * ★★ **AD-1 — 보호 채널은 revoke 를 건너뛴다** (계획 §5.2 rev.7).
 *   revoke 는 *"clientId 와 user 가 동일한 모든 Token"* 을 지운다. 우리 `clientId` 가
 *   chzzkbot 것과 같아지는 사고(§5.2-c)가 나면, 스트리머가 `/인증` 을 누르는 순간
 *   **chzzkbot 의 스트리머 토큰이 함께 죽어 팔로워 검증이 전원 정지**한다.
 *
 *   **fail-safe 방향을 명시한다: 의심스러우면 revoke 하지 않는다.**
 *   보호 목록을 받지 못했거나(`undefined`) `channelId` 를 확신할 수 없으면 건너뛴다.
 *   비대칭이 분명하기 때문이다 — revoke 누락의 대가는 토큰 30일 잔존(**AC-10 비용 0**),
 *   revoke 오발동의 대가는 **상류 토큰 파괴 → 전원 입장 차단**(§3-a 3위, 되돌릴 수 없음).
 */

/** 치지직 오픈 API. 상류 `CHZZK_API_BASE` 와 같은 값이다 */
export const CHZZK_API_BASE = 'https://openapi.chzzk.naver.com';
/** 사람이 승인하는 인가 페이지. 상류 `scripts/oauth-bootstrap.ts` 와 같은 주소다 */
export const CHZZK_AUTHORIZE_URL = 'https://chzzk.naver.com/account-interlock';
export const TOKEN_PATH = '/auth/v1/token';
export const REVOKE_PATH = '/auth/v1/token/revoke';

// ══════════════════════════════════════════════════════════════════
//  인가 URL
// ══════════════════════════════════════════════════════════════════

export interface AuthorizeUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
  authorizeUrl?: string;
}

export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const url = new URL(input.authorizeUrl ?? CHZZK_AUTHORIZE_URL);
  url.searchParams.set('clientId', input.clientId);
  url.searchParams.set('redirectUri', input.redirectUri);
  url.searchParams.set('state', input.state);
  return url.toString();
}

// ══════════════════════════════════════════════════════════════════
//  토큰 응답
// ══════════════════════════════════════════════════════════════════

/**
 * 교환 응답에서 우리가 쓰는 것.
 *
 * ★ `expiresIn` 을 읽지 않는다. 만료를 알 필요가 있으려면 토큰을 들고 있어야 하고,
 *   우리는 들고 있지 않는다. 읽지 않는 필드를 스키마에 두면 "언젠가 쓰겠지" 로
 *   보관 경로가 자라난다.
 */
const TokenContent = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
});

// ══════════════════════════════════════════════════════════════════
//  결과
// ══════════════════════════════════════════════════════════════════

/** ★ 토큰이 없다. 이 타입이 AC-10 의 기계적 방어다 */
export interface ViewerIdentity {
  channelId: string;
  channelName: string;
}

export type ViewerIdentifyFailure =
  /** 인가 코드가 없거나 이미 쓰였다 · 자격 증명 불일치 · 상류 장애 */
  | 'exchange-failed'
  /** 교환은 됐는데 `users/me` 가 주인을 말해주지 않았다 */
  | 'owner-unknown';

export type ViewerIdentifyResult =
  | { ok: true; identity: ViewerIdentity }
  | { ok: false; reason: ViewerIdentifyFailure; detail: string };

export type RevokeSkipReason =
  /** 보호 목록에 있는 채널 (AD-1) */
  | 'protected'
  /** 보호 목록 자체를 받지 못했다 — fail-safe 로 건너뛴다 */
  | 'no-list';

export interface ViewerTokenOptions {
  budget: HttpBudget;
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  /**
   * AD-1 보호 목록 = `{ live.channelId } ∪ { chzzkbot 이 서빙하는 채널 }`.
   *
   * ★ **`undefined` 면 revoke 를 아예 하지 않는다.** 목록을 모르는 상태에서
   *   revoke 하는 것이 정확히 이 방어가 막으려는 자해다.
   */
  protectedChannelIds?: readonly string[] | undefined;
  /** 지표 `viewer_token_revoke_failures` */
  onRevokeFailure?: (detail: string) => void;
  onRevokeSkipped?: (reason: RevokeSkipReason) => void;
  /** 진단 로그. 던지면 안 된다 */
  onLog?: (message: string, extra?: Record<string, unknown>) => void;
}

export interface IdentifyInput {
  code: string;
  /** 치지직이 교환 요청에서 함께 확인한다 (상류와 같은 본문) */
  state?: string | undefined;
  /** 인증 왕복 10초 예산의 마감 시각 (§5.6.1) */
  deadlineAt?: number | undefined;
}

export interface ViewerTokenClient {
  /**
   * `code` → 토큰 교환 → `users/me` → **메모리 폐기 + revoke(fire-and-forget)**.
   *
   * **절대 던지지 않는다.**
   */
  identify(input: IdentifyInput): Promise<ViewerIdentifyResult>;
  /** 아직 날아가고 있는 revoke 들이 끝날 때까지 기다린다. **테스트 전용 관측점** */
  settled(): Promise<void>;
  readonly revokeAttempts: number;
  readonly revokeFailures: number;
  readonly revokeSkipped: number;
}

export function createViewerTokenClient(opts: ViewerTokenOptions): ViewerTokenClient {
  const base = opts.baseUrl ?? CHZZK_API_BASE;
  const inFlight = new Set<Promise<void>>();
  let attempts = 0;
  let failures = 0;
  let skipped = 0;

  const log = (message: string, extra?: Record<string, unknown>): void => {
    try {
      opts.onLog?.(message, extra);
    } catch {
      /* 진단 로그가 인증을 죽이면 안 된다 (Principle 2) */
    }
  };

  /**
   * ★ 정리 실패는 **세기만 한다.** 되돌리지 않는다.
   *
   * `bad-body` 를 성공으로 세는 이유: `http-budget` 은 2xx 를 받은 뒤에만
   * 본문 파싱을 시도하므로 `bad-body` 는 **"응답은 2xx 였는데 본문이 비었다"** 이다.
   * revoke 응답은 본문이 없을 수 있고, 그것을 실패로 세면 지표가 상시 거짓 경보가 된다.
   */
  async function revoke(accessToken: string, channelId: string): Promise<void> {
    const list = opts.protectedChannelIds;
    if (list === undefined) {
      skipped += 1;
      opts.onRevokeSkipped?.('no-list');
      log('revoke 를 건너뜁니다 — 보호 목록을 알 수 없습니다 (AD-1 fail-safe)');
      return;
    }
    if (list.includes(channelId)) {
      skipped += 1;
      opts.onRevokeSkipped?.('protected');
      log('revoke 를 건너뜁니다 — 보호 채널입니다 (AD-1)', { channelId });
      return;
    }

    attempts += 1;
    const res = await opts.budget.request('oauth-revoke', `${base}${REVOKE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        token: accessToken,
        tokenTypeHint: 'access_token',
      }),
      // ★ 인증 왕복 예산에 매지 않는다. 인증은 이미 끝났고, 정리가 사람을
      //   기다리게 하면 안 된다. 회당 타임아웃(5초)만 걸린다.
      maxRetries: 0,
    });

    if (res.ok || res.kind === 'bad-body') return;
    failures += 1;
    const detail = res.kind === 'http' ? `status ${String(res.status)}` : res.kind;
    opts.onRevokeFailure?.(detail);
    log('시청자 토큰 revoke 실패 — 인증은 이미 성공했습니다', { detail });
  }

  return {
    get revokeAttempts() {
      return attempts;
    },
    get revokeFailures() {
      return failures;
    },
    get revokeSkipped() {
      return skipped;
    },

    async settled(): Promise<void> {
      // 진행 중인 것이 끝나면서 또 만들어지지는 않는다 — 한 번만 비우면 된다.
      await Promise.all([...inFlight]);
    },

    async identify(input): Promise<ViewerIdentifyResult> {
      // ── ① 토큰 교환 ────────────────────────────────────────────
      const exchanged = await opts.budget.request('oauth-token', `${base}${TOKEN_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          grantType: 'authorization_code',
          clientId: opts.clientId,
          clientSecret: opts.clientSecret,
          code: input.code,
          ...(input.state === undefined ? {} : { state: input.state }),
        }),
        ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
      });

      const tokens = unwrapEnvelope(exchanged, TokenContent);
      if (!tokens.ok) {
        const detail = exchanged.ok
          ? (envelopeMessage(exchanged.body) ?? '응답에서 토큰을 찾지 못했습니다')
          : exchanged.kind === 'http'
            ? `status ${String(exchanged.status)}`
            : exchanged.kind;
        log('토큰 교환 실패', { detail });
        return { ok: false, reason: 'exchange-failed', detail };
      }

      // ★ 여기서부터 `accessToken` 은 **이 함수의 지역 변수**다.
      //   반환값에도, 로그에도, DB 에도 가지 않는다 (AC-10).
      const accessToken = tokens.data.accessToken;

      // ── ② 토큰 주인 확인 ───────────────────────────────────────
      const me = await fetchUserMe({
        budget: opts.budget,
        baseUrl: base,
        accessToken,
        ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
      });
      if (!me.ok) {
        // 주인을 모르면 누구를 연동할지 모른다. 아무나 연동하느니 멈춘다.
        // ★ 그래도 토큰은 정리한다 — 주인을 몰라 보호 목록 대조를 못 하므로
        //   fail-safe 로 **건너뛴다**(§5.2 AD-1). 대가는 30일 잔존뿐이다.
        const detail = me.kind === 'shape' ? me.detail : me.result.kind;
        log('토큰 주인 확인 실패', { detail });
        skipped += 1;
        opts.onRevokeSkipped?.('no-list');
        return { ok: false, reason: 'owner-unknown', detail };
      }

      const identity: ViewerIdentity = {
        channelId: me.data.channelId,
        channelName: displayNameOf(me.data),
      };

      // ── ③ 폐기 + revoke (fire-and-forget) ──────────────────────
      // ★ await 하지 않는다. 사람은 이미 결과를 기다리고 있고, 정리 때문에
      //   왕복 예산을 더 쓰면 DD-3 이 깨진다.
      const task = (async (): Promise<void> => {
        try {
          await revoke(accessToken, identity.channelId);
        } catch (e: unknown) {
          // `revoke` 는 던지지 않기로 돼 있지만 계약을 신뢰하지 않는다 —
          // 여기서 새면 unhandled rejection 이 프로세스를 흔든다 (Principle 2).
          failures += 1;
          opts.onRevokeFailure?.(e instanceof Error ? e.message : String(e));
        }
      })();
      inFlight.add(task);
      void task.finally(() => {
        inFlight.delete(task);
      });

      return { ok: true, identity };
    },
  };
}
