import { ButtonStyle, ComponentType } from 'discord.js';

import { UPSTREAM_FOLLOWER_CACHE_MIN } from '../config/schema.js';
import type { Clock } from '../runtime/clock.js';
import type { RuntimeStateStore } from '../runtime/liveness-stamp.js';
import { DiscordSendError, type DiscordGateway, type SendPayload } from './client.js';

/**
 * 인증 패널 — 게이트 채널에 봇이 **하나** 유지하는 임베드 + 버튼 (`docs/spec-auth-panel.md`).
 *
 * 멤버의 진입점은 이 패널의 버튼이다. 슬래시 `/인증` 은 없다.
 *
 *   [치지직 계정 인증] ─▶ `cisnes:auth:link`   ─▶ `commands/link.ts`   (ephemeral + 링크 버튼)
 *   [내 연동 상태]     ─▶ `cisnes:auth:status` ─▶ `commands/status.ts` (본인 조회)
 *
 * ★★ **패널이 없으면 인증 진입점이 0개다.** 그래서 `ensure()` 의 실패는 warn 이 아니라
 *   error 로 남기고, 조립부는 기동 로그에 결과를 그대로 찍는다 (런북 §2-5 가 본다).
 *   그래도 **기동은 막지 않는다** — 패널이 없어도 방송·업로드 공지는 살아 있어야 한다.
 *
 * ★ `custom_id` 는 **상태를 싣지 않는다.** 버튼은 재기동·재배포를 넘어 몇 달을 산다.
 *   누른 사람이 누구인지는 상호작용이 알려주므로 id 에는 "무슨 버튼인가" 만 있으면 된다.
 *   `cisnes:` 접두는 같은 서버의 다른 봇 버튼과 겹치지 않게 하는 이름 공간이다.
 *
 * ★ **재기동마다 PATCH 한다.** 문안이 코드를 따라오게 하는 가장 싼 방법이다(기동당 REST 1회).
 *   PATCH 가 404 를 받으면 누가 지운 것이므로 **새로 올린다.** 다른 실패(429·5xx·타임아웃)에는
 *   새로 올리지 않는다 — 패널이 살아 있는데 하나 더 생기면 둘 중 하나는 영영 안 지워진다.
 *
 * ★ 채널이 바뀌어도 **옛 패널은 지우지 않는다.** 버튼은 `custom_id` 로 전역 라우팅되므로
 *   옛 패널도 계속 동작한다 — 해롭지 않고, 지우는 것은 운영자의 일이다. 게이트웨이 표면을
 *   `deleteMessage` 만큼 넓히지 않는다.
 */

export const AUTH_PANEL_BUTTON_LINK = 'cisnes:auth:link';
export const AUTH_PANEL_BUTTON_STATUS = 'cisnes:auth:status';

/** 사람이 보는 버튼 라벨. 안내 문안(`messages.ts`)이 이 이름으로 버튼을 가리킨다 */
export const AUTH_PANEL_LINK_LABEL = '치지직 계정 인증';
export const AUTH_PANEL_STATUS_LABEL = '내 연동 상태';

/** `runtime_state` 키. 값은 `{"channelId":"…","messageId":"…"}` */
export const AUTH_PANEL_STATE_KEY = 'auth_panel';

/** 디스코드 `custom_id` 상한 */
export const MAX_CUSTOM_ID_LENGTH = 100;

/** 치지직 그린 계열 — 라이브 공지 임베드와 구분되게 */
export const AUTH_PANEL_COLOR = 0x00ffa3;

/** PATCH·POST 한 번의 상한. `announcer.ts` 의 발송 타임아웃과 같은 자릿수다 */
export const AUTH_PANEL_TIMEOUT_MS = 5_000;

// ══════════════════════════════════════════════════════════════════
//  패널 본문 — 순수 함수. 테스트가 JSON 을 그대로 비교한다
// ══════════════════════════════════════════════════════════════════

export function buildAuthPanel(): SendPayload {
  return {
    embeds: [
      {
        title: '치지직 팔로워 인증',
        description: [
          '시스네 치지직 채널 팔로워임을 확인하면 인증 역할이 부여됩니다.',
          '',
          `1. 아래 **${AUTH_PANEL_LINK_LABEL}** 버튼을 누릅니다.`,
          '2. 본인에게만 보이는 답장의 버튼으로 치지직 로그인·동의를 진행합니다.',
          '3. 팔로워로 확인되면 역할이 자동으로 부여되고, 서버 닉네임이 치지직 채널명으로 맞춰집니다.',
          '',
          '※ 답장 안의 링크는 **본인 전용**입니다. 다른 사람에게 전달하지 마십시오.',
          `※ 방금 팔로우하셨다면 반영까지 최대 ${String(UPSTREAM_FOLLOWER_CACHE_MIN)}분이 걸릴 수 있습니다.`,
        ].join('\n'),
        color: AUTH_PANEL_COLOR,
      },
    ],
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Success,
            label: AUTH_PANEL_LINK_LABEL,
            custom_id: AUTH_PANEL_BUTTON_LINK,
          },
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            label: AUTH_PANEL_STATUS_LABEL,
            custom_id: AUTH_PANEL_BUTTON_STATUS,
          },
        ],
      },
    ],
  };
}

