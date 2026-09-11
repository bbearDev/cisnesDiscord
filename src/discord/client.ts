import { Client, GatewayIntentBits, Routes } from 'discord.js';
import type { ButtonStyle, ComponentType } from 'discord.js';

/**
 * 디스코드 게이트웨이 클라이언트 (계획 §S3).
 *
 * ★ **클라이언트를 주입받는다.** `test/e2e/harness/fake-discord.ts` 를 꽂을 자리가
 *   여기다 — 주입점이 없으면 하니스를 만들어도 붙일 곳이 없고, §9.3 e2e 계층
 *   전체가 실행 불가가 된다 (계획 §S3 B-2).
 *
 * ★ 왜 얇은 인터페이스(`DiscordGateway`)를 따로 두는가.
 *   `discord.js` 의 `Client` 를 그대로 노출하면 하니스가 그 거대한 표면을 전부
 *   흉내 내야 하고, 실제로 우리가 쓰는 것은 **발송 · 역할 부여 · 닉네임 변경**
 *   셋뿐이다. 표면을 우리가 쓰는 만큼으로 좁히는 것이 하니스를 가능하게 한다.
 *
 * ★ 발송을 `channel.send()` 가 아니라 **REST 로** 한다.
 *   §5.6.1 이 모든 아웃바운드에 `AbortSignal` 타임아웃을 요구하는데
 *   `channel.send()` 는 시그널을 받지 못한다. `client.rest` 는 받는다 —
 *   같은 토큰·같은 레이트리밋 큐를 쓰면서 끊을 수 있다. 게이트웨이(Intents)는
 *   방송 공지가 아니라 길드·멤버 이벤트 때문에 필요하다.
 */

/**
 * 필요한 Intents (계획 §S3).
 *
 * - `Guilds`        : 길드·채널 캐시. 없으면 채널을 찾지 못한다
 * - `GuildMembers`  : 역할 부여·닉네임 변경 대상 멤버 (특권 Intent — S0-7 에서 켠다)
 * - `GuildMessages` : 게이트 채널 메시지 관측
 *
 * 더 넣지 않는다. Intent 는 받는 이벤트의 범위이고, 넓히면 쓰지도 않는 이벤트가
 * 이벤트 루프를 채운다.
 */
export const REQUIRED_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
] as const;

// ══════════════════════════════════════════════════════════════════
//  ★ 게이트웨이 재연결 — 테스트와 운영이 **같은 신호**를 센다 (AC-P3 (a))
// ══════════════════════════════════════════════════════════════════

/**
 * `discord.js` 가 재연결 과정에서 내는 이벤트 셋.
 *
 * ★ 계획 §S3 B-2 가 못 박은 관측 수단이다. 하니스(`fake-discord.ts`)가 이 이름들을
 *   그대로 주입하고, 프로덕션은 같은 이름을 구독해 지표 `discord_gateway_reconnects`
 *   로 내보낸다. **둘이 갈리면 테스트가 통과해도 운영에서 못 본다.**
 */
export const GATEWAY_EVENTS = ['shardDisconnect', 'shardReconnecting', 'shardResume'] as const;
export type GatewayEventName = (typeof GATEWAY_EVENTS)[number];

/**
 * ★ **재연결 1건으로 세는 이벤트는 이것 하나다.**
 *
 * 셋을 모두 세면 한 번의 재연결이 3으로 잡혀 "재연결 0건"(AC-P3 (a))이 아닌
 * 모든 판정이 3배로 부풀고, 운영 지표와 테스트 단언이 서로 다른 축을 보게 된다.
 * `shardReconnecting` 이 "다시 붙으러 간다" 는 시도 그 자체이므로 이것을 센다 —
 * `shardDisconnect` 는 정상 종료에서도 나고 `shardResume` 은 성공했을 때만 난다.
 */
export const RECONNECT_COUNTED_EVENT: GatewayEventName = 'shardReconnecting';

export interface GatewayEventRecord {
  name: GatewayEventName;
  at: number;
}

export interface GatewayCounter {
  /** 지표 `discord_gateway_reconnects` 와 **같은 값** */
  readonly reconnectCount: number;
  /** 진단용 전체 기록 (끊김·재개 포함) */
  readonly events: readonly GatewayEventRecord[];
  record(name: GatewayEventName, at: number): void;
}

/**
 * 프로덕션과 하니스가 **공유하는** 카운터.
 *
 * 하니스가 이 함수를 import 한다 — 세는 규칙을 두 번 적으면 그 둘이 갈리는 날
 * 테스트만 옳아진다.
 */
export function createGatewayCounter(): GatewayCounter {
  const events: GatewayEventRecord[] = [];
  let reconnects = 0;
  return {
    get reconnectCount() {
      return reconnects;
    },
    get events() {
      return events;
    },
    record(name, at) {
      events.push({ name, at });
      if (name === RECONNECT_COUNTED_EVENT) reconnects += 1;
    },
  };
}

