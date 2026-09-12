import { Events, Routes } from 'discord.js';
import type { Client } from 'discord.js';
import type { Logger } from 'pino';

import { createFollowerChecker, type FollowerChecker } from './chzzk/follower-check.js';
import { createLiveApiClient } from './chzzk/live-api-client.js';
import {
  createViewerTokenClient,
  type ViewerTokenClient,
} from './chzzk/oauth/viewer-token.js';
import { ConfigError, exitOnConfigError, loadConfig } from './config/loader.js';
import type { AppConfig } from './config/schema.js';
import {
  buildAnnouncementEmbed,
  createAnnouncer,
  type Announcer,
} from './discord/announcer.js';
import {
  createDiscordClient,
  createDiscordGateway,
  type DiscordGateway,
  type SendOptions,
} from './discord/client.js';
import {
  createGateChannelCommand,
  GATE_CHANNEL_OPTION_NAME,
} from './discord/commands/gate-channel.js';
import { createLinkCommand } from './discord/commands/link.js';
import { createAuthGuard, type AuthGuard } from './discord/commands/guard.js';
import { createStatusCommand } from './discord/commands/status.js';
import { createUnlinkCommand } from './discord/commands/unlink.js';
import type {
  Command,
  CommandContext,
  CommandReply,
  SlashCommand,
} from './discord/commands/types.js';
import type { GateGateway } from './discord/gate.js';
import { createInteractionRouter } from './discord/interactions.js';
import { unknownButtonMessage } from './discord/messages.js';
import {
  AUTH_PANEL_BUTTON_LINK,
  AUTH_PANEL_BUTTON_STATUS,
  createAuthPanelKeeper,
  describeAuthPanelResult,
  type AuthPanelKeeper,
} from './discord/panel.js';
import { buildUploadPayload, uploadLabel } from './discord/upload-embed.js';
import {
  jobFromOutbox,
  shouldSuppressLiveResend,
  type LiveAnnounceFn,
  type LiveAnnounceJob,
  type LiveDetectedVia,
  type LiveSessionStore,
} from './live/live-announce.js';
import { createLivePoller, type LivePoller } from './live/live-poller.js';
import { isConfirmedStuck, type LiveStateInput } from './live/live-state.js';
import {
  buildSpecs,
  createStuckWatch,
  type StuckAlert,
  type StuckDomain,
  type StuckWatch,
} from './live/stuck-watch.js';
import {
  createWebhookSilenceWatch,
  type WebhookSilenceWatch,
} from './live/webhook-silence-watch.js';
import {
  isStaleUploadResend,
  measureDowntime,
  recoverLive,
  recoverYoutube,
  type DowntimeWindow,
} from './recovery/downtime.js';
import {
  createOpsAlertService,
  createSwappableAlertState,
  type AlertEvent,
  type OpsAlertService,
} from './runtime/alerts/ops-alert-service.js';
import { createDiscordNotifier, type Notifier } from './runtime/alerts/discord-webhook.js';
import { SYSTEM_SCOPE } from './runtime/alerts/types.js';
import { systemClock, type Clock, type Disposable } from './runtime/clock.js';
import { startHeartbeat } from './runtime/heartbeat.js';
import {
  createHttpBudget,
  type HttpBudget,
  type OutboundCall,
} from './runtime/http-budget.js';
import {
  createLivenessStamp,
  readLastSeenAt,
  type LivenessStamp,
} from './runtime/liveness-stamp.js';
import { createLogger } from './runtime/logger.js';
import {
  createMetricsRegistry,
  type MetricsRegistry,
} from './runtime/metrics.js';
import { createOutbox, type Outbox, type OutboxRow } from './runtime/outbox.js';
import { ShutdownManager } from './runtime/shutdown.js';
import { acquireLock, LockHeldError, type InstanceLock } from './runtime/single-instance.js';
import { DB_ERROR_EXIT_CODE, DbError, openDb, type Db } from './store/db.js';
import { currentVersion, migrate } from './store/migrate.js';
import {
  createAlertStateRepo,
  type AlertStateRepo,
} from './store/repos/alert-state-repo.js';
import {
  createAnnouncementLedgerRepo,
  type AnnouncementKind,
  type AnnouncementLedgerRepo,
  type DetectedVia,
} from './store/repos/announcement-ledger-repo.js';
import {
  createGuildConfigRepo,
  type GuildConfigRepo,
} from './store/repos/guild-config-repo.js';
import { createLinkRepo, type LinkRepo } from './store/repos/link-repo.js';
import {
  createLiveSessionRepo,
  type LiveSessionRepo,
} from './store/repos/live-session-repo.js';
import { createOpsEventRepo, type OpsEventRepo } from './store/repos/ops-event-repo.js';
import {
  createRuntimeStateRepo,
  type RuntimeStateRepo,
} from './store/repos/runtime-state-repo.js';
import { createVerificationSessionRepo } from './store/repos/verification-session-repo.js';
import { createWebSubSubRepo } from './store/repos/websub-sub-repo.js';
import { createYoutubeChannelRepo } from './store/repos/youtube-channel-repo.js';
import { createChzzkbotWebhookRoute } from './web/routes/chzzkbot-webhook.js';
import { createHealthRoute } from './web/routes/health.js';
import {
  createOAuthCallbackRoute,
  createOAuthStartRoute,
  OAUTH_CALLBACK_PATH,
  type GuildTarget,
} from './web/routes/oauth-callback.js';
import {
  createSignatureFailureCounter,
  createWebSubRoutes,
  WEBSUB_PATH,
  type SignatureFailureCounter,
} from './web/routes/websub.js';
import {
  BindInUseError,
  createWebServer,
  listenWithRetry,
  type BoundAddress,
  type Route,
  type WebServer,
} from './web/server.js';
import {
  AUTH_PENDING_MAX_ALERT,
  createVerificationSessionStore,
  type VerificationSessionStore,
} from './web/session.js';
import { parseFeed, type FeedEntry } from './youtube/feed-parse.js';
import { createTextClient } from './youtube/http-text.js';
import {
  createRssPoller,
  feedUrl,
  RSS_CHANNEL_BUDGET_MS,
  type RssPoller,
} from './youtube/rss-poller.js';
import { createUploadFlow, type UploadSender } from './youtube/upload-flow.js';
import { createWebSubClient, type WebSubClient } from './youtube/websub-client.js';

/**
 * ★★★ composition-root — 계획 §S8.
 *
 * 이 파일이 하는 일은 **배선뿐**이다. 판정도 정책도 여기 없다 —
 * 3상태 판정은 `live/live-state.ts`, 스트릭은 `live/stuck-watch.ts`, 중복 방지는
 * `announcement_ledger` 가 소유한다. 여기서 규칙을 한 줄이라도 다시 쓰면
 * 그 순간 규칙이 두 곳에 생기고, §10 시나리오 1 이 지목한 결함이 되살아난다.
 *
 * ★★ **기동 순서를 바꾸지 않는다** (계획 §5.4 rev.3).
 *
 * ```
 *   ① 포트 바인드 (listenWithRetry)   ← 상호배제의 1차 프리미티브
 *   ② PID 락       (single-instance)
 *   ③ DB 열기 + 마이그레이션
 *   ④ 디스코드 → 발송기 → 아웃박스 → 복구 → 폴러·감시자
 * ```
 *
 *   ①이 ②보다 먼저인 이유가 이 순서의 전부다. PID 락은 **죽은 PID 의 락을 인수한다** —
 *   그렇게 하지 않으면 크래시 한 번에 사람이 락 파일을 지워야 하기 때문이다.
 *   그래서 좀비가 포트를 붙들고 있으면 **락 인수는 성공하고 `listen` 이 EADDRINUSE 로
 *   실패한다.** 포트를 먼저 잡으면 그 상태가 애초에 만들어지지 않는다.
 *
 * ★ **상수를 다시 적지 않는다.** 주기·임계·타임아웃은 전부 `config/schema.ts` 에서
 *   읽는다. §2-b 가 신설된 이유가 *"7분/8분이 16곳에 갈린 것은 값을 잘못 고른 문제가
 *   아니라 정의가 여러 곳에 복제된 문제였다"* 이기 때문이다.
 *
 * ★ `bootstrap()` 과 `start()` 를 나눈다. 기동 복구(§S7)의 효과 — 공지 건수 ·
 *   `ops_events` 1건 · `unknown` 스트릭 1회차 — 는 **주기 폴러가 돌기 전에** 관측돼야
 *   판정할 수 있다. 둘을 한 함수에 두면 첫 폴이 그 값을 덮어 테스트가 무엇을 세는지
 *   알 수 없게 된다.
 */

// ══════════════════════════════════════════════════════════════════
//  종료 코드 — ★ 새로 만들지 않는다
// ══════════════════════════════════════════════════════════════════

/**
 * 락을 잡지 못했다 = 다른 인스턴스가 살아 있다.
 *
 * ★ `DB_ERROR_EXIT_CODE`(70)를 **재사용한다.** 런북 §4-4 가 *"exit 70 — DB / 락"* 으로
 *   묶어 두었고, 유닛의 `RestartPreventExitStatus=78 70` 에 이미 들어 있다.
 *   새 코드를 만들면 그 한 줄을 함께 고쳐야 하고, 빠뜨리는 순간 무한 재시작
 *   플래핑이 되살아난다 (`web/server.ts` 의 `BIND_ERROR_EXIT_CODE` 와 같은 이유).
 */
export const LOCK_ERROR_EXIT_CODE = DB_ERROR_EXIT_CODE;

