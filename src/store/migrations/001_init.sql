-- 001_init — 계획 §8 데이터 모델 전체
--
-- 이 파일은 **한 번 적용되면 고치지 않는다.** 고쳐야 할 것은 002 로 간다.
--
-- 시각은 전부 TEXT ISO-8601(UTC). SQLite 에 날짜 타입이 없으므로 문자열 정렬이
-- 곧 시간 정렬이 되도록 포맷을 고정한다.
--
-- ★ 이 파일에 PRAGMA 나 BEGIN/COMMIT 을 쓰지 않는다.
--   러너(migrate.ts)가 각 마이그레이션을 하나의 트랜잭션으로 감싸는데,
--   트랜잭션 안에서는 exec 로 BEGIN 을 다시 열 수 없고, 트랜잭션 안의
--   PRAGMA foreign_keys 는 SQLite 가 **조용히 무시한다.**
--   FK 는 db.ts 의 openDb 가 켜고 실제로 켜졌는지까지 되읽어 확인한다.
--
-- schema_migrations 는 여기서 만들지 않는다. 러너가 소유한다 —
-- 장부는 마이그레이션의 산출물이 아니라 러너가 돌기 위한 전제이기 때문이다.


-- ══════════════════════════════════════════════════════════════════
--  길드 설정 (가정 5)
-- ══════════════════════════════════════════════════════════════════
--
-- 채널·역할 id 는 길드마다 다르므로 설정 파일이 아니라 DB 에 둔다.
-- config/config.yaml 은 "이 프로세스가 어떻게 도는가"이고, 여기는
-- "이 서버에서 어디에 쓰는가"다.
CREATE TABLE guild_config (
  guild_id          TEXT PRIMARY KEY,
  verified_role_id  TEXT,                 -- 인증 완료 시 부여할 역할
  gate_channel_id   TEXT,                 -- /인증 안내가 놓이는 게이트 채널
  live_channel_id   TEXT,                 -- 방송 시작 공지
  upload_channel_id TEXT,                 -- 유튜브 업로드 공지
  ops_channel_id    TEXT,                 -- 운영 경보 (AC-P1~P7)
  updated_at        TEXT NOT NULL
) WITHOUT ROWID;


-- ══════════════════════════════════════════════════════════════════
--  계정 연동 (AC-7)
-- ══════════════════════════════════════════════════════════════════
--
-- ★ UNIQUE (guild_id, chzzk_channel_id) 가 AC-7 의 전부다.
--   한 치지직 계정으로 여러 디스코드 계정이 인증받는 것을 **조건문이 아니라
--   제약이 막는다** (계획 Principle 1 의 같은 사고방식).
--
-- ★ guild_config 로의 FK 를 걸지 않는다.
--   인증이 길드 설정보다 먼저 일어날 수 있고, 그때 FK 가 인증을 거부하면
--   "설정을 아직 안 했다"가 "인증 실패"로 보인다. 무결성보다 순서 결합이 비싸다.
CREATE TABLE account_links (
  discord_user_id    TEXT NOT NULL,
  guild_id           TEXT NOT NULL,
  chzzk_channel_id   TEXT NOT NULL,
  chzzk_channel_name TEXT NOT NULL,
  linked_at          TEXT NOT NULL,
  PRIMARY KEY (discord_user_id, guild_id),
  UNIQUE (guild_id, chzzk_channel_id)
);


-- ══════════════════════════════════════════════════════════════════
--  인증 세션 (AC-3, AC-12)
-- ══════════════════════════════════════════════════════════════════
--
-- ★ state 가 PK 이고 discord_user_id 가 **별도 컬럼**인 것이 AC-3 이다.
--   OAuth state 만으로 주인을 정하면 링크를 가로챈 사람이 남의 자리에 앉는다.
--   콜백에서 state → 세션 → discord_user_id 순으로 귀속을 확인한다.
--
-- ★ nonce 는 원문이 아니라 해시로 둔다. DB 가 유출돼도 진행 중인 흐름을
--   재현할 수 없어야 한다.
--
-- ★ is_follower 는 3상태다 — NULL 이 `unknown` 이다 (계획 §5.2).
--   `unknown` 을 0(미팔로우)으로 접는 순간 §3-a 3위(틀리게)로 떨어진다.
--
-- result 에 CHECK 를 걸지 않는다: 어휘를 확정하는 것은 S4 이고,
-- 코드와 어긋난 CHECK 목록이 어떤 사고를 내는지는 alert_kind 주석에 적어 뒀다.
CREATE TABLE verification_sessions (
  state           TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  nonce_hash      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  result          TEXT,
  is_follower     INTEGER CHECK (is_follower IS NULL OR is_follower IN (0, 1))
) WITHOUT ROWID;

