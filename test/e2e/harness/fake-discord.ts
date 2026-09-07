import {
  createGatewayCounter,
  DiscordSendError,
  GATEWAY_EVENTS,
  type DiscordGateway,
  type GatewayEventName,
  type GatewayEventRecord,
  type SendOptions,
  type SendPayload,
  type SentMessage,
} from '../../../src/discord/client.js';

/**
 * ★ 가짜 디스코드 (계획 §S3 B-2) — **차용 대상이 없어 새로 만든다.**
 *
 *   chzzkbot 은 `discord.js` 를 쓰지 않는다(스펙 Technical Context 의 "미보유" 항목:
 *   *"디스코드 봇 본체(`discord.js` 의존성 없음. 현재 디스코드는 웹훅 단방향 발송뿐)"*).
 *   즉 **차용할 하니스가 없고**, `fake-chzzkbot.ts` 만으로는 §9.3 의 "공지 N건" 판정을
 *   낼 수 없다. §14 차용 목록에도 없다.
 *
 * **최소 능력 4종** (계획 §S3 표. 이보다 적으면 §9.3 의 어떤 행이 판정 불가가 된다)
 *   ① 발송 메시지 캡처 — 내용 · 대상 채널 · 호출 횟수 · 순서
 *   ② 게이트웨이 재연결 이벤트 주입 + 카운트 (AC-P3 (a))
 *   ③ 역할 부여 · 닉네임 변경 호출 기록 (AC-6 · AC-11 · AC-12)
 *   ④ 실패 주입 — 429(`Retry-After`) · 403 · 5xx · 무응답(타임아웃)
 *
 * ★ ②의 카운터는 `src/discord/client.ts` 의 `createGatewayCounter` 를 **그대로
 *   import 한다.** 세는 규칙을 여기 다시 적으면 그 둘이 갈리는 날 테스트만 옳아지고
 *   운영 지표 `discord_gateway_reconnects` 는 다른 값을 본다 (계획 §S3 B-2 ★).
 */

// ══════════════════════════════════════════════════════════════════
//  ① 기록
// ══════════════════════════════════════════════════════════════════

export interface SentRecord {
  channelId: string;
  payload: SendPayload;
  messageId: string;
  at: number;
  /** 몇 번째 발송인가 (1부터). 순서 단언에 쓴다 */
  seq: number;
}

export interface RoleGrantRecord {
  guildId: string;
  userId: string;
  roleId: string;
  ok: boolean;
  error?: string;
  at: number;
}

export interface NicknameRecord {
  guildId: string;
  userId: string;
  nickname: string | null;
  ok: boolean;
  error?: string;
  at: number;
}

// ══════════════════════════════════════════════════════════════════
//  ④ 실패 주입
// ══════════════════════════════════════════════════════════════════

export type FakeFailure =
  /** 429. `retryAfterMs` 를 실어 보낸다 — 발송기가 백오프보다 이걸 우선해야 한다 */
  | { kind: 'rate-limited'; retryAfterMs?: number }
  /** 403 권한 부족. 재시도해도 안 풀린다 */
  | { kind: 'forbidden' }
  /** 5xx */
  | { kind: 'server'; status?: number }
  /**
   * ★ **응답을 영영 주지 않는다.** `AbortSignal` 로만 끊긴다 —
   *   §5.6.1 타임아웃 배선이 실제로 걸려 있는지는 이 주입으로만 검증된다.
   */
  | { kind: 'hang' }
  /** 네트워크 오류 등 분류 불가 */
  | { kind: 'unknown'; message?: string };

export interface FakeDiscordOptions {
  now?: () => number;
  /** 발송에 얹는 인위적 지연 (ms). `hang` 과 달리 결국은 응답한다 */
  delayMs?: number;
}

export interface FakeDiscord extends DiscordGateway {
  readonly sent: readonly SentRecord[];
  readonly roleGrants: readonly RoleGrantRecord[];
  readonly nicknames: readonly NicknameRecord[];
  readonly loginCount: number;
  readonly destroyed: boolean;
  /** 게이트웨이 이벤트 전체 기록 (끊김·재접속·재개) */
  readonly gatewayEvents: readonly GatewayEventRecord[];

  /** ② 재연결 주입. 프로덕션이 구독하는 것과 **같은 이름**만 받는다 */
  emitGatewayEvent(name: GatewayEventName): void;
  /** ② 한 번의 완전한 재연결 (끊김 → 재접속 → 재개) */
  simulateReconnect(): void;

  /** ④ 다음 `times` 회를 실패시킨다 */
  failNext(failure: FakeFailure, times?: number): void;
  /** ④ 해제할 때까지 계속 실패시킨다. `undefined` 로 해제 */
  failAlways(failure?: FakeFailure): void;
  /** 발송 지연을 바꾼다 */
  setDelayMs(ms: number): void;
  /** 기록을 비운다 (재시작 시나리오) */
  reset(): void;
}

/** 실패 명세를 프로덕션 분류기가 읽는 모양의 예외로 바꾼다 */
function toError(f: FakeFailure): DiscordSendError {
  switch (f.kind) {
    case 'rate-limited':
      return new DiscordSendError('rate-limited', '레이트리밋', 429, f.retryAfterMs ?? 1_000);
    case 'forbidden':
      return new DiscordSendError('forbidden', '권한이 없습니다', 403);
    case 'server':
      return new DiscordSendError('server', '서버 오류', f.status ?? 503);
    case 'unknown':
      return new DiscordSendError('unknown', f.message ?? '알 수 없는 오류');
    case 'hang':
      // 여기로 오지 않는다 — hang 은 예외가 아니라 "응답 없음" 이다.
      return new DiscordSendError('timeout', '무응답');
  }
}

