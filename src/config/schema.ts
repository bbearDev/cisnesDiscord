// 출처: chzzkbot src/config/schema.ts 의 패턴 (requiredString · superRefine cross-field · L0 규율)
import { z } from 'zod';

/**
 * 설정 스키마 — 계획 §S2 · §2-b.
 *
 * **시크릿은 여기 오지 않는다.** 봇 토큰 · 웹훅 토큰 · `LIVE_API_TOKEN` ·
 * 치지직 클라이언트 시크릿은 전부 `.env`(= `process.env`)에서 읽는다.
 * 이 파일은 `config/config.yaml` 의 형태만 정의한다.
 *
 * ★ cross-field 검증이 이 스키마의 존재 이유 중 절반이다.
 *   계획 §2-b 가 신설된 이유가 *"7분/8분이 16곳에 갈린 것은 값을 잘못 고른 문제가
 *   아니라 정의가 여러 곳에 복제된 문제였다"* 다. 그래서 파생 관계(`←`)를
 *   **주석이 아니라 기계가** 지키게 한다 — 위 행이 바뀌면 아래 행이 즉시 빨간불이 된다.
 */

// ══════════════════════════════════════════════════════════════════
//  §2-b 파생 상수 — **여기서만 정의한다**
// ══════════════════════════════════════════════════════════════════

/**
 * chzzkbot 재시도 창 = **7분**.
 *
 * 실배포 `maxAttempts: 8` · `retryIntervalMin: 1` 에서 유도한다.
 * ★ 기전: `attempts` 는 **실패만** 세고 `pending()` 은 `attempts < max` 인 행만 준다
 *   → **즉시 1회(t=0) + 재시도 7회(t=1…7)** = 총 8회 시도, **마지막이 t+7분**.
 *   "8×1=8분" 은 config 값만 보고 기전을 안 본 값이다 (계획 rev.8 정정).
 *
 * 아래 두 값이 이 상수에서 파생된다. 이 값이 바뀌면 둘을 함께 재유도한다.
 */
export const CHZZKBOT_RETRY_WINDOW_MIN = 7;

/**
 * 상류 `followerCacheMin` — chzzkbot 이 팔로워 캐시를 유지하는 시간 (기본 10분).
 *
 * ★ **여기(L0)에 둔다.** 쓰는 쪽은 `chzzk/follower-check.ts`(L3) 지만, 이 값은
 *   아래 `FOLLOWER_UPSTREAM_WORST_AGE_MIN` 의 **피연산자**다. 두 곳에 따로 적으면
 *   상류가 20분으로 바뀌었을 때 **이름이 붙은 쪽만 고치고 130 은 그대로 남는다** —
 *   그러면 superRefine ③ 이 낡은 바닥을 기준으로 `staleAfterMin` 을 승인하고,
 *   건강한 채널이 다시 신선도 게이트를 밟는다. rev.8 이 120→150 으로 올려 벗어난
 *   바로 그 회귀다. §2-b 가 "정의가 여러 곳에 복제된 문제" 라 부른 것.
 */
export const UPSTREAM_FOLLOWER_CACHE_MIN = 10;

/** 상류 안전장치 스윕 간격. `sweepJitterMs` 때문에 최악은 이 값의 2배다 */
export const UPSTREAM_SWEEP_INTERVAL_MIN = 60;

/**
 * 상류 캐시가 무고장 상태에서 늙을 수 있는 **최악의 나이**.
 *
 * ★★ **유도한다. 상수를 적지 않는다.** 계획 §2-b 의 규칙은
 *   *"값을 바꿀 때는 이 표만 고친다"* 이고, 그 강제는 **주석이 아니라 기계**여야 한다.
 *   130 을 리터럴로 적어 두면 위 두 피연산자가 바뀌어도 조용히 낡는다.
 */
export const FOLLOWER_UPSTREAM_WORST_AGE_MIN =
  2 * UPSTREAM_SWEEP_INTERVAL_MIN + UPSTREAM_FOLLOWER_CACHE_MIN;
// = 130분. `follower.staleAfterMin` 의 **하한**이며, 계획의 150분은 여기에 여유 20분을
// 더한 값이다. ⚠️ 150분도 소스 상수 추론이지 실측이 아니다 — S1-J 가 확정한다.