// ══════════════════════════════════════════════════════════════════
//  게이트웨이 표면
// ══════════════════════════════════════════════════════════════════

/** 디스코드 임베드 (필요한 필드만). `discord.js` 의 `APIEmbed` 부분집합이다 */
export interface AnnouncementEmbed {
  title?: string;
  url?: string;
  description?: string;
  /** ISO-8601. 라이브 공지는 **`openedAt`** 이다 — 수신 시각이 아니다 (계획 §S5) */
  timestamp?: string;
  color?: number;
  footer?: { text: string };
  /** 본문 아래 큰 이미지. 디스코드 API 형태 그대로 `{ url }` 이다 */
  image?: { url: string };
}

/**
 * 메시지 컴포넌트 — 버튼만 쓴다 (`discord.js` 의 `APIActionRowComponent` 부분집합).
 *
 * ★ 빌더(`ButtonBuilder`)를 쓰지 않는다. 명령 정의와 같은 이유다 — 테스트가 비교할 수
 *   있는 것은 결국 디스코드로 나가는 이 JSON 이고, 중간 표현을 하나 줄인다.
 *   `type`/`style` 을 enum 리터럴로 박아 `interaction.reply()` 의 타입에 그대로 맞는다.
 */
export interface LinkButton {
  type: ComponentType.Button;
  style: ButtonStyle.Link;
  label: string;
  /** ★ 여기 실린 URL 은 본문 링크가 아니라 **미리보기 크롤링 대상이 아니다** */
  url: string;
}

export interface ActionButton {
  type: ComponentType.Button;
  style: ButtonStyle.Primary | ButtonStyle.Secondary | ButtonStyle.Success | ButtonStyle.Danger;
  label: string;
  /** 상호작용이 이 값을 들고 돌아온다. 재기동을 넘어 유효해야 하므로 상태를 싣지 않는다 */
  custom_id: string;
  disabled?: boolean;
}

export interface ActionRow {
  type: ComponentType.ActionRow;
  components: (LinkButton | ActionButton)[];
}

export interface SendPayload {
  content?: string;
  embeds?: AnnouncementEmbed[];
  components?: ActionRow[];
}

export interface SentMessage {
  id: string;
}

export interface SendOptions {
  /** §5.6.1 — 모든 아웃바운드는 끊을 수 있어야 한다 */
  signal?: AbortSignal;
}

export interface DiscordGateway {
  login(): Promise<void>;
  destroy(): Promise<void>;
  send(channelId: string, payload: SendPayload, opts?: SendOptions): Promise<SentMessage>;
  /**
   * 우리가 보낸 메시지를 제자리에서 고친다 (인증 패널 갱신).
   *
   * ★ 메시지가 사라졌으면 `DiscordSendError` 의 `status` 가 **404** 다 — 호출부가
   *   그것을 보고 "새로 올린다" 로 간다. 다른 실패는 새로 올리지 않는다(패널이 둘이 된다).
   */
  editMessage(
    channelId: string,
    messageId: string,
    payload: SendPayload,
    opts?: SendOptions,
  ): Promise<void>;
  addRole(guildId: string, userId: string, roleId: string, opts?: SendOptions): Promise<void>;
  setNickname(
    guildId: string,
    userId: string,
    nickname: string | null,
    opts?: SendOptions,
  ): Promise<void>;
  /** 지표 `discord_gateway_reconnects` — 하니스가 노출하는 것과 같은 값 */
  readonly reconnectCount: number;
}

// ══════════════════════════════════════════════════════════════════
//  오류 분류 — 재시도 판정의 유일한 지점
// ══════════════════════════════════════════════════════════════════

export type DiscordFailureKind =
  /** 429. `Retry-After` 를 우선한다 (§5.6.1) */
  | 'rate-limited'
  /** 403. 권한은 4초 안에 생기지 않는다 — 재시도가 무의미하다 */
  | 'forbidden'
  /** 5xx. 상대가 회복하면 풀린다 */
  | 'server'
  /** AbortSignal 로 끊었다 */
  | 'timeout'
  /** 나머지 — 네트워크 오류·알 수 없는 응답 */
  | 'unknown';

export class DiscordSendError extends Error {
  readonly kind: DiscordFailureKind;
  readonly status: number | undefined;
  /** 429 가 알려준 대기 시간 (ms). 백오프보다 **이것을 우선한다** */
  readonly retryAfterMs: number | undefined;