export const DEFAULT_CONFIG_PATH = 'config/config.yaml';

/** `/연동해제` · `/연동상태` 의 대상 옵션 이름 (`commands/*.ts` 의 정의와 같은 값) */
export const TARGET_OPTION_NAME = '대상';

/**
 * `follower-stale` 도메인의 스트릭 임계.
 *
 * ★★ 이 도메인은 `armed: false` 다 (`stuck-watch.ts`). 즉 이 숫자는 **경보를 내지
 *   않고** "한 에피소드가 언제 끝나는가" 만 정한다 — 지표(`stuck.value`)는 임계와
 *   무관하게 센다. `follower.staleAfterMin`(150분)이 S1-J 실측 전까지 잠정값이라
 *   그 위에 얹는 임계도 검증할 수 없으므로 **설정 항목으로 올리지 않는다.**
 *   config 에 두면 "조정할 수 있는 값" 으로 보이고, 검증되지 않은 임계를 조정하는
 *   것은 조정이 아니라 추측이다. S1-J 가 끝나면 `armed: true` 와 함께 올린다.
 */
export const FOLLOWER_STALE_STREAK_COUNT = 5;

// ══════════════════════════════════════════════════════════════════
//  운영 기록 어휘 — `ops_events.kind`
// ══════════════════════════════════════════════════════════════════

/**
 * ★ `ops_events` 에는 CHECK 가 없다(§8). 그래서 문자열 유니온이 그 역할을 한다 —
 *   오타가 새 종류를 조용히 만들면 *"그동안 한 건도 안 났네"* 를 사실로 착각한다
 *   (`web/routes/chzzkbot-webhook.ts` 가 같은 이유로 같은 선택을 했다).
 */
export const MAIN_OPS_KINDS = [
  /** ★★ US-006 — 기동 복구의 조회가 `unknown` 이었다. AC-P2 로 이어지는 1회차 */
  'recovery_live_unknown',
  /** AC-30 — 다운타임 감지 · 밀린 유튜브 알림 생략 보고 */
  'recovery_downtime',
  /** 기동 복구의 RSS 훑기가 실패했다 */
  'recovery_rss_failed',
] as const;
export type MainOpsKind = (typeof MAIN_OPS_KINDS)[number];

// ══════════════════════════════════════════════════════════════════
//  지표 — §5.6.1 / §9.4
// ══════════════════════════════════════════════════════════════════

/** 지표 이름. 로그 필드로도 이 이름을 그대로 쓴다 — 두 축이 갈리지 않게 */
export const FOLLOWER_LOOKUP_LATENCY_METRIC = 'follower_lookup_ms';
export const OUTBOUND_TIMEOUT_METRIC = 'outbound_timeout_total';

export interface OutboundMetrics {
  /** `outbound_timeout_total{call}` */
  readonly timeouts: Readonly<Partial<Record<OutboundCall, number>>>;
  /** 마지막 왕복 시간. `follower-lookup` 값이 곧 `follower_lookup_ms` 다 */
  readonly lastLatencyMs: Readonly<Partial<Record<OutboundCall, number>>>;
  readonly latencyCount: Readonly<Partial<Record<OutboundCall, number>>>;
  recordTimeout(call: OutboundCall): void;
  recordLatency(call: OutboundCall, ms: number): void;
}

export function createOutboundMetrics(): OutboundMetrics {
  const timeouts: Partial<Record<OutboundCall, number>> = {};
  const lastLatencyMs: Partial<Record<OutboundCall, number>> = {};
  const latencyCount: Partial<Record<OutboundCall, number>> = {};
  return {
    timeouts,
    lastLatencyMs,
    latencyCount,
    recordTimeout(call): void {
      timeouts[call] = (timeouts[call] ?? 0) + 1;
    },
    recordLatency(call, ms): void {
      lastLatencyMs[call] = ms;
      latencyCount[call] = (latencyCount[call] ?? 0) + 1;
    },
  };
}

// ══════════════════════════════════════════════════════════════════
//  ★ 역할 캐시 조회 (AC-12 c)
// ══════════════════════════════════════════════════════════════════

/** `discord.js` 의 `Client` 중 역할 캐시 조회가 쓰는 만큼만 (하니스가 세 줄로 흉내낼 수 있게) */
export interface RoleCacheSource {
  guilds: {
    cache: {
      get(id: string):
        | {
            members: {
              cache: {
                get(id: string): { roles: { cache: { has(id: string): boolean } } } | undefined;
              };
            };
          }
        | undefined;
    };
  };
}

export type RoleCacheLookup = (
  guildId: string,
  userId: string,
  roleId: string,
) => boolean | undefined;

/**
 * ★★ **캐시에 없으면 `false` 가 아니라 `undefined` 다.**
 *
 *   `discord/gate.ts` 가 이 계약 위에 서 있다: `undefined` 면 그때만 REST 를 부르고,
 *   `true` 면 부르지 않는다(AC-12 c). `false` 로 접으면 *"캐시에 없다"* 가
 *   *"역할이 없다"* 로 읽혀 **매번 REST 를 부른다** — 같은 사람이 인증 버튼을 다섯 번
 *   누르면 호출도 다섯 번 나가고, 그건 429 를 스스로 부르는 짓이다.
 *
 *   옵셔널 체이닝이 그 성질을 그대로 만든다: 길드나 멤버가 캐시에 없으면
 *   `has()` 까지 가지 못하고 `undefined` 가 나온다.
 */
export function cacheRoleLookup(source: RoleCacheSource): RoleCacheLookup {
  return (guildId, userId, roleId) =>
    source.guilds.cache.get(guildId)?.members.cache.get(userId)?.roles.cache.has(roleId);
}

/** 게이트가 쓰는 만큼의 표면을 게이트웨이 + 캐시 조회로 조립한다 */
export function createGateGateway(
  gateway: DiscordGateway,
  lookup?: RoleCacheLookup,
): GateGateway {
  const base = {
    addRole: (guildId: string, userId: string, roleId: string, opts?: SendOptions) =>
      gateway.addRole(guildId, userId, roleId, opts),
    setNickname: (
      guildId: string,
      userId: string,
      nickname: string | null,
      opts?: SendOptions,
    ) => gateway.setNickname(guildId, userId, nickname, opts),
  };
  // ★ 조회를 못 꽂았으면 `hasRole` 자체를 두지 않는다. 있는 척하며 `false` 를 주면
  //   위 머리말의 사고가 그대로 난다.
  return lookup === undefined ? base : { ...base, hasRole: lookup };
}

// ══════════════════════════════════════════════════════════════════
//  옵션 / 앱
// ══════════════════════════════════════════════════════════════════

export interface BootstrapOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  clock?: Clock;
  logger?: Logger;
  /** 테스트 주입점 — 실제 게이트웨이 대신 하니스를 꽂는다 (계획 §S3 B-2) */
  gateway?: DiscordGateway;
  /** 테스트 주입점 — 역할 캐시 조회. 실제 `Client` 가 있으면 자동으로 꽂힌다 */
  roleLookup?: RoleCacheLookup;
  /** 테스트 주입점 — 운영 경보 알리미 */
  notifier?: Notifier;
  /** 경보 발화를 관측한다 (지표·테스트). 던지면 안 된다 */
  onAlertEvent?: (e: AlertEvent) => void;
  fetchImpl?: typeof fetch;
  /**
   * ★ 치명적 기동 실패의 종료 경로. 기본은 `process.exit`.
   *
   *   테스트는 던지는 함수를 꽂아 **테스트 러너를 죽이지 않고** exit 78 경로를
   *   확인한다 (`config/loader.ts` 의 `ExitOptions.exit` 와 같은 모양).
   */
  exit?: (code: number) => never;
  /** 설정 오류 시 재기동 폭주를 막는 대기. 테스트는 0 을 준다 */
  configErrorGraceMs?: number;
  /** 테스트 주입점 — 포트 재시도 창에서 실제로 30초를 기다리지 않기 위해 */
  bindRetry?: { now?: () => number; sleep?: (ms: number) => Promise<void> };
}

export interface App {
  readonly config: AppConfig;
  /** 실제로 열린 주소 (§5.4 rev.5 — "계약으로 같은 것") */
  readonly boundAddress: BoundAddress;
  /** `http://<bindAddress>:<port>` — 테스트가 실제 요청을 넣는 주소 */
  readonly baseUrl: string;
  readonly db: Db;
  readonly web: WebServer;
  readonly routes: readonly Route[];

  readonly gateway: DiscordGateway;
  readonly announcer: Announcer;
  readonly outbox: Outbox;
  readonly livePoller: LivePoller;
  readonly rssPoller: RssPoller;
  readonly websub: WebSubClient;
  readonly silenceWatch: WebhookSilenceWatch;
  readonly stuckWatch: StuckWatch;
  readonly liveness: LivenessStamp;

  readonly ledger: AnnouncementLedgerRepo;
  readonly links: LinkRepo;
  readonly liveSessions: LiveSessionRepo;
  readonly ops: OpsEventRepo;
  readonly runtimeState: RuntimeStateRepo;
  readonly alertState: AlertStateRepo;
  readonly guildConfig: GuildConfigRepo;