/**
 * systemd `TimeoutStopSec` = **30초** (`deploy/systemd/cisnesdiscord.service`).
 *
 * ★ `startup.bindRetrySec` 가 이 값에서 파생된다 (계획 §5.4 rev.3).
 *   **이전 인스턴스가 정상 종료에 쓸 수 있는 최대 시간이 곧 새 인스턴스가
 *   포트를 기다려야 할 최대 시간**이다. 둘이 갈리면 둘 중 하나가 틀린다:
 *   더 짧게 기다리면 정상 종료 중인 앞 인스턴스를 못 기다리고 exit 78 로 죽고,
 *   유닛 쪽을 늘리면 배포가 그만큼 느려진다.
 */
export const SYSTEMD_TIMEOUT_STOP_SEC = 30;

/** REQUIRED 자리 표시가 그대로 남아 있으면 거부한다. */
export const REQUIRED_PLACEHOLDER = 'REQUIRED';

const notPlaceholder = (field: string) =>
  ({
    message: `${field} 가 예시값 "${REQUIRED_PLACEHOLDER}" 그대로입니다. 실제 값으로 바꾸십시오.`,
  }) as const;

const requiredString = (field: string) =>
  z
    .string()
    .min(1, `${field} 가 비어 있습니다`)
    .refine((v) => v !== REQUIRED_PLACEHOLDER, notPlaceholder(field));

/** `requiredString` 과 같되 URL 형태까지 본다. `.refine` 뒤에는 `.url()` 을 붙일 수 없다. */
const requiredUrl = (field: string) =>
  z
    .string()
    .min(1, `${field} 가 비어 있습니다`)
    .url(`${field} 은 URL 이어야 합니다`)
    .refine((v) => v !== REQUIRED_PLACEHOLDER, notPlaceholder(field));

// ══════════════════════════════════════════════════════════════════
//  config/config.yaml
// ══════════════════════════════════════════════════════════════════

const PathsSchema = z.object({
  db: z.string().min(1).default('data/cisnes.db'),
  logs: z.string().min(1).default('data/logs'),
  /** 단일 인스턴스 락 (AC-35). 포트 바인드가 1차 방어이고 이건 그 뒤를 받는다 */
  lock: z.string().min(1).default('data/cisnes.lock'),
  /** systemd 워치독이 보는 mtime 파일 (AC-34) */
  heartbeat: z.string().min(1).default('data/heartbeat'),
});

const WebSchema = z.object({
  /** 계획 §5.4 — chzzkbot 8080 / cisnesDiscord **8081** (실측으로 확정) */
  port: z.number().int().min(1).max(65535).default(8081),
  /**
   * ★ 기본 바인드가 `127.0.0.1` 인 것이 격리의 전부다.
   *   공개가 필요한 경로는 OAuth 콜백과 WebSub 둘뿐이고, 그 둘은 리버스 프록시가
   *   종단한다 (S0-5). 0.0.0.0 으로 열면 웹훅 수신구가 인터넷에 그대로 노출된다.
   */
  bindAddress: z.string().min(1).default('127.0.0.1'),
  /**
   * 프록시가 종단하는 공개 https 주소. OAuth 콜백·WebSub 콜백 URL 의 기준값이다.
   * 예: `https://example.com`
   */
  publicBaseUrl: requiredUrl('web.publicBaseUrl'),
});

const StartupSchema = z.object({
  /**
   * ★ EADDRINUSE 백오프 재시도 창 (계획 §5.4 rev.3 — `src/web/server.ts`).
   *
   * 포트 바인드가 상호배제의 **1차 프리미티브**다. 앞 인스턴스가 아직 정상 종료
   * 중이면 잠깐 기다리면 풀리고, 남의 프로세스가 잡고 있으면 영영 안 풀린다 —
   * **일시적/영구를 시간으로 가른다.** 이 창을 넘기면 exit 78 로 끝낸다
   * (새 종료 코드를 만들지 않는다. `RestartPreventExitStatus=78 70` 을 함께
   * 고쳐야 하고, 그 한 줄을 빠뜨리면 무한 재시작 플래핑이 되살아난다).
   *
   * ← `SYSTEMD_TIMEOUT_STOP_SEC`. 아래 superRefine ⑤ 가 파생 관계를 지킨다.
   */
  bindRetrySec: z.number().int().min(0).default(SYSTEMD_TIMEOUT_STOP_SEC),
});