-- 만료 세션 정리(§5.6.2 MAX_PENDING)와 대기 수 집계가 이 인덱스를 탄다.
CREATE INDEX idx_verification_sessions_expires ON verification_sessions (expires_at);


-- ══════════════════════════════════════════════════════════════════
--  공지 원장 — ★ 중복 0 / 누락 0 의 단일 진실원 (계획 Principle 1)
-- ══════════════════════════════════════════════════════════════════
--
-- 웹훅 · API 폴링 · 복구, **세 인입이 전부 이 문 하나를 지난다.**
-- 발송은 `INSERT … ON CONFLICT DO NOTHING` 의 changes === 1 인 쪽만 한다.
-- 중복 방지가 조건문이 아니라 PRIMARY KEY (kind, event_key) 다.
--
-- ★★ CHECK (seeded = 0 OR kind = 'youtube_upload') — 계획 rev.4 B-1.
--   `seeded` 는 AC-26 최초 기동 시딩 표식이고 **유튜브 경로에서만** 선다.
--   라이브 경로에 seeded 행을 미리 세우면 이후 announce 의 claim 이
--   **반드시 실패**해 방송 공지가 영영 나가지 않는다 (§5.1 경계 2).
--   주석으로는 재발을 막지 못하므로 제약으로 세운다.
CREATE TABLE announcement_ledger (
  kind         TEXT NOT NULL CHECK (kind IN ('live_start', 'youtube_upload')),
  event_key    TEXT NOT NULL,
  detected_via TEXT NOT NULL
               CHECK (detected_via IN ('webhook', 'api-poll', 'websub', 'rss', 'recovery', 'seed')),
               -- live  : webhook / api-poll / recovery       (§9.4 live_detected_via)
               -- youtube: websub / rss / recovery / seed     (§9.4 youtube_detected_via)
  claimed_at   TEXT NOT NULL,
  announced_at TEXT,
  message_id   TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  seeded       INTEGER NOT NULL DEFAULT 0 CHECK (seeded IN (0, 1)),
  PRIMARY KEY (kind, event_key),
  CHECK (seeded = 0 OR kind = 'youtube_upload')
) WITHOUT ROWID;

-- 아웃박스(§S3 FM5)가 회수할 미발송 행. 부분 인덱스라 정상 행은 인덱스에 남지 않는다.
CREATE INDEX idx_ledger_pending ON announcement_ledger (claimed_at)
  WHERE announced_at IS NULL;


-- ══════════════════════════════════════════════════════════════════
--  라이브 세션 (AC-16, AC-31)
-- ══════════════════════════════════════════════════════════════════
--
-- ★ open_date 와 opened_at 을 **둘 다** 저장한다 (계획 §8).
--   open_date 는 계약이 준 원문(KST 표기)으로 **신원**이다 — 비교와 키에 쓴다.
--   opened_at 은 UTC 로 **시각 계산**에 쓴다 — 지연 측정(§2)과 다운타임 판정(§S7).
--   하나로 접으면 둘 중 하나가 파생값이 되고, 파생 규칙이 틀린 날
--   같은 방송이 다른 방송으로 보이거나 지연이 9시간 어긋난다.
CREATE TABLE live_sessions (
  live_hash      TEXT PRIMARY KEY,
  open_date      TEXT NOT NULL,   -- 계약 원문 (KST 표기). 신원 · 비교의 기준
  opened_at      TEXT NOT NULL,   -- ISO-8601 UTC. 시각 계산의 기준
  live_title     TEXT,
  live_id        TEXT,
  category_value TEXT,
  status         TEXT NOT NULL,
  first_seen_at  TEXT NOT NULL,   -- 우리가 처음 본 시각 (웹훅이든 폴링이든)
  closed_at      TEXT
) WITHOUT ROWID;


-- ══════════════════════════════════════════════════════════════════
--  유튜브 (AC-20, AC-26)
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE youtube_channels (
  channel_id       TEXT PRIMARY KEY,
  label            TEXT NOT NULL,
  seeded_at        TEXT,          -- AC-26 최초 기동 시딩을 마친 시각. NULL 이면 미시딩
  last_rss_poll_at TEXT
) WITHOUT ROWID;

-- ★ FK 를 여기에 거는 이유: 채널 없는 구독은 의미가 없고, 채널을 지웠는데
--   구독이 남으면 갱신 잡이 유령 채널을 계속 재구독한다.
--   이 FK 가 openDb 의 foreign_keys 검증이 지키는 대상이다.
CREATE TABLE websub_subscriptions (
  channel_id       TEXT PRIMARY KEY REFERENCES youtube_channels (channel_id) ON DELETE CASCADE,
  secret           TEXT NOT NULL,  -- HMAC 검증용. 채널마다 다르다 (AC-P5)
  lease_seconds    INTEGER,
  subscribed_at    TEXT,
  expires_at       TEXT,
  last_renew_error TEXT            -- 연속 3회면 AC-P7 경보
) WITHOUT ROWID;