export function createFakeDiscord(opts: FakeDiscordOptions = {}): FakeDiscord {
  const now = opts.now ?? Date.now;
  const counter = createGatewayCounter();

  const sent: SentRecord[] = [];
  const roleGrants: RoleGrantRecord[] = [];
  const nicknames: NicknameRecord[] = [];
  const gatewayEvents: GatewayEventRecord[] = [];

  let loginCount = 0;
  let destroyed = false;
  let delayMs = opts.delayMs ?? 0;
  let seq = 0;

  /** 남은 일회성 실패 */
  const queued: FakeFailure[] = [];
  let always: FakeFailure | undefined;

  function nextFailure(): FakeFailure | undefined {
    return queued.shift() ?? always;
  }

  function emitGatewayEvent(name: GatewayEventName): void {
    const at = now();
    counter.record(name, at);
    gatewayEvents.push({ name, at });
  }

  /** 지연·무응답·중단을 한 곳에서 처리한다 */
  async function gate(failure: FakeFailure | undefined, signal?: AbortSignal): Promise<void> {
    if (failure?.kind === 'hang') {
      // ★ 절대 스스로 resolve 하지 않는다. 시그널만이 이 프라미스를 끝낸다.
      await new Promise<never>((_, reject) => {
        const abort = (): void => {
          reject(new DiscordSendError('timeout', 'The operation was aborted'));
        };
        if (signal?.aborted === true) {
          abort();
          return;
        }
        signal?.addEventListener('abort', abort, { once: true });
      });
      return;
    }
    if (delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(new DiscordSendError('timeout', 'The operation was aborted'));
          },
          { once: true },
        );
      });
    }
    if (failure !== undefined) throw toError(failure);
  }

  return {
    get sent() {
      return sent;
    },
    get roleGrants() {
      return roleGrants;
    },
    get nicknames() {
      return nicknames;
    },
    get gatewayEvents() {
      return gatewayEvents;
    },
    get loginCount() {
      return loginCount;
    },
    get destroyed() {
      return destroyed;
    },
    get reconnectCount() {
      return counter.reconnectCount;
    },

    // ── DiscordGateway ────────────────────────────────────────────
    login(): Promise<void> {
      loginCount += 1;
      destroyed = false;
      return Promise.resolve();
    },

    destroy(): Promise<void> {
      destroyed = true;
      return Promise.resolve();
    },

    async send(channelId: string, payload: SendPayload, sendOpts?: SendOptions): Promise<SentMessage> {
      await gate(nextFailure(), sendOpts?.signal);
      seq += 1;
      const messageId = `fake-msg-${String(seq)}`;
      sent.push({ channelId, payload, messageId, at: now(), seq });
      return { id: messageId };
    },

    async addRole(guildId: string, userId: string, roleId: string, sendOpts?: SendOptions): Promise<void> {
      try {
        await gate(nextFailure(), sendOpts?.signal);
      } catch (e: unknown) {
        roleGrants.push({
          guildId,
          userId,
          roleId,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          at: now(),
        });
        throw e;
      }
      roleGrants.push({ guildId, userId, roleId, ok: true, at: now() });
    },

    async setNickname(
      guildId: string,
      userId: string,
      nickname: string | null,
      sendOpts?: SendOptions,
    ): Promise<void> {
      try {
        await gate(nextFailure(), sendOpts?.signal);
      } catch (e: unknown) {
        nicknames.push({
          guildId,
          userId,
          nickname,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          at: now(),
        });
        throw e;
      }
      nicknames.push({ guildId, userId, nickname, ok: true, at: now() });
    },

    // ── 테스트 조작 ───────────────────────────────────────────────
    emitGatewayEvent,

    simulateReconnect(): void {
      // 실제 discord.js 가 내는 순서 그대로 — 이 셋 중 하나만 세는 규칙은
      // `createGatewayCounter` 안에 있고 프로덕션과 공유한다.
      for (const name of GATEWAY_EVENTS) {
        emitGatewayEvent(name);
      }
    },

    failNext(failure: FakeFailure, times = 1): void {
      for (let i = 0; i < times; i++) queued.push(failure);
    },

    failAlways(failure?: FakeFailure): void {
      always = failure;
    },

    setDelayMs(ms: number): void {
      delayMs = ms;
    },

    /**
     * ★ `reconnectCount` 와 게이트웨이 기록은 **비우지 않는다.**
     *   운영 지표 `discord_gateway_reconnects` 가 프로세스 생애 누적값이므로
     *   여기서 리셋하면 "부하 구간 전후의 차이"(AC-P3 (a))를 재는 축이 달라진다.
     *   재연결 기록까지 지우고 싶으면 하니스를 새로 만든다.
     */
    reset(): void {
      sent.length = 0;
      roleGrants.length = 0;
      nicknames.length = 0;
      queued.length = 0;
      always = undefined;
      delayMs = opts.delayMs ?? 0;
      seq = 0;
    },
  };
}