  readonly sessions: VerificationSessionStore;
  readonly followers: FollowerChecker;
  readonly authGuard: AuthGuard;
  readonly alerts: OpsAlertService;
  /**
   * 아웃바운드 **기록기** — `http-budget` 이 여기에 쓴다 (§5.6.1).
   *
   * ★ 아래 `metricsRegistry` 와 이름이 둘인 이유는 **역할이 둘이기 때문**이다.
   *   이쪽은 쓰는 곳이고 저쪽은 §9.4 표 전체를 **한 이름으로 읽는** 곳이다.
   *   레지스트리는 이 값을 읽기 함수로 가져간다 — 사본을 만들지 않는다.
   */
  readonly metrics: OutboundMetrics;
  /** ★ §9.4 지표의 단일 조회 지점 */
  readonly metricsRegistry: MetricsRegistry;
  readonly http: HttpBudget;
  readonly viewerToken: ViewerTokenClient;
  readonly signatureFailures: SignatureFailureCounter;
  /** AD-1 보호 목록 — `[live.channelId] ∪ chzzkbot 서빙 채널` */
  readonly protectedChannelIds: readonly string[];
  /** 기동 시점에 잰 다운타임 (AC-29/30) */
  readonly downtime: DowntimeWindow;
  /** 슬래시로 **등록되는** 명령 — 운영자용만 */
  readonly commands: ReadonlyMap<string, SlashCommand>;
  /** 패널 버튼 `custom_id` → 명령. 멤버용 진입점 */
  readonly buttons: ReadonlyMap<string, Command>;
  readonly authPanel: AuthPanelKeeper;

  /** 상호작용에서 뽑아낸 컨텍스트로 슬래시 명령을 태운다 */
  dispatchCommand(name: string, ctx: CommandContext): Promise<CommandReply>;
  dispatchButton(customId: string, ctx: CommandContext): Promise<CommandReply>;
  /** ④ 폴러·감시자 기동. 복구가 끝난 뒤에만 부른다 */
  start(): Promise<void>;
  /** 정리만 한다 — **프로세스를 끝내지 않는다** (그건 `main()` 의 일이다) */
  stop(reason?: string): Promise<void>;
  /** SIGTERM/SIGINT → 정리 → exit 0. 해제 함수를 돌려준다 */
  installSignalHandlers(): () => void;
}

// ══════════════════════════════════════════════════════════════════
//  조립
// ══════════════════════════════════════════════════════════════════