-- ══════════════════════════════════════════════════════════════════
--  경보 상태 (AC-19, AC-34)
-- ══════════════════════════════════════════════════════════════════
--
-- ★★ alert_kind 의 CHECK 목록은 src/runtime/alerts/types.ts 의 ALERT_KINDS 와
--   **한 글자도 달라선 안 된다.**
--   다르면 INSERT 가 CHECK 위반으로 실패하는데, 하필 그 실패가 "경보를 보내려던
--   순간"에 일어나므로 **아무도 모르게 경보가 사라진다.** chzzkbot 이 실제로 겪은
--   사고이고(계획 §8), 그래서 통합 테스트가 두 목록을 대조한다.
--
-- ★ PK 가 (scope, alert_kind) 인 것이 chzzkbot 과의 차이다.
--   chzzkbot 은 (channel_id, alert_kind) 였는데 여기서는 경보의 주체가
--   치지직 채널만이 아니다 — 유튜브 채널·길드·시스템 전역이 섞인다.
--   kind 만으로 키잉하면 유튜브 채널 하나의 RSS 실패가 나머지 채널의 같은
--   경보를 통째로 삼킨다.
CREATE TABLE alert_state (
  scope            TEXT NOT NULL,   -- 치지직/유튜브 채널 id · 길드 id · '__system__'
  alert_kind       TEXT NOT NULL CHECK (alert_kind IN (
                     'confirmed_stuck',    -- AC-P1  live && !confirmed 고착
                     'live_api_unknown',   -- AC-P2  조회 API unknown 연속
                     'rss_fail',           -- AC-P4  RSS 폴 연속 실패
                     'websub_signature',   -- AC-P5  WebSub 서명 검증 실패
                     'webhook_silence',    -- AC-P6  웹훅 침묵 중 폴링이 announce
                     'websub_lease',       -- AC-P7  리스 잔량 · 갱신 연속 실패
                     'follower_stale',     -- §5.2   팔로워 스냅샷 노후 (배선만, S1-J 전까지 미가동)
                     'unknown_channel',    -- §5.2-c 설정에 없는 채널이 폴링 응답에 보임
                     'discord_send_failed',-- AC-19  발송 재시도 소진
                     'auth_pending_max',   -- §5.6.2 verification_sessions MAX_PENDING 도달
                     'downtime_detected',  -- AC-30  다운타임 감지 · 밀린 알림 생략 보고
                     'heartbeat_stale'     -- AC-34  하트비트 노후 (프로세스 내 관측분)
                   )),
  last_sent_at     TEXT,
  suppressed_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, alert_kind)
) WITHOUT ROWID;


-- ══════════════════════════════════════════════════════════════════
--  운영 이벤트 (AC-8, AC-14, AC-30)
-- ══════════════════════════════════════════════════════════════════
--
-- 경보(alert_state)와 다르다. 경보는 "사람을 부르는 것"이고 여기는
-- "무슨 일이 있었는지 나중에 읽는 것"이다. 수동 승인(AD-3)·계약 위반 페이로드·
-- 다운타임 구간이 여기 남는다.
CREATE TABLE ops_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  kind   TEXT NOT NULL,
  detail TEXT,
  at     TEXT NOT NULL
);

CREATE INDEX idx_ops_events_at ON ops_events (at);


-- ══════════════════════════════════════════════════════════════════
--  런타임 상태 (AC-29, AC-30)
-- ══════════════════════════════════════════════════════════════════
--
-- 알려진 키: last_seen_at · last_live_poll_at · last_webhook_at
-- 키를 CHECK 로 고정하지 않는다 — 여기는 어휘가 자랄 자리이고,
-- 잘못 고정된 CHECK 가 무엇을 하는지는 alert_kind 주석이 말한다.
CREATE TABLE runtime_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;


-- ══════════════════════════════════════════════════════════════════
--  ★ 팔로워 테이블은 만들지 않는다 (계획 §8 · Pre-mortem 3)
-- ══════════════════════════════════════════════════════════════════
--
-- rev.6 에서 팔로워 확인을 chzzkbot 조회 API 에 위임했다. 여기에 followers
-- 테이블을 만드는 순간 "우리도 캐시하자" → "상시 동기화하자" 로 자라날 자리가
-- 생기고, 그 자리는 우리가 지운 설계(조회 예산 계층 R · 스트리머 토큰 보관)를
-- 그대로 되살린다. 만들지 않는 것이 이 파일이 하는 일 중 하나다.