const ChzzkbotSchema = z.object({
  /** 계획 §5.4 — 같은 호스트의 루프백. 프록시 대상이 아니다 */
  baseUrl: z.string().url().default('http://127.0.0.1:8080'),
});

const LiveSchema = z.object({
  /**
   * ★ **단수 필드다. 배열이 아니다** (Non-Goal: 다채널 감지 없음, 계획 §8).
   *   `시스네` 채널 (S0-14 확정). 웹훅·폴링 **양쪽**의 필터 기준이다 —
   *   chzzkbot 이 2채널을 서빙 중이므로 우리가 거르지 않으면
   *   **남의 방송이 시스네 서버에 공지된다**.
   */
  channelId: requiredString('live.channelId').default('c3355ea2b3bea6c646789510796379d6'),
  /** ← 재시도 창(7분) + 여유 3분 (§2-b). AC-P6 의 유예창 */
  webhookSilenceGraceMin: z.number().int().positive().default(10),
  /** ← 재시도 창보다 짧아야 한다 (§5.1 경계 1). 3 < 7 */
  apiPollIntervalMin: z.number().int().positive().default(3),
  /** AC-P1 — `live:true, confirmed:false` 가 이만큼 지속되면 경보. 정상 창은 14초+스캔 */
  confirmedStuckMin: z.number().int().positive().default(5),
  /** AC-P2 — `unknown` 이 이만큼 연속되면 경보 (기본 3분 × 5 = 15분) */
  pollFailThresholdCount: z.number().int().positive().default(5),
});

const FollowerSchema = z.object({
  /**
   * 팔로워 스냅샷 신선도 게이트 (§5.2).
   *
   * ⚠️ **잠정값이다** (계획 §2-b). `2 × sweepInterval(60) + followerCacheMin(10) + 여유(20)`
   * 에서 유도했지 실측이 아니다 — S1-J 가 확정한다.
   * **게이트는 지금 켜고 `stale` 경보는 실측 뒤에 켠다**: 게이트는 틀려도 안전한
   * 방향(보류, §3-a 2위)이고, 경보는 임계가 맞아야 의미가 있다.
   */
  staleAfterMin: z.number().int().positive().default(150),
});

const HttpSchema = z.object({
  /**
   * **나가는 HTTP 의 동시 상한** — 전 아웃바운드가 이 하나를 나눠 쓴다 (§5.6.1).
   *
   * ⚠️ `auth.maxConcurrentFlows`(8) 와 **다른 것이다.** 값이 같아 혼동하기 쉽다:
   *   여기는 **나가는 요청**의 동시 수, 저기는 `/인증` **진입**의 동시 수다.
   *   §5.6.1 이 이 값을 소유한다.
   */
  maxConcurrent: z.number().int().positive().default(8),
});

const AuthSchema = z.object({
  /**
   * `/인증` **길드 전역 동시 진행 상한** (§5.6.2 · FM1).
   *
   * ⚠️ `http.maxConcurrent`(8) 와 **다른 것이다.** 30명이 동시에 눌렀을 때
   *   그것이 그대로 상류 팬아웃이 되는 것을 막는다.
   */
  maxConcurrentFlows: z.number().int().positive().default(8),
  /** `/인증` 사용자당 쿨다운. rev.6 이후 우리 쪽 유일한 사용자별 상한이다 */
  commandCooldownSec: z.number().int().positive().default(30),
  /** `state` TTL. 발급 후 이 시간이 지나면 소모할 수 없다 (§S4) */
  sessionTtlMin: z.number().int().positive().default(10),
  /**
   * `verification_sessions` 대기 상한 (§5.6.2).
   *
   * ★ 도달하면 **운영 채널에 경보한다.** rev.2 는 "가장 오래된 것부터 폐기"만 했는데,
   *   조용히 폐기하면 **공격을 관측할 수 없다.**
   */
  maxPending: z.number().int().positive().default(512),
});