  constructor(
    kind: DiscordFailureKind,
    message: string,
    status?: number,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'DiscordSendError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** `retryAfter` 는 라이브러리에 따라 초 단위이기도 하다. 큰 값은 ms 로 본다 */
function toRetryAfterMs(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
  // discord.js 의 RateLimitError.timeToReset 은 ms, HTTP 헤더 Retry-After 는 초다.
  // 1000 미만이면 초로 읽는다 — 1초 미만의 ms 대기는 의미가 없어 오판의 손해가 없다.
  return v < 1_000 ? v * 1_000 : v;
}

/** 어떤 예외든 분류된 `DiscordSendError` 로 접는다. **여기서만 판정한다** */
export function toDiscordSendError(e: unknown): DiscordSendError {
  if (e instanceof DiscordSendError) return e;

  const err = e as { name?: string; message?: string; status?: number; retryAfter?: number; timeToReset?: number } | null;
  const message = e instanceof Error ? e.message : String(e);

  if (err?.name === 'AbortError' || /abort/i.test(message)) {
    return new DiscordSendError('timeout', message);
  }

  const status = typeof err?.status === 'number' ? err.status : undefined;
  const retryAfterMs = toRetryAfterMs(err?.retryAfter ?? err?.timeToReset);

  if (status === 429 || err?.name === 'RateLimitError') {
    return new DiscordSendError('rate-limited', message, status ?? 429, retryAfterMs);
  }
  if (status === 403) return new DiscordSendError('forbidden', message, status);
  if (status !== undefined && status >= 500) return new DiscordSendError('server', message, status);

  return new DiscordSendError('unknown', message, status);
}

// ══════════════════════════════════════════════════════════════════
//  실제 클라이언트
// ══════════════════════════════════════════════════════════════════

export interface DiscordGatewayOptions {
  token: string;
  /**
   * ★ 주입점. 주지 않으면 `REQUIRED_INTENTS` 로 새로 만든다.
   *   테스트는 이 자리에 가짜를 꽂거나, 아예 `DiscordGateway` 를 직접 구현한
   *   `fake-discord.ts` 를 쓴다.
   */
  client?: Client;
  clock?: { now(): number };
  /** 게이트웨이 이벤트를 지표로 내보낼 자리. 던지면 안 된다 */
  onGatewayEvent?: (e: GatewayEventRecord, reconnectCount: number) => void;
}

export function createDiscordClient(): Client {
  return new Client({ intents: [...REQUIRED_INTENTS] });
}

export function createDiscordGateway(opts: DiscordGatewayOptions): DiscordGateway {
  const client = opts.client ?? createDiscordClient();
  const now = opts.clock?.now.bind(opts.clock) ?? Date.now;
  const counter = createGatewayCounter();

  for (const name of GATEWAY_EVENTS) {
    client.on(name, () => {
      counter.record(name, now());
      try {
        opts.onGatewayEvent?.({ name, at: now() }, counter.reconnectCount);
      } catch {
        /* 지표가 게이트웨이를 죽이면 안 된다 (Principle 2) */
      }
    });
  }

  /** REST 호출을 우리 오류 어휘로 접는다. 이 밖으로 raw 예외가 새지 않는다 */
  async function call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e: unknown) {
      throw toDiscordSendError(e);
    }
  }

  return {
    get reconnectCount() {
      return counter.reconnectCount;
    },

    async login(): Promise<void> {
      await client.login(opts.token);
    },

    async destroy(): Promise<void> {
      await client.destroy();
    },

    async send(channelId, payload, sendOpts): Promise<SentMessage> {
      const res = await call(() =>
        client.rest.post(Routes.channelMessages(channelId), {
          body: payload,
          ...(sendOpts?.signal ? { signal: sendOpts.signal } : {}),
        }),
      );
      const id = (res as { id?: unknown } | null)?.id;
      if (typeof id !== 'string') {
        // 2xx 인데 id 가 없다 = 계약이 바뀌었다. 조용히 넘기면 원장에
        // messageId 없는 "발송 완료" 행이 남아 나중에 추적이 끊긴다.
        throw new DiscordSendError('unknown', '발송 응답에 messageId 가 없습니다');
      }
      return { id };
    },

    async editMessage(channelId, messageId, payload, sendOpts): Promise<void> {
      await call(() =>
        client.rest.patch(Routes.channelMessage(channelId, messageId), {
          body: payload,
          ...(sendOpts?.signal ? { signal: sendOpts.signal } : {}),
        }),
      );
    },

    async addRole(guildId, userId, roleId, sendOpts): Promise<void> {
      await call(() =>
        client.rest.put(Routes.guildMemberRole(guildId, userId, roleId), {
          ...(sendOpts?.signal ? { signal: sendOpts.signal } : {}),
        }),
      );
    },

    async setNickname(guildId, userId, nickname, sendOpts): Promise<void> {
      await call(() =>
        client.rest.patch(Routes.guildMember(guildId, userId), {
          body: { nick: nickname },
          ...(sendOpts?.signal ? { signal: sendOpts.signal } : {}),
        }),
      );
    },
  };
}
