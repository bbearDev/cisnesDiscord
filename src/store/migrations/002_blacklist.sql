-- 002_blacklist — 인증 차단 목록 (`/블랙리스트`)
--
-- 001 과 같은 규칙: 적용되면 고치지 않는다. PRAGMA · BEGIN 을 쓰지 않는다 (러너가
-- 트랜잭션을 소유한다 — 001 머리말).
--
-- ★ 운영자가 차단한 사람은 **역할을 잃고 다시 인증할 수 없다.** 재인증을 막는 자리는
--   둘이다 — 인증 버튼(`commands/link.ts`)과 OAuth 콜백(`web/routes/oauth-callback.ts`).
--   콜백 쪽이 본체다: 차단 전에 발급된 state 로 늦게 돌아오는 경우까지 거기서 막힌다.
--
-- ★★ 키가 **둘**이다 — 디스코드 계정과, 차단 시점에 연동돼 있던 치지직 채널.
--   디스코드 계정만 막으면 새 디스코드 계정을 만들어 **같은 치지직 계정**으로 다시 인증하는
--   우회가 남는다. 인증의 실체는 치지직 계정이므로 그쪽도 같이 막는다. 차단 시점에 연동이
--   없었으면 NULL 이고, 그때는 디스코드 계정만 막힌다 — 모르는 값을 지어내지 않는다.
--
-- ★ `account_links` 행은 차단할 때 **지운다** (`commands/blacklist.ts`). 연동 테이블은
--   현재 상태만 담고(AC-9 와 같은 원칙) 차단 이력은 이 테이블과 `ops_events` 가 담는다.
--   해제하면 이 행만 지우고 연동은 되살리지 않는다 — 다시 인증하는 것이 해제된 사람의 길이다.
CREATE TABLE blacklist (
  guild_id           TEXT NOT NULL,
  discord_user_id    TEXT NOT NULL,
  chzzk_channel_id   TEXT,            -- 차단 시점에 연동돼 있던 치지직 채널. 없었으면 NULL
  chzzk_channel_name TEXT,
  reason             TEXT,            -- 운영자가 적은 사유. 임베드에 그대로 보인다
  added_by           TEXT NOT NULL,   -- 차단한 운영자 (디스코드 유저 id)
  added_at           TEXT NOT NULL,   -- ISO-8601 UTC
  PRIMARY KEY (guild_id, discord_user_id)
) WITHOUT ROWID;

-- 콜백이 치지직 채널로 되묻는 조회. 부분 인덱스라 NULL 행은 인덱스에 남지 않는다.
CREATE INDEX idx_blacklist_channel ON blacklist (guild_id, chzzk_channel_id)
  WHERE chzzk_channel_id IS NOT NULL;