// ══════════════════════════════════════════════════════════════════
//  수명주기
// ══════════════════════════════════════════════════════════════════

export interface AuthPanelLocation {
  channelId: string;
  messageId: string;
}

export type AuthPanelSkipReason =
  /** `guild_config.gate_channel_id` 가 비어 있다 */
  | 'no-gate-channel'
  /** `runtime_state` 를 읽지 못했다. 위치를 모르는 채 올리면 둘이 될 수 있어 아무것도 하지 않는다 */
  | 'state-unreadable'
  /** PATCH 가 404 아닌 이유로 실패했다. 패널은 아마 아직 있다 — 새로 올리지 않는다 */
  | 'edit-failed'
  /**
   * POST 가 실패했다. **타임아웃이면 패널이 실제로는 올라갔을 수 있다** — 요청은 받아들여졌는데
   * 응답만 늦은 경우다. 그래서 `detail` 이 그 사실을 말하고, 런북 §4-7 은 눈으로 확인한 뒤 다시 하라고 한다.
   */
  | 'send-failed';

export type AuthPanelResult =
  | { outcome: 'posted' | 'updated'; channelId: string; messageId: string }
  | { outcome: 'skipped'; reason: AuthPanelSkipReason; detail?: string };

/** 기동 로그 `authPanel` 필드 — 사람이 한눈에 읽는 한 단어 */
export function describeAuthPanelResult(r: AuthPanelResult): string {
  return r.outcome === 'skipped' ? `skipped:${r.reason}` : r.outcome;
}

export interface AuthPanelKeeperOptions {
  gateway: Pick<DiscordGateway, 'send' | 'editMessage'>;
  state: RuntimeStateStore;
  clock: Clock;
  timeoutMs?: number;
  /** 진단 로그. 던지면 안 된다 */
  onLog?: (message: string, extra?: Record<string, unknown>) => void;
}

export interface AuthPanelKeeper {
  /**
   * 게이트 채널에 패널이 **정확히 최신 문안으로** 있게 한다.
   *
   * **절대 던지지 않는다.** 결과는 값으로 나오고, 조립부가 로그에 찍는다.
   *
   * ★ **직렬화된다.** 겹쳐 부르면(기동 중 `/인증채널`, 운영자 더블클릭) 둘 다 "기록 없음" 을 읽고
   *   둘 다 POST 해 패널이 둘이 된다 — 그래서 앞 호출이 끝난 뒤에 다음이 돈다.
   */
  ensure(gateChannelId: string | undefined): Promise<AuthPanelResult>;
  /** 마지막으로 기록된 위치. 없으면 `undefined` */
  current(): AuthPanelLocation | undefined;
}

/** 저장된 위치를 읽는다. 깨진 JSON 은 "없음" 으로 본다 — 어차피 새로 올리면 된다 */
export function readAuthPanelLocation(state: RuntimeStateStore): AuthPanelLocation | undefined {
  const raw = state.get(AUTH_PANEL_STATE_KEY);
  if (raw === undefined || raw === '') return undefined;
  try {
    const parsed = JSON.parse(raw) as { channelId?: unknown; messageId?: unknown } | null;
    if (
      parsed !== null &&
      typeof parsed.channelId === 'string' &&
      parsed.channelId !== '' &&
      typeof parsed.messageId === 'string' &&
      parsed.messageId !== ''
    ) {
      return { channelId: parsed.channelId, messageId: parsed.messageId };
    }
  } catch {
    /* 아래로 */
  }
  return undefined;
}

function detailOf(e: unknown): string {
  if (e instanceof DiscordSendError) {
    return e.status === undefined ? e.kind : `${e.kind} (status ${String(e.status)})`;
  }
  return e instanceof Error ? e.message : String(e);
}

/** 타임아웃은 "실패" 가 아니라 "모름" 이다 — 패널이 올라갔을 수 있다는 사실을 detail 에 싣는다 */
function sendFailureDetail(e: unknown): string {
  const detail = detailOf(e);
  return e instanceof DiscordSendError && e.kind === 'timeout'
    ? `${detail} — 패널이 실제로 올라갔을 수 있습니다. 채널을 확인한 뒤 다시 실행하십시오`
    : detail;
}