/**
 * 유튜브 감지 (§5.3 · C3 = WebSub 주경로 + RSS 폴백).
 *
 * ★ 두 경로의 책임이 다르다: **WebSub 은 지연(AC-21)**, **RSS 는 누락 0(AC-25)** 을 진다.
 *   RSS 폴백은 "누락 0"을 지키는 장치이지 "1분"을 지키는 장치가 아니다 —
 *   WebSub 이 죽은 동안 발견된 영상은 1분을 넘겨 공지될 수 있고 그것은 설계된 동작이다.
 */
const YoutubeSchema = z.object({
  /** 감시할 채널 2~5개. `UC…` 형식 (S0-10) */
  channels: z
    .array(
      z.object({
        channelId: z.string().regex(/^UC[A-Za-z0-9_-]{22}$/, 'youtube 채널 id 는 UC + 22자 여야 합니다'),
        label: z.string().min(1),
      }),
    )
    .default([]),
  /** RSS 폴백 주기 */
  rssPollSec: z.number().int().positive().default(60),
  /** AC-P4 — RSS 폴이 채널 단위로 이만큼 연속 실패하면 경보 */
  rssFailThresholdCount: z.number().int().positive().default(5),
  /** AC-P7 — 구독 갱신이 이만큼 연속 실패하면 경보 */
  renewFailThresholdCount: z.number().int().positive().default(3),
  /**
   * AC-P7 — 리스 잔여가 이 비율 미만이면 경보.
   *
   * ★ 갱신 자체는 **50% 시점**에 한다. 이 값은 "갱신이 안 되고 있다"를 잡는 경보선이지
   *   갱신 시점이 아니다. 둘을 같은 값으로 두면 정상 갱신마다 경보가 난다.
   */
  leaseWarnRatio: z.number().positive().max(1).default(0.2),
});

const RecoverySchema = z.object({
  /**
   * 이 시간을 넘겨 다운돼 있었으면 **밀린 유튜브 업로드를 생략**한다 (AC-30).
   *
   * ★ 생략 대상은 **이미 지나간 이벤트뿐**이다. 진행 중인 방송은 생략 대상이
   *   아니며 §S7 의 3상태 판정을 그대로 적용해 `announce` 면 1회 공지한다
   *   (§5.1 경계 2 — 늦은 공지가 누락보다 낫다, §3-a).
   */
  downtimeThresholdHours: z.number().int().positive().default(6),
});

const AlertsSchema = z.object({
  enabled: z.boolean().default(true),
  /** 같은 `(scope, kind)` 를 이 간격 안에 반복 발송하지 않는다. 0 이면 디바운스 끔 */
  minIntervalMin: z.number().int().min(0).default(30),
});

const BaseConfigSchema = z.object({
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  logRetentionDays: z.number().int().positive().default(14),
  paths: PathsSchema.default({}),
  startup: StartupSchema.default({}),
  web: WebSchema,
  chzzkbot: ChzzkbotSchema.default({}),
  live: LiveSchema.default({}),
  follower: FollowerSchema.default({}),
  http: HttpSchema.default({}),
  auth: AuthSchema.default({}),
  youtube: YoutubeSchema.default({}),
  recovery: RecoverySchema.default({}),
  alerts: AlertsSchema.default({}),
});

/**
 * cross-field 불변식 — §2-b 파생 관계를 기계가 지킨다.
 */