export async function bootstrap(opts: BootstrapOptions = {}): Promise<App> {
  const exit = opts.exit ?? ((code: number): never => process.exit(code));
  const clock = opts.clock ?? systemClock;
  const configPath = opts.configPath ?? DEFAULT_CONFIG_PATH;

  // ── 0. 설정 — fail-fast, exit 78 ──────────────────────────────
  let config: AppConfig;
  try {
    config = loadConfig({ configPath, ...(opts.env === undefined ? {} : { env: opts.env }) });
  } catch (e: unknown) {
    if (!(e instanceof ConfigError)) throw e;
    return exitOnConfigError(e, {
      exit,
      ...(opts.configErrorGraceMs === undefined ? {} : { graceMs: opts.configErrorGraceMs }),
      ...(opts.notifier === undefined
        ? {}
        : {
            notify: async (message: string): Promise<void> => {
              await opts.notifier?.send(message);
            },
          }),
    });
  }
  const { file, secrets } = config;

  const logger =
    opts.logger ??
    createLogger({
      level: file.logLevel,
      dir: file.paths.logs,
      retentionDays: file.logRetentionDays,
    });

  const notifier =
    opts.notifier ??
    createDiscordNotifier({
      url: secrets.DISCORD_OPS_WEBHOOK_URL,
      clock,
      ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
      onError: (reason) => {
        logger.warn({ reason }, '운영 경보 웹훅 발송 실패');
      },
    });

  const notify = async (message: string): Promise<void> => {
    try {
      await notifier.send(message);
    } catch {
      /* 경보 실패가 종료 경로를 막지 않는다 (Principle 2) */
    }
  };

  /**
   * ★ 라우트 표는 **변경 가능한 배열**이다.
   *
   *   서버는 요청마다 이 배열을 다시 훑으므로, 포트를 먼저 잡고(①) DB 를 연 뒤(③)
   *   실제 라우트를 밀어 넣을 수 있다. 순서를 지키면서 `/healthz` 만 먼저 열어 두는
   *   유일한 모양이다 — 그 사이의 `/healthz` 는 스키마 버전을 모르므로 **503 degraded**
   *   이고, 그것이 사실이다.
   */
  const routes: Route[] = [];
  let schemaVersion: number | undefined;

  routes.push(
    createHealthRoute({
      heartbeatPath: file.paths.heartbeat,
      clock,
      schemaVersion: () => schemaVersion,
    }),
  );

  const web = createWebServer({
    routes,
    onLog: (message, extra) => {
      logger.warn(extra ?? {}, message);
    },
  });

  // ── ① 포트 바인드 ─────────────────────────────────────────────
  let boundAddress: BoundAddress;
  try {
    boundAddress = await listenWithRetry(web, {
      port: file.web.port,
      host: file.web.bindAddress,
      retrySec: file.startup.bindRetrySec,
      onBound: (addr) => {
        // ★ **실제** 바인드 주소를 찍는다 (§5.4 rev.5).
        //   "우연히 같아지는 것과 계약으로 같은 것은 다르다."
        logger.info({ address: addr.address, port: addr.port }, '포트를 잡았습니다');
      },
      onRetry: (info) => {
        logger.warn(info, '포트가 점유돼 있습니다 — 백오프 후 재시도');
      },
      ...(opts.bindRetry?.now === undefined ? {} : { now: opts.bindRetry.now }),
      ...(opts.bindRetry?.sleep === undefined ? {} : { sleep: opts.bindRetry.sleep }),
    });
  } catch (e: unknown) {
    if (!(e instanceof BindInUseError)) throw e;
    // ★ 범인을 찾는 명령(`ss -ltnp | grep :<port>`)이 `format()` 안에 들어 있다.
    process.stderr.write(e.format());
    logger.error({ port: e.port, waitedMs: e.waitedMs, attempts: e.attempts }, e.message);
    await notify(`포트 점유로 기동에 실패했습니다 — ${e.message}`);
    return exit(e.exitCode);
  }

  const baseUrl = `http://${file.web.bindAddress}:${String(boundAddress.port)}`;

  /** 기동 도중 실패했을 때 이미 잡은 자원을 되돌린다 */
  const unwind = async (lock?: InstanceLock, db?: Db): Promise<void> => {
    db?.close();
    lock?.release();
    await web.close();
  };

  // ── ② PID 락 ──────────────────────────────────────────────────
  let lock: InstanceLock;
  try {
    lock = acquireLock(file.paths.lock);
  } catch (e: unknown) {
    if (!(e instanceof LockHeldError)) throw e;
    process.stderr.write(`\n${e.message}\n`);
    logger.error({ holderPid: e.holderPid, lock: file.paths.lock }, '단일 인스턴스 락 실패');
    await notify(`다른 인스턴스가 실행 중이라 기동하지 못했습니다 (pid ${String(e.holderPid)}).`);
    await unwind();
    return exit(LOCK_ERROR_EXIT_CODE);
  }

  // ── ③ DB 열기 + 마이그레이션 ─────────────────────────────────
  let db: Db;
  try {
    db = openDb({ path: file.paths.db });
    const applied = migrate(db);
    schemaVersion = currentVersion(db);
    logger.info(
      { applied: applied.applied, skipped: applied.skipped, schemaVersion },
      'DB 마이그레이션 완료',
    );
  } catch (e: unknown) {
    const text = e instanceof DbError ? e.format() : `\nDB 를 준비하지 못했습니다: ${String(e)}\n`;
    process.stderr.write(text);
    logger.error({ detail: e instanceof Error ? e.message : String(e) }, 'DB 준비 실패');
    await notify('DB 를 준비하지 못해 기동에 실패했습니다. docs/runbook-ops.md §4-4 를 보십시오.');
    await unwind(lock);
    return exit(DB_ERROR_EXIT_CODE);
  }

  // ── 지표 레지스트리 (§9.4) ───────────────────────────────────
  /**
   * ★ **저장소보다 먼저 만든다.** 원장이 선점 결과를 여기로 흘려야 하는데
   *   그 시점이 팔로워 판정기·게이트웨이보다 앞이다. 읽기 함수는 조립이
   *   끝난 뒤 `bind()` 로 한 번에 꽂는다 (`runtime/metrics.ts` 머리말).
   */
  const metricsRegistry: MetricsRegistry = createMetricsRegistry();

  /**
   * 원장 → §9.4.
   *
   * ★ 감지 경로 라벨(`live_detected_via` · `youtube_detected_via`)과 중복 차단 수
   *   (`announcement_claim_conflicts`)가 **같은 한 곳**에서 나온다. 선점의 성패를
   *   아는 자리가 거기뿐이기 때문이다.
   */
  const ledgerMetrics = {
    claimed(kind: AnnouncementKind, via: DetectedVia): void {
      metricsRegistry.count(
        kind === 'live_start' ? 'live_detected_via' : 'youtube_detected_via',
        via,
      );
    },
    conflict(kind: AnnouncementKind): void {
      metricsRegistry.count('announcement_claim_conflicts', kind);
    },
  };

  // ── 저장소 ────────────────────────────────────────────────────
  const ledger = createAnnouncementLedgerRepo(db, { metrics: ledgerMetrics });
  const links = createLinkRepo(db);
  const liveSessions = createLiveSessionRepo(db);
  const runtimeState = createRuntimeStateRepo(db);
  const alertStateRepo = createAlertStateRepo(db);
  const guildConfig = createGuildConfigRepo(db);
  const youtubeChannels = createYoutubeChannelRepo(db);
  const websubSubs = createWebSubSubRepo(db);
  const ops = createOpsEventRepo(db, {
    onError: (detail) => {
      logger.error({ detail }, 'ops_events 기록 실패');
    },
  });

  /**
   * ★ 포트 타입에 대입해 **구조가 갈리는 것을 컴파일이 잡게 한다.**
   *   `store`(L2)는 `live`(L4)를 import 할 수 없어 저장소가 포트 타입을 모른다 —
   *   그 대신 이 한 줄이 그 자리를 지킨다 (`live-session-repo.ts` 머리말).
   */
  const liveSessionStore: LiveSessionStore = liveSessions;

  // ── 경보 ──────────────────────────────────────────────────────
  // ★ 서비스는 DB 보다 먼저 필요할 수 있어(중복 기동·DB 오류) 메모리로 시작하고
  //   여기서 DB 구현으로 갈아 끼운다. 메모리에 쌓인 것은 옮기지 않는다 —
  //   그 구간에서 경보를 내는 경로는 곧바로 프로세스를 끝내는 것들뿐이다.
  const alertState = createSwappableAlertState();
  alertState.swap(alertStateRepo);

  const alerts = createOpsAlertService({
    notifier,
    state: alertState,
    clock,
    scope: SYSTEM_SCOPE,
    minIntervalMin: file.alerts.minIntervalMin,
    enabled: file.alerts.enabled,
    onEvent: (e) => {
      logger.info(e, '운영 경보');
      try {
        opts.onAlertEvent?.(e);
      } catch {
        /* 관측이 경보를 죽이면 안 된다 */
      }
    },
  });
  const liveAlerts = alerts.forScope(file.live.channelId);

  // ── 하트비트 · 생존 표식 ──────────────────────────────────────
  const heartbeat: Disposable = startHeartbeat({
    path: file.paths.heartbeat,
    clock,
    onError: (err) => {
      logger.warn({ detail: err instanceof Error ? err.message : String(err) }, '하트비트 쓰기 실패');
    },
  });

  /**
   * ★★ **표식을 읽는 것이 찍는 것보다 먼저다.**
   *   순서를 뒤집으면 방금 찍은 값을 읽어 다운타임이 언제나 0 이 되고,
   *   AC-29/30 이 조용히 죽는다 — 침묵하는 누락이라 아무도 모른다.
   */
  const downtime = measureDowntime(
    readLastSeenAt(runtimeState),
    clock.now(),
    file.recovery.downtimeThresholdHours,
  );
  const liveness = createLivenessStamp({
    store: runtimeState,
    clock,
    onError: (detail) => {
      logger.warn({ detail }, '생존 표식 갱신 실패');
    },
  });
  liveness.stampNow();

  // ── 아웃바운드 예산 (§5.6.1) ─────────────────────────────────
  const metrics = createOutboundMetrics();
  const http: HttpBudget = createHttpBudget({
    maxConcurrent: file.http.maxConcurrent,
    now: () => clock.now(),
    ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
    onTimeout: (call) => {
      metrics.recordTimeout(call);
      logger.warn(
        { metric: OUTBOUND_TIMEOUT_METRIC, call, total: metrics.timeouts[call] },
        '아웃바운드 타임아웃',
      );
    },
    onLatency: (call, ms) => {
      metrics.recordLatency(call, ms);
      if (call === 'follower-lookup') {
        // ★ 지표 이름을 로그 필드로 그대로 쓴다. 두 축이 갈리면 대시보드와
        //   로그가 다른 값을 보게 된다.
        logger.debug({ metric: FOLLOWER_LOOKUP_LATENCY_METRIC, ms }, '팔로워 조회 왕복');
      }
    },
  });
  const textClient = createTextClient(http);

  // ── 스트릭 감시 (AC-P1 · P2 · P4 · P7) ───────────────────────
  const stuckWatch: StuckWatch = createStuckWatch({
    specs: buildSpecs({
      confirmedStuckMs: file.live.confirmedStuckMin * 60_000,
      pollFailCount: file.live.pollFailThresholdCount,
      rssFailCount: file.youtube.rssFailThresholdCount,
      renewFailCount: file.youtube.renewFailThresholdCount,
      followerStaleCount: FOLLOWER_STALE_STREAK_COUNT,
    }),
  });

  /** 발화한 스트릭을 그 스코프의 운영 채널로 올린다 */
  const raiseStuck = async (alert: StuckAlert): Promise<void> => {
    const scoped = alerts.forScope(alert.scopeKey);
    const value =
      alert.mode === 'duration'
        ? `${String(Math.round(alert.value / 60_000))}분 지속 (임계 ${String(Math.round(alert.threshold / 60_000))}분)`
        : `${String(alert.value)}회 연속 (임계 ${String(alert.threshold)}회)`;
    await scoped.raise(alert.kind, `${alert.domain} — ${value}\n대상: ${alert.scopeKey}`);
  };

  // ── 디스코드 ──────────────────────────────────────────────────
  let client: Client | undefined;
  let gateway: DiscordGateway;
  if (opts.gateway !== undefined) {
    gateway = opts.gateway;
  } else {
    client = createDiscordClient();
    gateway = createDiscordGateway({
      token: secrets.DISCORD_BOT_TOKEN,
      client,
      clock,
      onGatewayEvent: (e, reconnectCount) => {
        // 지표 `discord_gateway_reconnects` — 하니스가 세는 것과 같은 값이다.
        logger.warn(
          { event: e.name, discord_gateway_reconnects: reconnectCount },
          '디스코드 게이트웨이 이벤트',
        );
      },
    });
  }
  await gateway.login();

  const announcer = createAnnouncer({
    gateway,
    alerts,
    clock,
    onEvent: (e) => {
      // ★ AC-19 — `failed` 는 **최종 실패 1건마다 정확히 한 번** 나온다
      //   (재시도 중은 `retrying`). 그래서 여기가 `discord_send_failures` 의 자리다.
      //   발송기 안에 카운터를 두지 않는 이유: 이 이벤트가 이미 그 사실을
      //   내보내고 있고, 같은 사건을 두 번 세면 두 숫자가 갈릴 수 있다.
      if (e.outcome === 'failed') metricsRegistry.count('discord_send_failures', e.kind);
      logger.info(e, '공지 발송');
    },
  });

  // ── 공지 대상 채널 · 길드 (guild_config) ─────────────────────
  /**
   * ⚠️ `verification_sessions` 에 **`guild_id` 컬럼이 없다**(§8). 그래서 콜백은
   *   길드를 세션에서 읽을 수 없고 여기서 해석한다. **단일 길드 배포가 전제**이며,
   *   없거나 둘 이상이면 `undefined` 를 준다 — 콜백은 그것을 받아 `no-guild` 로
   *   인증을 끝낸다. **아무 길드나 고르지 않는다.**
   */
  const resolveGuild = (): GuildTarget | undefined => {
    const row = guildConfig.single();
    if (row === undefined || row.verifiedRoleId === undefined) return undefined;
    return { guildId: row.guildId, verifiedRoleId: row.verifiedRoleId };
  };

  // ── 공지 ──────────────────────────────────────────────────────
  /** 아웃박스 재발송이 임베드를 다시 만들 때 쓰는 최근 피드 엔트리 */
  const uploadEntries = new Map<string, FeedEntry>();

  /**
   * 게시가 끝난 시각으로 §9.4 의 두 지연 지표를 남긴다.
   *
   * ★★ **성공했을 때만 남긴다.** 실패한 시도는 "게시" 가 아니므로 그 시간을
   *   섞으면 AC-15 의 p95 가 **재시도 대기 시간을 자기 지연으로** 세게 된다.
   *   실패 자체는 `discord_send_failures` 가 센다.
   */
  const recordPostLatency = (job: LiveAnnounceJob, doneMs: number): void => {
    if (job.webhookReceivedAtMs !== undefined) {
      metricsRegistry.duration('live_webhook_to_post_ms', doneMs - job.webhookReceivedAtMs);
    }
    if (job.openedAt === undefined) return;
    const opened = Date.parse(job.openedAt);
    // ★ 파싱 불가·미래 시각은 넣지 않는다. 음수 지연 하나가 분포를 조용히 망친다.
    if (Number.isFinite(opened) && doneMs >= opened) {
      metricsRegistry.duration('live_opened_to_post_ms', doneMs - opened);
    }
  };

  const liveAnnounce: LiveAnnounceFn = async (job) => {
    const at = clock.date().toISOString();
    const channelId = guildConfig.single()?.liveChannelId;
    if (channelId === undefined) {
      // ★ 원장 행은 그대로 둔다. 채널을 설정하면 아웃박스가 이 행을 다시 집는다 —
      //   지우면 그 방송은 영영 공지되지 않는다 (§3-a 2위).
      ledger.markFailed('live_start', job.liveHash, 'guild_config.live_channel_id 미설정', at);
      logger.error({ liveHash: job.liveHash }, '방송 공지 채널이 설정돼 있지 않습니다');
      return;
    }
    // ★ 웹훅·폴링·기동복구가 **전부** 여기를 지난다. 그림 관측을 경로별 이벤트가 아니라
    //   이 한 줄에 두는 이유다 — 폴링이 도는 상황은 웹훅이 죽었을 때이고, 그때 웹훅
    //   로그만 보라고 안내하면 진단이 첫 단계에서 막힌다 (런북 §8-d).
    logger.info(
      {
        liveHash: job.liveHash,
        detectedVia: job.detectedVia,
        image: job.imageSource,
        ...(job.droppedImageFields === undefined ? {} : { imageDropped: job.droppedImageFields }),
      },
      '방송 공지 그림',
    );
    const result = await announcer.announce({
      channelId,
      // ★ `LiveEmbedFields` → `EmbedSpec`. 두 타입이 갈리면 이 줄이 깨진다.
      payload: { embeds: [buildAnnouncementEmbed(job.embed)] },
      label: job.label,
    });
    const done = clock.date().toISOString();
    if (result.ok) {
      ledger.markSent('live_start', job.liveHash, result.messageId, done);
      recordPostLatency(job, clock.now());
    } else ledger.markFailed('live_start', job.liveHash, result.reason, done);
  };

  const uploadSender: UploadSender = async (entry, detectedVia) => {
    uploadEntries.set(entry.videoId, entry);
    const channelId = guildConfig.single()?.uploadChannelId;
    if (channelId === undefined) {
      return { ok: false, reason: 'guild_config.upload_channel_id 미설정' };
    }
    const result = await announcer.announce({
      channelId,
      payload: buildUploadPayload(entry, detectedVia),
      label: uploadLabel(entry),
    });
    return result.ok
      ? { ok: true, messageId: result.messageId }
      : { ok: false, reason: result.reason };
  };

  // ── 아웃박스 (§S3 FM5) ───────────────────────────────────────
  const LIVE_VIA: readonly string[] = ['webhook', 'api-poll', 'recovery'];
  const toLiveVia = (v: string): LiveDetectedVia =>
    LIVE_VIA.includes(v) ? (v as LiveDetectedVia) : 'api-poll';
  const UPLOAD_VIA: readonly string[] = ['websub', 'rss', 'recovery', 'seed'];
  const toUploadVia = (v: string): DetectedVia =>
    UPLOAD_VIA.includes(v) ? (v as DetectedVia) : 'rss';

  const resend = async (row: OutboxRow): Promise<void> => {
    if (row.kind === 'live_start') {
      // 세션 행이 남아 있으면 제목·시작 시각까지 그대로 되살린다.
      const session = liveSessions.get(row.eventKey);

      /**
       * ★★ **이미 끝난 방송의 시작 공지는 보내지 않는다.**
       *
       *   라이브 공지는 시점이 곧 내용이다 — 끝난 뒤에 나가면 늦은 공지가 아니라
       *   **거짓 공지**다. 디스코드가 몇 시간 죽어 있다 살아난 날, 이 문이 없으면
       *   지나간 방송이 "지금 시작되었습니다" 로 튀어나온다.
       *
       * ★ 행을 지우지 않고 **종결**한다 — 지우면 폴백이 재선점해 중복이 난다.
       */
      // ★ 세션을 알면 그 판정이 우선이고(진행 중이면 보낸다), 모를 때만 나이로 가른다.
      //   업로드와 같은 임계값을 쓴다 — "얼마나 지난 알림까지 의미가 있는가" 는 같은 질문이다.
      const staleByAge = isStaleUploadResend(
        Date.parse(row.claimedAt),
        clock.now(),
        file.recovery.downtimeThresholdHours,
      );
      if (shouldSuppressLiveResend(session, staleByAge)) {
        const reason =
          session === undefined
            ? `종결: 세션 기록이 없고 감지 후 ${String(file.recovery.downtimeThresholdHours)}시간을 넘김`
            : '종결: 방송이 이미 끝나 시작 공지를 보내지 않음';
        ledger.markSuppressed('live_start', row.eventKey, reason, clock.date().toISOString());
        logger.info({ liveHash: row.eventKey, reason }, '공지 종결');
        return;
      }

      const via = toLiveVia(row.detectedVia);
      // ★ 작업 조립은 `live-announce.ts` 가 한다 — 여기서 손으로 적으면 `imageSource` 를
      //   테스트가 지킬 수 없다 (다른 두 경로와 같은 자리에 둔다).
      await liveAnnounce(
        jobFromOutbox({
          channelId: file.live.channelId,
          liveHash: row.eventKey,
          detectedVia: via,
          ...(session?.liveTitle === undefined ? {} : { liveTitle: session.liveTitle }),
          ...(session?.openedAt === undefined ? {} : { openedAt: session.openedAt }),
        }),
      );
      return;
    }

    /**
     * ★★ **`seeded` 행을 절대 보내지 않는다** (AC-26).
     *
     *   시딩 행은 `announced_at IS NULL` 이라 아웃박스의 회수 대상에 그대로 걸린다.
     *   보내면 최초 기동 시딩이 **과거 영상 15건 도배**로 바뀐다 —
     *   "선점만 하고 공지하지 않는다" 가 시딩의 전부인데 그 절반이 뒤집힌다.
     *   감지 경로와 `seeded` 플래그를 **둘 다** 본다: 앞은 공짜이고 뒤는 스키마가
     *   보증하는 값이라, 어느 한쪽이 바뀌어도 이 문은 닫혀 있다.
     */
    if (row.detectedVia === 'seed' || ledger.get('youtube_upload', row.eventKey)?.seeded === true) {
      return;
    }

    /**
     * ★★ **너무 늦은 업로드 공지도 보내지 않는다** (AC-30 과 같은 임계값).
     *
     *   기동 복구는 *"다운타임이 기준을 넘으면 밀린 유튜브 알림을 전량 생략"* 한다.
     *   그런데 재기동 없이 디스코드만 오래 죽어 있으면 같은 상황인데도 그 규칙이
     *   적용되지 않아, 회복한 순간 **이틀 지난 업로드 공지가 튀어나온다.**
     *   "얼마나 지난 알림까지 의미가 있는가" 는 경로가 아니라 시간이 정한다.
     */
    if (isStaleUploadResend(Date.parse(row.claimedAt), clock.now(), file.recovery.downtimeThresholdHours)) {
      const reason = `종결: 감지 후 ${String(file.recovery.downtimeThresholdHours)}시간을 넘겨 공지하지 않음`;
      ledger.markSuppressed('youtube_upload', row.eventKey, reason, clock.date().toISOString());
      logger.info({ videoId: row.eventKey, reason }, '공지 종결');
      return;
    }

    const entry: FeedEntry = uploadEntries.get(row.eventKey) ?? {
      // 재기동 뒤라 피드 엔트리를 잃었다. 링크는 `videoId` 만으로 만들 수 있으므로
      // **제목 없이라도 보낸다** — 늦고 밋밋한 공지(1위)가 누락(2위)보다 낫다.
      videoId: row.eventKey,
      title: '',
      publishedAt: '',
      updatedAt: '',
      channelId: '',
    };
    const result = await uploadSender(entry, toUploadVia(row.detectedVia));
    const done = clock.date().toISOString();
    if (result.ok) ledger.markSent('youtube_upload', row.eventKey, result.messageId, done);
    else ledger.markFailed('youtube_upload', row.eventKey, result.reason, done);
  };

  const outbox: Outbox = createOutbox({
    ledger,
    send: resend,
    clock,
    onEvent: (e) => {
      logger.info(e, '아웃박스');
    },
  });

  // ── 라이브 (§S5) ─────────────────────────────────────────────
  /**
   * AD-1 보호 목록 = `[live.channelId] ∪ chzzkbot 서빙 채널`.
   *
   * ★ **배열 참조를 그대로 넘긴다.** `viewer-token.ts` 는 revoke 직전에 이 값을 읽으므로,
   *   폴링이 새 채널을 발견하면 그때부터 보호가 걸린다.
   * ★ `undefined` 를 넘기면 revoke 를 **아예 하지 않는다**(AD-1 fail-safe). 그 성질은
   *   `viewer-token.ts` 가 그대로 갖고 있고, 여기서는 계획이 정한 목록을 넘긴다.
   */
  const protectedChannelIds: string[] = [file.live.channelId];
  const rememberProtected = (ids: readonly string[]): void => {
    for (const id of ids) if (!protectedChannelIds.includes(id)) protectedChannelIds.push(id);
  };

  const liveApi = createLiveApiClient({
    baseUrl: file.chzzkbot.baseUrl,
    token: secrets.LIVE_API_TOKEN,
    http,
    channelId: file.live.channelId,
  });

  const silenceWatch = createWebhookSilenceWatch({
    clock,
    alerts: liveAlerts,
    graceMs: file.live.webhookSilenceGraceMin * 60_000,
    onEvent: (e) => {
      // ★ AC-P6 의 판정 축. `waitedMs` 는 `matched`(짝이 왔다) · `silent`(유예창을
      //   넘겼다) · `late`(넘긴 뒤에 왔다)에 실린다 — `armed` 에는 없다.
      if (e.waitedMs !== undefined) {
        metricsRegistry.gauge('live_webhook_silence_sec', e.waitedMs / 1_000);
      }
      logger.info(e, '웹훅 침묵 감시');
    },
  });

  const livePoller = createLivePoller({
    client: liveApi,
    channelId: file.live.channelId,
    ledger,
    sessions: liveSessionStore,
    announce: liveAnnounce,
    stuckWatch,
    alerts: liveAlerts,
    clock,
    intervalMs: file.live.apiPollIntervalMin * 60_000,
    silenceWatch,
    // ★ 낯선 채널 경보는 재기동을 넘어 한 번만 — 메모리에만 두면 배포마다 아이곰으로 울린다.
    unknownChannelMemory: runtimeState,
    onEvent: (e) => {
      // ★ 낯선 채널은 chzzkbot 이 서빙 중인 채널이다 — AD-1 보호 목록에 더한다.
      if (e.type === 'unknown-channel' && e.channelIds !== undefined) {
        rememberProtected(e.channelIds);
      }
      // ★★ §9.4 `live_state_verdict` · `live_unconfirmed_observed` — 판정 **분포**는
      //   판정기를 부른 쪽이 센다. `live-state.ts` 는 부작용 없는 판정 함수로
      //   남겨야 한다 (§10 시나리오 1 완화책: 판정을 전용 모듈로 분리).
      //   `tick` 은 한 바퀴가 끝날 때 정확히 한 번 나온다.
      if (e.type === 'tick' && e.judgment !== undefined) {
        metricsRegistry.count('live_state_verdict', e.judgment.state);
        if (isConfirmedStuck(e.judgment)) metricsRegistry.count('live_unconfirmed_observed');
      }
      logger.info(e, '라이브 폴');
    },
  });

  // ── 인증 (§S4) ───────────────────────────────────────────────
  const followers = createFollowerChecker({
    budget: http,
    baseUrl: file.chzzkbot.baseUrl,
    token: secrets.LIVE_API_TOKEN,
    channelId: file.live.channelId,
    staleAfterMin: file.follower.staleAfterMin,
    clock,
    onUnknown: (reason) => {
      logger.warn({ metric: 'follower_lookup_unknown_total', reason }, '팔로워 판정 보류');
    },
    onLookup: (lookup) => {
      // ★★ `follower-stale` 은 `armed: false` 다 — **세기만 하고 경보하지 않는다.**
      //   `staleAfterMin`(150분)이 소스 상수 추론이지 실측이 아니라(§2-b 잠정),
      //   검증 안 된 임계로 경보하면 `stale` 이 지정한 유일한 관측 축이 오탐에 덮인다.
      //   S1-J 실측 뒤에 켠다. 반환값이 언제나 `undefined` 인 이유가 그것이다.
      stuckWatch.observe(
        'follower-stale',
        file.live.channelId,
        lookup.reason === 'stale',
        clock.now(),
      );
    },
    onLog: (message, extra) => {
      logger.debug(extra ?? {}, message);
    },
  });

  const viewerToken = createViewerTokenClient({
    budget: http,
    clientId: secrets.CHZZK_CLIENT_ID,
    clientSecret: secrets.CHZZK_CLIENT_SECRET,
    protectedChannelIds,
    onRevokeFailure: (detail) => {
      logger.warn({ metric: 'viewer_token_revoke_failures', detail }, '시청자 토큰 revoke 실패');
    },
    onRevokeSkipped: (reason) => {
      logger.info({ reason }, 'AD-1 — revoke 건너뜀');
    },
    onLog: (message, extra) => {
      logger.debug(extra ?? {}, message);
    },
  });

  const authGuard = createAuthGuard({
    clock,
    cooldownSec: file.auth.commandCooldownSec,
    maxConcurrentFlows: file.auth.maxConcurrentFlows,
    onReject: (reason) => {
      logger.info({ metric: 'auth_flow_rejected', reason }, '인증 진입 거절');
    },
  });

  const sessions = createVerificationSessionStore({
    repo: createVerificationSessionRepo(db),
    clock,
    sessionTtlMin: file.auth.sessionTtlMin,
    maxPending: file.auth.maxPending,
    onPendingMax: (info) => {
      // ★★ §5.6.2 — 폐기하되 **알린다.** 조용히 폐기하면 공격을 관측할 수 없다.
      //   경보 종류는 `web/session.ts` 가 `AlertKind` 로 export 한 상수를 쓴다 —
      //   문자열을 직접 적으면 `alert_state` CHECK 와 어긋난 값이 들어가고,
      //   그 INSERT 실패가 하필 경보를 보내려던 순간에 일어난다.
      authGuard.countPendingMax();
      const scope = guildConfig.single()?.guildId ?? SYSTEM_SCOPE;
      void alerts
        .forScope(scope)
        .raise(
          AUTH_PENDING_MAX_ALERT,
          `인증 대기가 상한에 도달했습니다 — 대기 ${String(info.pending)} / 상한 ${String(info.maxPending)}\n` +
            `가장 오래된 대기 ${String(info.dropped)}건을 폐기했습니다.\n` +
            '정상 사용자는 계속 진입할 수 있습니다. 이 경보는 그 폐기가 있었다는 사실입니다.',
        );
    },
  });

  const gateGateway = createGateGateway(
    gateway,
    opts.roleLookup ?? (client === undefined ? undefined : cacheRoleLookup(client)),
  );

  // ── 유튜브 (§S6) ─────────────────────────────────────────────
  const uploadFlow = createUploadFlow({
    ledger,
    channels: youtubeChannels,
    clock,
    send: uploadSender,
    onEvent: (e) => {
      // ★★ `duplicate` 는 **정상 상태**다 — 폴이 이미 처리한 항목을 다시 본 것이고,
      //   피드가 최근 15건을 늘 담고 있으므로 폴마다 15건씩 나온다. 이것을 info 로
      //   남기면 분당 30줄, 하루 4.7MB 가 쌓이고 **실제 사건이 96% 소음에 묻힌다**
      //   (실배포 관측 2026-09-09: 전체 21,090줄 중 운영 경보는 33줄이었다).
      if (e.outcome === 'duplicate') logger.debug(e, '업로드 처리');
      else logger.info(e, '업로드 처리');
    },
  });

  const websub = createWebSubClient({
    http: textClient,
    subs: websubSubs,
    channels: youtubeChannels,
    configured: file.youtube.channels,
    callbackUrl: `${file.web.publicBaseUrl.replace(/\/+$/, '')}${WEBSUB_PATH}`,
    clock,
    stuck: stuckWatch,
    leaseWarnRatio: file.youtube.leaseWarnRatio,
    onAlert: raiseStuck,
    onLeaseWarning: async (w) => {
      await alerts
        .forScope(w.channelId)
        .raise(
          'websub_lease',
          `WebSub 리스 잔여 ${String(Math.round(w.ratio * 100))}% (${String(w.remainingSec)}초) — ${w.channelId}\n` +
            '갱신이 되지 않고 있으면 리스 만료와 함께 푸시가 멈춥니다.',
        );
    },
    onLog: (message, extra) => {
      logger.info(extra ?? {}, message);
    },
  });

  const rssPoller = createRssPoller({
    http: textClient,
    flow: uploadFlow,
    channels: youtubeChannels,
    configured: file.youtube.channels,
    clock,
    stuck: stuckWatch,
    pollSec: file.youtube.rssPollSec,
    onAlert: raiseStuck,
    onLog: (message, extra) => {
      logger.info(extra ?? {}, message);
    },
  });

  const signatureFailures = createSignatureFailureCounter();

  // ── 라우트 등록 (§5.4 인입 표) ───────────────────────────────
  routes.push(
    createChzzkbotWebhookRoute({
      token: secrets.LIVE_EVENT_WEBHOOK_TOKEN,
      channelId: file.live.channelId,
      ledger,
      sessions: liveSessionStore,
      announce: liveAnnounce,
      ops,
      clock,
      silenceWatch,
      metrics: {
        ackMs: (ms) => {
          metricsRegistry.duration('live_webhook_ack_ms', ms);
        },
      },
      onEvent: (e) => {
        logger.info(e, '라이브 웹훅');
      },
    }),
    createOAuthStartRoute({
      sessions,
      clientId: secrets.CHZZK_CLIENT_ID,
      redirectUri: `${file.web.publicBaseUrl.replace(/\/+$/, '')}${OAUTH_CALLBACK_PATH}`,
      sessionTtlMin: file.auth.sessionTtlMin,
      publicBaseUrl: file.web.publicBaseUrl,
      onLog: (message, extra) => {
        logger.info(extra ?? {}, message);
      },
    }),
    createOAuthCallbackRoute({
      sessions,
      viewerToken,
      followers,
      links,
      gateway: gateGateway,
      clock,
      resolveGuild,
      onRoundTrip: (ms) => {
        logger.info({ metric: 'auth_roundtrip_ms', ms }, '인증 왕복');
      },
      onResult: (result) => {
        logger.info({ metric: 'auth_result_total', result }, '인증 결과');
      },
      onLog: (message, extra) => {
        logger.info(extra ?? {}, message);
      },
    }),
    ...createWebSubRoutes({
      secretFor: (channelId) => websub.secretFor(channelId),
      verify: (input) => websub.verify(input),
      onPush: async (channelId, xml) => {
        const parsed = parseFeed(xml);
        if (!parsed.ok) {
          // ★ 푸시 파싱 실패는 RSS 스트릭에 넣지 않는다. 저 도메인이 세는 것은
          //   "우리가 피드를 가져오지 못한다" 이고 이건 허브가 보낸 본문 문제다.
          logger.warn({ channelId, reason: parsed.reason }, 'websub 푸시 본문을 파싱하지 못했습니다');
          return;
        }
        for (const entry of parsed.entries) uploadEntries.set(entry.videoId, entry);
        await uploadFlow.handle(channelId, parsed.entries, 'websub');
      },
      onSignatureFailure: (channel, reason) => {
        // ★★ AC-P5 — 조용한 202 의 원인을 특정하는 유일한 축이다.
        signatureFailures.record(channel, reason);
        logger.warn(
          { metric: 'websub_signature_failures', channel, reason, count: signatureFailures.count(channel) },
          'websub 서명 검증 실패',
        );
        void alerts
          .forScope(channel)
          .raise(
            'websub_signature',
            `WebSub 서명 검증에 실패했습니다 — ${channel} (${reason})\n` +
              '허브에는 계약대로 202 를 돌려줬습니다. 시크릿 불일치라면 재구독이 필요합니다.',
          );
      },
      onLog: (message, extra) => {
        logger.info(extra ?? {}, message);
      },
    }),
  );

  // ── 인증 패널 (게이트 채널의 임베드 + 버튼 — 멤버용 진입점) ─────
  const authPanel = createAuthPanelKeeper({
    gateway,
    state: runtimeState,
    clock,
    onLog: (message, extra) => {
      logger.info(extra ?? {}, message);
    },
  });

  // ── 명령 — 슬래시(운영자용) · 패널 버튼(멤버용) ────────────────
  const commandLog = (message: string, extra?: Record<string, unknown>): void => {
    logger.info(extra ?? {}, message);
  };

  const linkCommand = createLinkCommand({
    sessions,
    links,
    guard: authGuard,
    clock,
    publicBaseUrl: file.web.publicBaseUrl,
    gateway: gateGateway,
    resolveVerifiedRoleId: (guildId) => guildConfig.get(guildId)?.verifiedRoleId,
    onLog: commandLog,
  });
  const statusCommand = createStatusCommand({ links });

  /**
   * ★ 슬래시로 **등록되는** 것은 운영자용 셋뿐이다. `인증` 은 여기 없다 —
   *   `PUT applicationGuildCommands` 가 전체 교체라, 목록에서 빠지면 다음 기동에
   *   디스코드에서도 사라진다.
   */
  const commands = new Map<string, SlashCommand>();
  for (const command of [
    createUnlinkCommand({ links, clock, onLog: commandLog }),
    statusCommand,
    createGateChannelCommand({
      config: {
        gateChannelId: (guildId) => guildConfig.get(guildId)?.gateChannelId,
        setGateChannel: (guildId, channelId, at) => {
          guildConfig.upsert({ guildId, gateChannelId: channelId }, at);
        },
      },
      panel: authPanel,
      clock,
      onLog: commandLog,
    }),
  ]) {
    commands.set(command.definition.name, command);
  }

  /** 패널 버튼 → 명령. `custom_id` 는 `discord/panel.ts` 가 못 박는다 */
  const buttons = new Map<string, Command>([
    [AUTH_PANEL_BUTTON_LINK, linkCommand],
    [AUTH_PANEL_BUTTON_STATUS, statusCommand],
  ]);

  const runCommand = async (label: string, command: Command, ctx: CommandContext): Promise<CommandReply> => {
    try {
      return await command.execute(ctx);
    } catch (e: unknown) {
      // 명령은 던지지 않기로 돼 있지만 계약을 신뢰하지 않는다 — 여기서 새면
      // 사용자는 "애플리케이션이 응답하지 않음" 만 본다.
      logger.error({ command: label, detail: e instanceof Error ? e.message : String(e) }, '명령 처리 실패');
      return { ephemeral: true, content: '명령을 처리하지 못했습니다. 잠시 후 다시 시도해 주십시오.' };
    }
  };

  const dispatchCommand = (name: string, ctx: CommandContext): Promise<CommandReply> => {
    const command = commands.get(name);
    if (command === undefined) return Promise.resolve({ ephemeral: true, content: '알 수 없는 명령입니다.' });
    return runCommand(name, command, ctx);
  };

  const dispatchButton = (customId: string, ctx: CommandContext): Promise<CommandReply> => {
    const command = buttons.get(customId);
    // ★ 버튼 상호작용은 우리 앱이 보낸 메시지의 것만 온다. 모르는 id 는 옛 버전 패널이다.
    //   응답은 반드시 한다 — 안 하면 사용자는 "상호작용 실패" 만 본다.
    if (command === undefined) return Promise.resolve({ ephemeral: true, content: unknownButtonMessage() });
    return runCommand(customId, command, ctx);
  };

  if (client !== undefined) {
    // ★ 상호작용 → 명령 접기는 `discord/interactions.ts` 가 한다 (거기서 시험된다).
    const onInteraction = createInteractionRouter({
      commands,
      buttons,
      dispatchCommand,
      dispatchButton,
      targetUserOption: TARGET_OPTION_NAME,
      targetChannelOption: GATE_CHANNEL_OPTION_NAME,
    });

    client.on(Events.InteractionCreate, (interaction) => {
      void onInteraction(interaction).catch((e: unknown) => {
        logger.error({ detail: e instanceof Error ? e.message : String(e) }, '상호작용 처리 실패');
      });
    });

    client.once(Events.ClientReady, (ready) => {
      const guild = guildConfig.single();
      if (guild === undefined) {
        logger.warn('guild_config 행이 정확히 하나가 아니라 슬래시 명령을 등록하지 않았습니다');
        return;
      }
      void ready.rest
        .put(Routes.applicationGuildCommands(ready.application.id, guild.guildId), {
          body: [...commands.values()].map((c) => c.definition),
        })
        .then(() => {
          logger.info(
            { guildId: guild.guildId, count: commands.size, names: [...commands.keys()] },
            '슬래시 명령을 등록했습니다 (운영자용 — 멤버 진입점은 인증 패널)',
          );
        })
        .catch((e: unknown) => {
          logger.error(
            { detail: e instanceof Error ? e.message : String(e) },
            '슬래시 명령 등록 실패',
          );
        });
    });
  }

  // ── 아웃박스 시작 (복구보다 먼저 — §5.4 ④) ──────────────────
  outbox.start();

  // ── ★★ 기동 복구 (§S7 · US-006) ─────────────────────────────
  await runRecovery();

  async function runRecovery(): Promise<void> {
    const at = clock.date().toISOString();

    // ① 라이브 — **다운타임 길이를 보지 않는다.** 진행 중인 방송은 현재 사실이다.
    const res = await liveApi.fetch();
    if (res.ok) {
      // chzzkbot 이 서빙 중인 채널 전부가 AD-1 보호 대상이다.
      rememberProtected(res.response.channels.map((c) => c.channelId));
    }
    const input: LiveStateInput = res.ok
      ? res.target === undefined
        ? { kind: 'channel-missing' }
        : { kind: 'channel', channel: res.target }
      : {
          kind: 'failure',
          failure: res.failure,
          ...(res.detail === undefined ? {} : { detail: res.detail }),
        };

    const outcome = await recoverLive({
      input,
      ledger,
      announce: liveAnnounce,
      at,
      closeOpenSessions: (closedAt) => {
        liveSessions.closeOpen(closedAt);
      },
    });

    // ★ §9.4 `live_state_verdict` — 폴러와 **같은 축**이다. 복구를 빼면
    //   "기동할 때마다 unknown 인데 분포에는 안 보인다" 가 된다.
    metricsRegistry.count(
      'live_state_verdict',
      outcome.kind === 'unknown' ? 'unknown' : outcome.kind === 'ended' ? 'ended' : 'announce',
    );
    if (outcome.kind === 'unknown' && outcome.reason === 'unconfirmed') {
      metricsRegistry.count('live_unconfirmed_observed');
    }

    if (outcome.kind === 'unknown') {
      /**
       * ★★ US-006 의 마지막 배선이 여기다. `recoverLive` 는 판정만 돌려준다
       *   (L6 은 L7 을 모른다) — 그래서 **두 가지를 조립부가 한다**:
       *
       *     (a) `ops_events` 1건   — 기동 복구가 조용히 실패한 것을 나중에 읽을 수 있게
       *     (b) `unknown` 스트릭의 **1회차** — 지속되면 AC-P2 가 사람을 부른다
       *
       *   (b)가 없으면 "기동할 때마다 실패하는데 스트릭은 늘 0" 이 되어
       *   영구 장애가 영영 경보를 내지 못한다.
       */
      ops.record('recovery_live_unknown' satisfies MainOpsKind, `기동 복구 조회 실패 — ${outcome.reason}`, at);
      const fired = stuckWatch.observe('live-api-unknown', file.live.channelId, true, clock.now());
      if (fired !== undefined) await raiseStuck(fired);
      logger.warn({ reason: outcome.reason }, '기동 복구 — 라이브 상태를 확인하지 못했습니다');
    } else {
      logger.info({ outcome: outcome.kind }, '기동 복구 — 라이브');
    }

    // ② 유튜브 — 밀린 업로드. **지나간 이벤트라 다운타임 길이를 본다** (AC-29/30).
    for (const channel of file.youtube.channels) {
      youtubeChannels.upsert(channel.channelId, channel.label);
      const feed = await textClient.request('rss-poll', feedUrl(channel.channelId), {
        deadlineAt: clock.now() + RSS_CHANNEL_BUDGET_MS,
      });
      if (!feed.ok) {
        stuckWatch.observe('rss', channel.channelId, true, clock.now());
        ops.record(
          'recovery_rss_failed' satisfies MainOpsKind,
          `${channel.channelId}: ${feed.kind} ${feed.detail}`,
          at,
        );
        logger.warn({ channelId: channel.channelId, reason: feed.kind }, '기동 복구 — RSS 훑기 실패');
        continue;
      }
      const parsed = parseFeed(feed.text);
      if (!parsed.ok) {
        stuckWatch.observe('rss', channel.channelId, true, clock.now());
        ops.record(
          'recovery_rss_failed' satisfies MainOpsKind,
          `${channel.channelId}: parse ${parsed.reason ?? '알 수 없는 형식 오류'}`,
          at,
        );
        continue;
      }
      for (const entry of parsed.entries) uploadEntries.set(entry.videoId, entry);

      const result = await recoverYoutube({
        window: downtime,
        videos: parsed.entries.map((e) => ({
          videoId: e.videoId,
          channelId: channel.channelId,
          publishedAt: e.publishedAt,
        })),
        ledger,
        at,
        announce: async (video) => {
          const entry = uploadEntries.get(video.videoId);
          if (entry === undefined) return;
          const sent = await uploadSender(entry, 'recovery');
          const done = clock.date().toISOString();
          if (sent.ok) ledger.markSent('youtube_upload', video.videoId, sent.messageId, done);
          else ledger.markFailed('youtube_upload', video.videoId, sent.reason, done);
        },
        recordSkip: (detail) => {
          ops.record('recovery_downtime' satisfies MainOpsKind, detail, at);
          void alerts.forScope(channel.channelId).raise('downtime_detected', detail);
        },
      });
      logger.info({ channelId: channel.channelId, kind: result.kind }, '기동 복구 — 유튜브');
    }
  }

  // ── 종료 ──────────────────────────────────────────────────────
  // ★ 등록 순서의 **역순**으로 정리된다 — 나중에 연 것을 먼저 닫는다.
  //   원장 claim 을 쓰는 중이라면 그게 끝나야 DB 를 닫을 수 있다.
  let exitCode = 0;
  const shutdown = new ShutdownManager({
    onBegin: (reason) => {
      logger.info({ reason }, '종료를 시작합니다');
    },
    onError: (label, err) => {
      logger.warn({ label, detail: err instanceof Error ? err.message : String(err) }, '정리 실패');
    },
    exit: (code) => {
      // ★ 여기서 프로세스를 끝내지 않는다. `main()` 이 끝낸다 —
      //   그래야 테스트가 같은 정리 경로를 돌리고도 러너가 죽지 않는다.
      exitCode = code;
    },
  });
  shutdown.register('락 해제', () => {
    lock.release();
  });
  shutdown.register('DB 닫기', () => {
    db.close();
  });
  shutdown.register('웹 서버', () => web.close());
  shutdown.register('하트비트', () => {
    heartbeat.dispose();
  });
  shutdown.register('생존 표식', () => {
    liveness.stop();
  });
  shutdown.register('아웃박스', () => {
    outbox.dispose();
  });
  shutdown.register('라이브 폴러', () => {
    livePoller.dispose();
  });
  shutdown.register('웹훅 침묵 감시', () => {
    silenceWatch.dispose();
  });
  shutdown.register('RSS 폴러', () => {
    rssPoller.stop();
  });
  shutdown.register('WebSub 스윕', () => {
    websub.stop();
  });
  shutdown.register('팔로워 재조회 예약', () => {
    followers.dispose();
  });
  shutdown.register('디스코드 게이트웨이', () => gateway.destroy());

  // ── 지표 읽기 함수 배선 (§9.4) ───────────────────────────────
  /**
   * ★★ **여기가 §9.4 의 나머지 절반이다.**
   *
   *   이 지표들의 값은 이미 다른 모듈 안에 산다. 그래서 레지스트리는 **읽기만**
   *   한다 — 복사하면 숫자가 둘이 되고, 갈라지는 날 어느 쪽이 참인지 알 수 없다.
   *
   * ★ 도메인 지식(어느 스트릭이 어느 지표인가)이 조립부에 있는 이유:
   *   `stuck-watch` 의 도메인 이름이 바뀌면 **여기서 컴파일이 깨진다.**
   *   레지스트리 안에 문자열로 두면 통과한 채 조용히 0 을 돌려준다.
   */
  const streakByChannel = (domain: StuckDomain): Record<string, number> => {
    const at = clock.now();
    const out: Record<string, number> = {};
    for (const e of stuckWatch.snapshot(at)) {
      if (e.domain === domain) out[e.scopeKey] = e.value;
    }
    return out;
  };

  metricsRegistry.bind({
    counters: {
      follower_lookup_unknown_total: () => followers.metrics.unknownByReason,
      follower_lookup_total: () => followers.metrics.lookups,
      follower_lookup_recheck_total: () => followers.metrics.rechecks,
      viewer_token_revoke_failures: () => viewerToken.revokeFailures,
      websub_signature_failures: () =>
        Object.fromEntries(signatureFailures.snapshot().map((r) => [r.channel, r.count])),
      // ★ 라벨은 `OutboundCall` 이다. 세는 것은 `http-budget` 의 `onTimeout` 이고
      //   여기서는 그 표를 그대로 편다 — 사본이 아니라 같은 값을 읽는다.
      outbound_timeout_total: () => Object.fromEntries(Object.entries(metrics.timeouts)),
      discord_gateway_reconnects: () => gateway.reconnectCount,
      auth_flow_rejected: () => authGuard.rejected,
    },
    gauges: {
      follower_snapshot_age_sec: () => followers.metrics.lastSnapshotAgeSec,
      live_api_unknown_streak: () =>
        stuckWatch.value('live-api-unknown', file.live.channelId, clock.now()),
      // ★ `confirmed-stuck` 은 duration 도메인이라 밀리초다. 지표 이름이 `_sec` 이므로
      //   여기서 접는다 — 이름과 단위가 어긋나면 임계를 1000배 틀리게 읽는다.
      live_unconfirmed_duration_sec: () =>
        stuckWatch.value('confirmed-stuck', file.live.channelId, clock.now()) / 1_000,
      websub_renew_fail_streak: () => streakByChannel('websub-renew'),
      youtube_rss_fail_streak: () => streakByChannel('rss'),
      websub_lease_ratio: () =>
        Object.fromEntries(websub.leaseRatios().map((r) => [r.channelId, r.ratio])),
    },
    durations: {
      // ★ `OutboundMetrics` 가 이미 재고 있다. p95 표본을 여기서 다시 모으면
      //   같은 사건의 두 번째 사본이 된다 — 횟수와 마지막 값만 읽는다.
      follower_lookup_ms: () => ({
        count: metrics.latencyCount['follower-lookup'] ?? 0,
        lastMs: metrics.lastLatencyMs['follower-lookup'],
      }),
    },
  });

  const app: App = {
    config,
    boundAddress,
    baseUrl,
    db,
    web,
    routes,
    gateway,
    announcer,
    outbox,
    livePoller,
    rssPoller,
    websub,
    silenceWatch,
    stuckWatch,
    liveness,
    ledger,
    links,
    liveSessions,
    ops,
    runtimeState,
    alertState: alertStateRepo,
    guildConfig,
    sessions,
    followers,
    authGuard,
    alerts,
    metrics,
    metricsRegistry,
    http,
    viewerToken,
    signatureFailures,
    protectedChannelIds,
    downtime,
    commands,
    buttons,
    authPanel,
    dispatchCommand,
    dispatchButton,

    async start(): Promise<void> {
      liveness.start();
      livePoller.start();
      await websub.start();
      await rssPoller.start();
      // ★ 패널은 폴러들 뒤, 기동 로그 앞이다. 실패해도 기동은 막지 않지만(Principle 2)
      //   그 결과가 기동 로그 한 줄에 실려야 런북 §2-5 가 본다 — 패널이 없으면 진입점이 없다.
      const panel = await authPanel.ensure(guildConfig.single()?.gateChannelId);
      if (panel.outcome === 'skipped') {
        // ★ 패널이 없으면 인증 진입점이 0개다 — warn 이 아니라 error 다.
        //   `guildRows` 를 함께 찍는다: 행이 0개도 2개 이상도 `single()` 은 `undefined` 인데,
        //   2개 이상이면 슬래시 명령 자체가 등록되지 않아 `/인증채널` 로는 고칠 수 없다 (런북 §1-2-a).
        logger.error(
          { reason: panel.reason, detail: panel.detail, guildRows: guildConfig.list().length },
          '인증 패널이 없습니다 — 멤버가 인증을 시작할 수 없습니다. guild_config 가 1행이면 /인증채널 로 채널을 지정하십시오',
        );
      }
      logger.info(
        {
          address: boundAddress.address,
          port: boundAddress.port,
          liveChannelId: file.live.channelId,
          youtubeChannels: file.youtube.channels.length,
          authPanel: describeAuthPanelResult(panel),
        },
        '기동을 마쳤습니다',
      );
    },

    async stop(reason = 'stop'): Promise<void> {
      await shutdown.shutdown(reason);
    },

    installSignalHandlers(): () => void {
      const handler = (signal: NodeJS.Signals): void => {
        void (async (): Promise<void> => {
          await shutdown.shutdown(signal);
          process.exit(exitCode);
        })();
      };
      process.on('SIGTERM', handler);
      process.on('SIGINT', handler);
      return () => {
        process.off('SIGTERM', handler);
        process.off('SIGINT', handler);
      };
    },
  };

  return app;
}

// ══════════════════════════════════════════════════════════════════
//  진입점
// ══════════════════════════════════════════════════════════════════

export async function main(): Promise<void> {
  const app = await bootstrap();
  app.installSignalHandlers();
  await app.start();
}

/**
 * ★ import 되었을 때는 돌지 않는다. 테스트가 `bootstrap` 만 부르기 때문이다.
 *   `process.argv[1]` 이 이 파일일 때만 진입점으로 동작한다.
 */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  main().catch((e: unknown) => {
    process.stderr.write(`\n기동 중 예기치 못한 오류입니다: ${String(e)}\n`);
    process.exit(DB_ERROR_EXIT_CODE);
  });
}