export function createAuthPanelKeeper(opts: AuthPanelKeeperOptions): AuthPanelKeeper {
  const timeoutMs = opts.timeoutMs ?? AUTH_PANEL_TIMEOUT_MS;

  const log = (message: string, extra?: Record<string, unknown>): void => {
    try {
      opts.onLog?.(message, extra);
    } catch {
      /* 진단 로그가 패널을 죽이면 안 된다 (Principle 2) */
    }
  };

  /** 한 번 부른다. 타임아웃을 걸고 `finally` 에서 타이머를 반드시 걷는다 (`announcer.ts` 와 같은 모양) */
  async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ac = new AbortController();
    const timer = setTimeout(() => {
      ac.abort();
    }, timeoutMs);
    try {
      return await fn(ac.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * ★ 위치 기록은 게시 `try` **밖**이다. 안에 두면 기록 실패가 `send-failed` 로 보고되고,
   *   그 안내를 따라 다시 실행하면 **이미 올라간 패널 옆에 하나 더** 올라간다.
   *   패널은 올라갔으므로 결과는 `posted` 다 — 기록 실패는 로그로만 남긴다 (다음 기동이 다시 올릴 수는 있다).
   */
  function remember(loc: AuthPanelLocation): void {
    try {
      opts.state.set(AUTH_PANEL_STATE_KEY, JSON.stringify(loc), opts.clock.date().toISOString());
    } catch (e: unknown) {
      log('인증 패널 위치를 기록하지 못했습니다 — 패널은 올라갔습니다', { ...loc, detail: detailOf(e) });
    }
  }

  async function post(channelId: string, payload: SendPayload): Promise<AuthPanelResult> {
    let messageId: string;
    try {
      messageId = (await withTimeout((signal) => opts.gateway.send(channelId, payload, { signal }))).id;
    } catch (e: unknown) {
      const detail = sendFailureDetail(e);
      log('인증 패널 게시 실패', { channelId, detail });
      return { outcome: 'skipped', reason: 'send-failed', detail };
    }
    remember({ channelId, messageId });
    log('인증 패널 게시', { channelId, messageId });
    return { outcome: 'posted', channelId, messageId };
  }

  async function run(gateChannelId: string | undefined): Promise<AuthPanelResult> {
    if (gateChannelId === undefined || gateChannelId === '') {
      log('게이트 채널이 설정되지 않아 인증 패널을 게시하지 않습니다 — 인증 진입점이 없습니다');
      return { outcome: 'skipped', reason: 'no-gate-channel' };
    }

    // ★ 위치를 모르는 채 올리지 않는다 — 살아 있는 패널 옆에 하나 더 만드는 길이다.
    let known: AuthPanelLocation | undefined;
    try {
      known = readAuthPanelLocation(opts.state);
    } catch (e: unknown) {
      const detail = detailOf(e);
      log('인증 패널 위치를 읽지 못했습니다 — 게시하지 않습니다', { detail });
      return { outcome: 'skipped', reason: 'state-unreadable', detail };
    }

    const payload = buildAuthPanel();

    // 채널이 바뀌었으면 옛 패널은 두고 새 채널에 올린다 (머리말).
    if (known === undefined || known.channelId !== gateChannelId) {
      return post(gateChannelId, payload);
    }

    try {
      await withTimeout((signal) =>
        opts.gateway.editMessage(known.channelId, known.messageId, payload, { signal }),
      );
      log('인증 패널 갱신', { channelId: known.channelId, messageId: known.messageId });
      return { outcome: 'updated', channelId: known.channelId, messageId: known.messageId };
    } catch (e: unknown) {
      // ★ 404 만 "사라졌다" 다. 나머지는 패널이 살아 있을 수 있으므로 하나 더 만들지 않는다.
      if (e instanceof DiscordSendError && e.status === 404) {
        log('인증 패널이 사라져 새로 게시합니다', { channelId: known.channelId, messageId: known.messageId });
        return post(gateChannelId, payload);
      }
      const detail = detailOf(e);
      log('인증 패널 갱신 실패 — 다음 기동에 다시 시도합니다', { channelId: known.channelId, detail });
      return { outcome: 'skipped', reason: 'edit-failed', detail };
    }
  }

  /** 직렬화 사슬. 앞 호출의 결과와 무관하게 다음이 이어진다 (`run` 은 던지지 않는다) */
  let inflight: Promise<unknown> = Promise.resolve();

  return {
    current(): AuthPanelLocation | undefined {
      return readAuthPanelLocation(opts.state);
    },

    ensure(gateChannelId): Promise<AuthPanelResult> {
      const next = inflight.then(() => run(gateChannelId));
      inflight = next.catch(() => undefined);
      return next;
    },
  };
}