export const ConfigSchema = BaseConfigSchema.superRefine((cfg, ctx) => {
  // ① 폴링 주기는 재시도 창보다 **짧아야** 한다 (§5.1 경계 1).
  //    같거나 길면 chzzkbot 재시도가 끝난 뒤에야 우리가 보게 되어
  //    "두 인입의 커버 구간을 빈틈없이 잇는다"(DD-1)가 깨진다.
  if (cfg.live.apiPollIntervalMin >= CHZZKBOT_RETRY_WINDOW_MIN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['live', 'apiPollIntervalMin'],
      message:
        `apiPollIntervalMin(${String(cfg.live.apiPollIntervalMin)}) 이 chzzkbot 재시도 창 ` +
        `${String(CHZZKBOT_RETRY_WINDOW_MIN)}분보다 짧지 않습니다. ` +
        '재시도가 끝난 구간을 폴링이 이어받지 못해 감지 공백이 생깁니다 (계획 §5.1 경계 1).',
    });
  }

  // ② 웹훅 침묵 유예창은 재시도 창보다 **길어야** 한다 (AC-P6).
  //    짧으면 "다운 ≤ 7분 → 재시도가 메운다" 는 **정상 시퀀스가 경보를 낸다** —
  //    웹훅이 멀쩡한데 오경보가 뜨고, 그 오경보가 진짜 신호를 덮는다 (계획 rev.5).
  if (cfg.live.webhookSilenceGraceMin <= CHZZKBOT_RETRY_WINDOW_MIN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['live', 'webhookSilenceGraceMin'],
      message:
        `webhookSilenceGraceMin(${String(cfg.live.webhookSilenceGraceMin)}) 이 chzzkbot 재시도 창 ` +
        `${String(CHZZKBOT_RETRY_WINDOW_MIN)}분보다 길지 않습니다. ` +
        '정상적인 재시도 시퀀스가 웹훅 침묵 경보를 냅니다 (AC-P6 유예창).',
    });
  }

  // ③ 팔로워 신선도 임계는 상류 캐시의 최악 나이보다 커야 한다 (§5.2).
  //    작으면 팔로워 수가 안 변하는 채널이 **무고장으로 게이트를 밟는다** —
  //    120분이 정확히 그 값이어서 150분으로 재유도한 것이 rev.8 이다.
  if (cfg.follower.staleAfterMin <= FOLLOWER_UPSTREAM_WORST_AGE_MIN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['follower', 'staleAfterMin'],
      message:
        `staleAfterMin(${String(cfg.follower.staleAfterMin)}) 이 상류 캐시 최악 나이 ` +
        `${String(FOLLOWER_UPSTREAM_WORST_AGE_MIN)}분(2×sweepInterval + followerCacheMin)보다 크지 않습니다. ` +
        '정상 상태의 채널이 무고장으로 신선도 게이트에 걸립니다 (계획 §2-b).',
    });
  }

  // ⑤ 포트 재시도 창은 systemd 정지 유예(30초)보다 **짧으면 안 된다** (§5.4 rev.3).
  //    짧으면 정상 종료 중인 앞 인스턴스를 끝까지 기다리지 못하고 exit 78 로 죽는다 —
  //    그건 "일시적"인 상황을 "영구"로 오판한 것이고, 배포 때마다 사람이 손으로
  //    재기동해야 한다는 뜻이다. 길게 두는 것은 안전한 방향이라 막지 않는다.
  if (cfg.startup.bindRetrySec < SYSTEMD_TIMEOUT_STOP_SEC) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['startup', 'bindRetrySec'],
      message:
        `bindRetrySec(${String(cfg.startup.bindRetrySec)}) 이 systemd TimeoutStopSec ` +
        `${String(SYSTEMD_TIMEOUT_STOP_SEC)}초보다 짧습니다. ` +
        '정상 종료 중인 앞 인스턴스를 기다리지 못하고 exit 78 로 종료합니다 (계획 §5.4).',
    });
  }

  // ④ 우리 포트가 chzzkbot 포트와 같으면 기동이 EADDRINUSE 로 죽는다.
  //    같은 호스트에 둘이 뜨는 것이 확정된 배치라(§5.4) 오타 한 번이 곧 장애다.
  //    포트를 락 프로토콜의 1차 프리미티브로 삼은 만큼(rev.3 ⑩) 설정에서 미리 막는다.
  const upstreamPort = portOf(cfg.chzzkbot.baseUrl);
  if (upstreamPort !== undefined && upstreamPort === cfg.web.port) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['web', 'port'],
      message:
        `web.port(${String(cfg.web.port)}) 가 chzzkbot.baseUrl 의 포트와 같습니다. ` +
        '같은 호스트에 두 프로세스가 뜨므로 기동이 EADDRINUSE 로 실패합니다 (계획 §5.4).',
    });
  }
});

/** URL 의 포트. 명시되지 않았으면 스킴 기본값, 그것도 모르면 undefined. */
function portOf(url: string): number | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.port !== '') return Number.parseInt(u.port, 10);
  if (u.protocol === 'http:') return 80;
  if (u.protocol === 'https:') return 443;
  return undefined;
}

export type FileConfig = z.infer<typeof ConfigSchema>;

// ══════════════════════════════════════════════════════════════════
//  .env — 시크릿
// ══════════════════════════════════════════════════════════════════

/**
 * ★ `LIVE_EVENT_WEBHOOK_TOKEN` 과 `LIVE_API_TOKEN` 은 봇 토큰과 **같은 등급**이다
 *   (계획 §S2 ★). 특히 `LIVE_API_TOKEN` 은 계약 §2 가 경고한 대로 운영자 전용이며
 *   **chzzkbot 에 등록된 모든 채널을 연다.**
 *   `.env` 전용 · `redact` 대상 · `config.yaml` 금지 — 세 가지가 한 세트다.
 */
export const SecretsSchema = z.object({
  /** 디스코드 봇 토큰 (게이트웨이) */
  DISCORD_BOT_TOKEN: requiredString('DISCORD_BOT_TOKEN'),
  /**
   * 운영 경보 웹훅. **선택**이다 — 미설정은 오류가 아니라 "경보를 안 보낸다"이고
   * `createDiscordNotifier` 가 조용히 건너뛴다.
   */
  DISCORD_OPS_WEBHOOK_URL: z.string().url().optional(),
  /** chzzkbot → 우리. 수신 시 상수 시간 비교로 검증한다 (AC-14) */
  LIVE_EVENT_WEBHOOK_TOKEN: requiredString('LIVE_EVENT_WEBHOOK_TOKEN'),
  /** 우리 → chzzkbot `GET /api/live`. `x-chzzkbot-token` 헤더로 싣는다 */
  LIVE_API_TOKEN: requiredString('LIVE_API_TOKEN'),
  /**
   * 시청자 인증용 치지직 앱.
   *
   * ★★ **chzzkbot 과 같은 clientId 를 쓰면 안 된다** (§5.2-c 불변식).
   *   같으면 시청자 인증 1건의 revoke 가 **chzzkbot 스트리머 토큰을 죽여
   *   팔로워 검증이 전원 정지**한다. 기계로 검사할 수 없어(상대 값을 우리가 모른다)
   *   런북 체크리스트가 지킨다.
   */
  CHZZK_CLIENT_ID: requiredString('CHZZK_CLIENT_ID'),
  CHZZK_CLIENT_SECRET: requiredString('CHZZK_CLIENT_SECRET'),
});

export type Secrets = z.infer<typeof SecretsSchema>;

/**
 * `config.yaml` 에 있으면 **기동을 거부하는** 키 이름.
 *
 * ★ 왜 키 이름으로 막는가. 설정 파일은 읽기 전용 볼륨으로 마운트되고 백업·저장소에
 *   섞이기 쉽다. "여기 적어도 동작은 한다"가 되는 순간 누군가 적고, 그 파일이
 *   커밋된다. **동작하지 않게** 만드는 것이 유일하게 확실한 방어다.
 *
 * ★ 접미사로 판정하되 `webhookSilenceGraceMin` 같은 정상 키를 잡지 않도록
 *   **끝나는 형태**만 본다. `redact.ts` 의 키 이름 그물(`/webhook/`)을 그대로 쓰면
 *   그 정상 키가 걸려 설정 파일이 영영 통과하지 못한다.
 */
const FORBIDDEN_KEY_SUFFIX = /(token|secret|password|credential|apikey|webhookurl)$/i;

/** 접미사 규칙에 안 걸리는 알려진 이름들 (환경변수 표기 그대로 적는 경우) */
const FORBIDDEN_KEY_EXACT = new Set(
  ['DISCORD_BOT_TOKEN', 'DISCORD_OPS_WEBHOOK_URL', 'LIVE_EVENT_WEBHOOK_TOKEN', 'LIVE_API_TOKEN', 'CHZZK_CLIENT_ID', 'CHZZK_CLIENT_SECRET'].map(
    (k) => k.toLowerCase(),
  ),
);

export function isForbiddenConfigKey(key: string): boolean {
  const k = key.toLowerCase();
  return FORBIDDEN_KEY_EXACT.has(k) || FORBIDDEN_KEY_SUFFIX.test(k.replace(/_/g, ''));
}

/** 최종 설정 — 파일과 시크릿을 합쳐 들고 다닌다. */
export interface AppConfig {
  readonly file: FileConfig;
  readonly secrets: Secrets;
}
