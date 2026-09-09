# cisnesDiscord 운영 런북

계획 §S8 · §5.4 · §5.6.2 · §12-b 기준. **배포 전후로 이 문서의 체크리스트를 실제로 실행한다.**

관련 문서
- `docs/s0-prerequisites.md` — 사람이 해야 하는 선행 조건(자격증명·프록시·chzzkbot 설정)
- `docs/acceptance-checklist.md` — AC-1~35 · AC-P1~P7 검증 항목
- `.omc/plans/cisnes-discord-implementation.md` — 설계 정본

---

## 0. 이 봇이 무엇에 의존하는가 (한 장 요약)

```
                    공개 HTTPS (프록시가 종단)
                    ┌─────────────────────────────┐
  치지직 OAuth ─────▶│ /oauth/chzzk/<콜백>          │
  유튜브 WebSub 허브 ▶│ /websub/youtube/:chId       │──▶ 127.0.0.1:8081
                    └─────────────────────────────┘         cisnesDiscord
                                                                 │  ▲
                            루프백 (프록시 불필요)                  │  │
   chzzkbot ──웹훅 POST──▶ 127.0.0.1:8081/hooks/chzzkbot/live ────┘  │
   127.0.0.1:8080 ◀────── GET /api/live (폴링 3분) ──────────────────┘
                  ◀────── GET /api/followers/... (인증 1건당 1회) ────┘
```

**공개해야 하는 경로는 둘뿐이다.** chzzkbot 과의 통합 2경로는 같은 호스트라 루프백이다.

> ⚠️ **chzzkbot 이 내려가면 폭발 반경이 크다.** 라이브 폴링뿐 아니라 **온보딩 전체**(팔로워 검증)가
> 함께 멈춘다(계획 §12-b-1). 그때의 완화책은 §5.4 의 **AD-3 수동 승인**이다.

---

## 1. 설치

### 1-1. 전제

- Node ≥ 22 (개발 검증은 v24.13.0)
- chzzkbot 이 같은 계정·같은 호스트에서 이미 돌고 있을 것
- `docs/s0-prerequisites.md` 의 S0 항목이 완료됐을 것

### 1-2. 절차

```bash
cd ~/git/cisnesDiscord
npm ci
npm run build

cp config/config.example.yaml config/config.yaml
cp .env.example .env
chmod 600 .env
# config.yaml 과 .env 의 REQUIRED 를 실제 값으로 바꾼다.
# ★ REQUIRED 가 하나라도 남으면 봇이 exit 78 로 기동을 거부한다 (설계된 동작).

mkdir -p data logs

cp deploy/systemd/cisnesdiscord.service            ~/.config/systemd/user/
cp deploy/systemd/cisnesdiscord-watchdog.service   ~/.config/systemd/user/
cp deploy/systemd/cisnesdiscord-watchdog.timer     ~/.config/systemd/user/
# ⚠️ 유닛 안의 WorkingDirectory / ExecStart 경로와 node 바이너리 경로를
#    이 호스트의 실제 값으로 맞춘다.

systemctl --user daemon-reload
systemctl --user enable --now cisnesdiscord.service
systemctl --user enable --now cisnesdiscord-watchdog.timer
```

### 1-3. ★★ `enable-linger` — 빠뜨리면 AC-33 이 재부팅 한 번에 깨진다

```bash
loginctl show-user "$USER" --property=Linger    # Linger=yes 여야 한다
loginctl enable-linger "$USER"                  # no 이면 켠다 (sudo 필요할 수 있음)
```

> 사용자 유닛은 그 사용자의 세션이 없으면 함께 죽는다. 켜지 않으면 **SSH 를 끊는 순간 봇이 내려간다.**
> chzzkbot 이 이미 돌고 있으므로 켜져 있을 가능성이 높지만 **확인한다.**

### 1-4. 워치독 환경 파일

```bash
mkdir -p ~/.config/cisnesdiscord
printf 'DISCORD_WEBHOOK_URL=<운영 알림용 웹훅 URL>\n' > ~/.config/cisnesdiscord/watchdog.env
chmod 600 ~/.config/cisnesdiscord/watchdog.env
```

---

## 2. ★ 배포 체크리스트 — 배포할 때마다 전부 실행한다

계획 §S8 "배포 런북 필수 항목". **저장소 밖 설정이 섞여 있어 코드로는 잡히지 않는 항목들이다.**

### 2-1. `clientId` 대조 ★★ (설정 불변식 — 배포마다 본다)

```bash
journalctl --user -u cisnesdiscord -n 200 | grep -i 'clientId'
grep '^CHZZK_CLIENT_ID=' ~/git/chzzkbot/.env
```

> **두 값이 같으면 즉시 멈춘다.** 같으면 시청자 인증 1건이 chzzkbot 의 스트리머 토큰을 함께
> 죽이고(`revoke` 는 "clientId 와 user 가 같은 모든 토큰"을 제거한다), **팔로워 검증이 전원 정지**한다.
> 복구에는 스트리머의 브라우저 재인가가 필요하다. 자세한 연쇄는 `docs/s0-prerequisites.md` §6.3.

### 2-2. 프록시 경로 도달 확인

```bash
curl -sS -o /dev/null -w 'oauth  %{http_code}\n'  "https://<HOST>/oauth/chzzk/callback"
curl -sS -o /dev/null -w 'websub %{http_code}\n'  "https://<HOST>/websub/youtube/<채널ID>"
# 502 / 404 가 아니면 경로는 살아 있다 (인자 없는 요청이라 400 이 정상일 수 있다)
```

### 2-3. ★ IP 리밋이 실제로 걸려 있는지

```bash
for i in $(seq 1 80); do
  curl -sS -o /dev/null -w '%{http_code} ' "https://<HOST>/oauth/chzzk/callback"
done; echo
# 60건 근처부터 429 가 섞여야 한다.
```

> 프록시 설정은 저장소 밖이라 **빠뜨려도 코드로는 잡히지 않는다** — 그래서 체크리스트 항목이다.
> `/websub/` 에는 리밋을 걸지 않는다(허브 IP 가 소수에 몰려 정상 푸시가 조용히 드롭된다).

### 2-4. chzzkbot 연동 확인

```bash
# 조회 API 가 열려 있는가
curl -sS -H "x-chzzkbot-token: $LIVE_API_TOKEN" http://127.0.0.1:8080/api/live | head -c 400
# 404 면 chzzkbot 의 WEB_PORT / liveEvents.api.enabled 를 본다

# chzzkbot 이 웹훅을 실제로 쏘는가
journalctl --user -u chzzkbot -n 500 | grep -E '방송 이벤트 웹훅|방송 시작을 외부로'

# 미배달 건이 쌓이고 있는가
sqlite3 ~/git/chzzkbot/data/bot.db \
  "SELECT COUNT(*) FROM live_event_deliveries WHERE delivered_at IS NULL;"
```

### 2-5. 우리 쪽 기동 확인

```bash
systemctl --user status cisnesdiscord --no-pager
curl -sS http://127.0.0.1:8081/healthz
journalctl --user -u cisnesdiscord -n 100 | grep -i 'bind'   # 127.0.0.1:8081 이어야 한다
npm run secrets:scan
```

---

## 3. ★★ 스트리머 운영 절차 (S0-13) — 없으면 무채팅 방송이 누락된다

> ### 방송 시작 체크리스트 (스트리머용, 한 줄)
> **방송을 켠 직후 자기 채팅창에 아무 한 줄이나 친다.** (또는 `!방송시작` 을 실행한다)

**왜 필요한가.** chzzkbot 의 자동 감지 트리거는 **첫 채팅 하나뿐**이다.
아무도 채팅을 치지 않으면 세션이 열리지 않고, 세션이 없으면 웹훅도 `/api/live` 도 침묵한다.
그러면 `/api/live` 는 `live:false` 를 답하는데 **이것이 "방송 중 아님"과 구분되지 않는다.**

**이것이 무채팅 방송 누락을 막는 유일한 수단이다.** 기계로는 닫을 수 없는 구멍이고,
계획 §12-b 가 **알면서 받아들인 거래**로 문서화했다 — 버그가 아니다.

주의 2건:
- `!방송시작` 도 **채팅으로 입력하는 명령어**다. "채팅을 친다"와 같은 경로이며 별도 우회로가 아니다.
- 시청자가 대기 채팅을 치면 세션이 방송보다 먼저 열린다. 그래도 공지는 `confirmed` 이후에만
  나가므로 오알림이 되지 않는다. 스트리머의 한 줄은 **아무도 없을 때**를 위한 보험이다.

---

## 4. 장애 대응

### 4-1. 종료 코드로 먼저 가른다

```bash
systemctl --user show cisnesdiscord -p ExecMainStatus -p Result
```

| 코드 | 뜻 | 조치 | systemd 재시작? |
|---|---|---|---|
| **78** | 설정 문제 **또는 포트 점유 30초 초과** | 아래 4-2 · 4-3 | ❌ 안 함 (`RestartPreventExitStatus`) |
| **70** | DB·락·볼륨 문제 | 아래 4-4 | ❌ 안 함 |
| 그 외 | 일시 장애 | 자동 재시작(10초) | ✅ 함 |

> ★ **78·70 에서 재시작하지 않는 것이 설계다.** 사람이 고쳐야 하는 것을 10초마다 무한
> 재시도하면 로그만 뒤덮는다. `failed` 로 남고 워치독이 그 상태를 알린다.

### 4-2. exit 78 — 설정

```bash
journalctl --user -u cisnesdiscord -n 50 | grep -A5 '설정 오류'
```
`REQUIRED` 가 남아 있거나, §2-b 파생 상수 불변식을 위반한 값이다. 메시지가 어느 키인지 말해 준다.

> 파생 상수 불변식(기동 시 검사): `apiPollIntervalMin < 7` · `webhookSilenceGraceMin > 7` ·
> `staleAfterMin > 130`. **chzzkbot 설정이 바뀌면 이 값들을 함께 재유도한다** —
> 값은 `src/config/schema.ts` 의 상수 한 곳에서만 정의된다.

### 4-3. exit 78 — 포트 점유 (EADDRINUSE)

```bash
ss -ltnp | grep :8081
```
좀비 프로세스면 죽이고 재시작한다. 남의 프로세스면 포트를 바꾸거나 그쪽을 옮긴다.

> 봇은 30초 동안 백오프 재시도한 뒤 포기한다(이전 인스턴스의 정상 종료 시간
> `TimeoutStopSec=30` 과 같은 값). **무한 재시작 플래핑이 없어야 정상이다** — 있으면 회귀다(M-3).

### 4-4. exit 70 — DB / 락

```bash
ls -la data/                      # .lock 파일 확인
sqlite3 data/cisnes.db "PRAGMA integrity_check;"
```
락은 죽은 PID 면 자동 인수된다. 살아 있는 PID 가 잡고 있으면 **인스턴스가 둘**이라는 뜻이다(AC-35).

### 4-5. `failed` 상태 (재시작 한계 초과)

```bash
systemctl --user reset-failed cisnesdiscord && systemctl --user start cisnesdiscord
```
> 워치독이 이 상태를 잡아 알린다. `reset-failed` 를 치기 **전에** 왜 5분에 5번 죽었는지 로그를 본다.

### 4-6. ★ chzzkbot 이 죽었을 때 — 온보딩이 멈춘다

**증상**: `/인증` 이 전부 `unknown`(보류)으로 끝난다. `live_api_unknown_streak` 상승, AC-P2 경보.

> ## ⚠️ AD-3 수동 승인은 **아직 구현되지 않았다**
>
> 계획 §5.2 는 이 상황의 완화책으로 **AD-3(운영자 수동 승인)** 을 채택했지만,
> 그 기능은 `account_links.verified_by` 컬럼을 요구하고 **`001_init.sql` 에 그 컬럼이 없다.**
> 마이그레이션 `002` + 별도 작업이 필요하다.
>
> **그때까지의 현실**: chzzkbot 이 죽어 있는 동안 **신규 온보딩은 진행되지 않는다.**
> 기존 인증 사용자는 영향받지 않는다(역할은 이미 부여돼 있다).
> 복구 순서는 **chzzkbot 을 살리는 것**이며, 아래 §2-4 의 확인 절차를 먼저 돌린다.
>
> 이것은 알면서 받아들인 상태다 — 계획 §12-b-1 이 *"chzzkbot 다운 시 폭발 반경이
> AC 표면 1/3 → 2/3(온보딩 포함)"* 로 이미 기록했다.

**아래는 AD-3 를 구현할 때의 규칙이다 (현재는 참고용).**
**break-glass 이지 모드가 아니다. "게이트를 끈다"는 스위치를 만들지 않는다.**

| 규칙 | 내용 |
|---|---|
| 권한 | 운영자 전용 (`Manage Guild`) — `/연동해제` 와 같은 게이트 |
| 범위 | **사용자 1명씩 명시적으로** |
| 조건 | 판정이 **`unknown` 일 때만**. ★ **`no` 를 뒤집는 데 쓰지 않는다** |
| 기록 | `ops_events` + `verified_by='manual'` |
| 사후 | 상류 복구 후 `verified_by='manual'` 행을 **일괄 재검증**한다 ← 이것이 실질 억제 장치 |

**운영자가 무엇을 보고 판단하는가** (근거 3순위):
1. 그 사람의 치지직 채널을 직접 열어 팔로우 여부를 눈으로 확인
2. 서버 내 활동 이력
3. 스트리머/다른 운영자의 확인

---

## 5. 경보별 대응

| 경보 | 뜻 | 첫 확인 |
|---|---|---|
| **AC-P1** `confirmed` 고착 5분 | 방송 중인데 chzzkbot 스캔이 `openDate` 를 못 붙였다. **웹훅이 영영 안 나간다** | `journalctl --user -u chzzkbot \| grep '방송을 인식했습니다'` · 429 여부 |
| **AC-P2** `unknown` 5회 연속 | `/api/live` 가 조용히 죽었다 (chzzkbot 다운·토큰 무효·경로 변경) | §2-4 의 curl. 401 이면 `LIVE_API_TOKEN`, 404 면 `WEB_PORT`/`api.enabled` |
| **AC-P4** RSS 5회 연속 실패 | 이그레스·DNS·유튜브 도달 불가 | `curl -sS 'https://www.youtube.com/feeds/videos.xml?channel_id=<UC…>' \| head -c 200` |
| **AC-P5** WebSub 서명 실패 | 시크릿 불일치. **조용한 202 의 원인을 특정하는 유일한 축** | 구독을 지우고 재구독해 시크릿을 새로 발급 |
| **AC-P6** 웹훅 침묵 | 폴링이 공지했는데 같은 방송의 웹훅 기록이 없다 → **웹훅 경로가 고장** | chzzkbot `LIVE_EVENT_WEBHOOK_URL` 값 · 우리 8081 도달성 |
| **AC-P7** 리스 잔량/갱신 실패 | WebSub 구독이 만료되어 간다 | 이그레스 확인 후 수동 재구독 |
| 워치독: 하트비트 90분 | 프로세스는 살아 있는데 일을 안 한다 | `systemctl --user status` · 이벤트 루프 블로킹 의심 |

> ★ **`live_detected_via{api-poll}` 비율과 `youtube_detected_via{rss}` 비율에는 경보를 걸지 않는다.**
> 이벤트가 하루 0~2건이라 분모가 없어 1건만 폴백이어도 50% 가 된다. **주간 추세 확인용 지표**이고,
> 같은 실패는 AC-P6·AC-P4·AC-P7 이 절대 신호로 잡는다.

> ⚠️ **`follower_lookup_unknown_total{reason='stale'}` 경보는 아직 켜지 않는다.**
> `staleAfterMin` 150분이 **잠정값**(소스 상수 추론이지 실측이 아님)이라, 검증 안 된 임계로
> 경보하면 스코프 상실을 관측하는 **유일한 축**이 오탐에 덮인다. **S1-J 실측 후에 켠다.**
> 게이트(판정 보류)는 지금 켜져 있다 — 틀려도 안전한 방향이기 때문이다.

---

## 6. S9 수동 검증 — 사람이 실제로 해야 하는 4건

자동화할 수 없다. 출시 전 1회, 이후 회귀 의심 시 재실행.

| # | 절차 | 기대 |
|---|---|---|
| **M-1** | 대상 채널을 켜고 **아무도 채팅하지 않은 채** 10분 대기 | 공지 0건. `/api/live` 는 `live:false`. **§12-b 가 문서화한 그대로** — 버그로 처리하지 않는다 |
| **M-2** | M-1 상태에서 스트리머가 채팅 한 줄 입력 | 세션이 열리고 `confirmed` 도달 후 **공지 1건**, `detected_via='webhook'` |
| **M-3** | 다른 프로세스로 8081 을 점유한 채 `systemctl --user start` | 30초 백오프 후 **exit 78**, `status` 가 `failed`. 로그에 `ss -ltnp` 안내. **무한 재시작이 없어야 한다** |
| **M-4** | 새 계정으로 서버 입장 후 채널 목록 확인 | 안내 채널만 보인다. 인증 후 전부 보인다. **S0-9 디스코드 권한 설정의 결과이므로 봇 코드가 아니라 사람이 눈으로 확인한다** |

> **M-1 을 건너뛰면 "누락 0"의 실제 범위를 아무도 확인하지 않은 채 출시된다.**

---

## 7. 일상 점검

```bash
systemctl --user status cisnesdiscord cisnesdiscord-watchdog.timer --no-pager
curl -sS http://127.0.0.1:8081/healthz
journalctl --user -u cisnesdiscord --since '24 hours ago' -p warning
sqlite3 data/cisnes.db \
  "SELECT kind, detected_via, COUNT(*) FROM announcement_ledger
   WHERE claimed_at > datetime('now','-7 days') GROUP BY 1,2;"
```

**보는 법**
- `detected_via='api-poll'` 이 늘고 `webhook` 이 줄면 → 웹훅 경로가 병들고 있다 (AC-P6 이 잡는다)
- `youtube_upload` 의 `rss` 비율이 늘면 → WebSub 이 병들고 있다 (AC-P4/P7 이 잡는다)
- `announcement_claim_conflicts` 가 **0 이면 오히려 이상하다** — 원장이 실제로 막고 있다는 증거가 없다는 뜻

**월 1회 — 상류 팔로워 상한 감시 (§8-b)**
- 대상 채널의 치지직 팔로워 수를 확인한다. **10,000명에 근접하면** chzzkbot 쪽에 `maxPages` 상향을 요청한다.
- 넘어가도 **아무 신호가 없다** — 잘린 목록이 정상 응답과 구분되지 않는다. 그래서 사람이 세는 항목이다.
- 기준선(2026-09-07): 시스네 601명 · 아이곰 13명.

## 8. ★ 알려진 제약

### 8-a. 스키마에 컬럼이 없어 미룬 것 2건

계획 §8 의 `001_init.sql` 이 확정한 스키마에 없는 컬럼이 필요한 기능들이다.
**둘 다 마이그레이션 `002` 가 선행되어야 하며, 지금은 의도적으로 열려 있다.**

| # | 제약 | 지금 동작 | 넓히려면 |
|---|---|---|---|
| **1** | **단일 길드 배포가 전제다** — `verification_sessions` 에 `guild_id` 컬럼이 없어 OAuth 콜백이 세션만으로 어느 서버인지 알 수 없다 | `guild_config` 에서 해석한다. 설정된 길드가 없으면 **인증을 진행하지 않고 실패**시킨다(길드를 추측하지 않는다) | `002` 로 `verification_sessions.guild_id` 추가 |
| **2** | **AD-3 수동 승인 미구현** — `account_links.verified_by` 컬럼이 없다 | chzzkbot 다운 시 신규 온보딩이 멈춘다 (§4-6) | `002` 로 `account_links.verified_by` 추가 + 명령어 구현 |

> ★ **추측하지 않고 실패하는 쪽을 택한 이유.** 길드가 하나뿐인 배포에서 "아무 길드나
> 고르기"는 대개 맞는 답을 내지만, 두 번째 길드가 생기는 날 **조용히 남의 서버에
> 역할을 부여한다.** 우선순위 원칙(§3-a)으로 안 되는 것(2위)이 틀리는 것(3위)보다 낫다.

### 8-b. ★ 상류 팔로워 동기화 상한 — **10,000명**

> 이슈: `bbearDev/cisnesDiscord#2` · 상류 `bbearDev/chzzkbot#6`

chzzkbot 쪽 확인 결과(2026-09-07), 팔로워 동기화의 페이지 루프에 상한이 있다.

| 항목 | 값 |
|---|---|
| 상한 | `maxPages` 200 × 페이지당 50 = **10,000명** |
| 초과 시 | 목록이 **잘린 채로** 캐시가 교체되고 세대 시각(`cachedAt`)이 **정상 전진**한다 |
| 잘렸다는 신호 | **없다** — 로그도 응답 필드도 남지 않는다 |
| 현재 여유 | 시스네 **601명** · 아이곰 **13명** — 임계에서 한참 멀다 |
| 상류 이슈 | `bbearDev/chzzkbot#6` (원래 있던 결함이며 이번 API 추가가 만든 것이 아니다) |

**왜 우리에게 위험한가.** 10,000번째 밖의 팔로워는 **신선한 `cachedAt` 과 함께 `isFollower:false`** 를
받는다. 우리 신선도 게이트(§5.2-b 판정표 2)는 나이만 보므로 이 응답을 **정상으로 통과시키고**,
판정표 5 가 확신에 찬 `no` 를 낸다 — 즉 **실제 팔로워가 "팔로우한 뒤 다시 시도하세요" 를 받는다.**
우선순위 원칙(§3-a) 3위인 **틀리게 보내기**다.

> ⚠️ **이 상한을 설계 전제로 삼지 않는다.** 우리 쪽에서 기계로 감지할 수단이 없다 —
> 잘린 응답과 정상 응답이 **구조적으로 구분되지 않기 때문**이다. 사람이 지켜보는 수밖에 없다.

**대응**: 대상 채널 팔로워 수가 **10,000명에 근접하면 chzzkbot 쪽에 상한 상향을 요청한다.**
§7 일상 점검에 감시 항목으로 넣었다.

### 8-c. ☐ `FOLLOWER_UPSTREAM_WORST_AGE_MIN` 파생식이 실제 근거와 다르다 (미해결 · 지금은 무해)

> 이슈: `bbearDev/cisnesDiscord#1`

**상태: 지금 고장 난 것은 없다.** 두 계산이 같은 값 130 을 내므로 부팅 게이트는 정확히 옳게
동작한다. 고칠 것은 **값이 아니라 피연산자**다.

```
우리 식(schema.ts:55):  2 × sweepInterval(60)          + followerCacheMin(10)  = 130
실제 근거(상류 확인):    sweepInterval(60) + 지터max(60) + 틱양자화(10)          = 130
```

마지막 `+10` 두 개가 서로 다른 것이다 — 우리 쪽은 **캐시 TTL**, 실제는 **스케줄러 틱 양자화**.
둘은 독립이며, 지금 둘 다 10 인 것은 **우연**이다.

**진짜 결함은 상수 하나가 두 일을 한다는 것.** `UPSTREAM_FOLLOWER_CACHE_MIN` 이 지금 세 곳에 쓰인다:

| 위치 | 용도 | 맞는가 |
|---|---|---|
| `discord/messages.ts:103` | 안내 문구 *"최대 10분 뒤"* | ✅ |
| `chzzk/follower-check.ts:222` | AD-2 재조회 시각 | ✅ |
| `config/schema.ts:56` | **부팅 게이트 바닥값 피연산자** | ❌ 여기 와야 하는 건 **틱** |

→ 상류가 `followerCacheMin` 을 바꿔 우리가 상수를 고치면, 앞 둘은 옳게 따라가지만
**부팅 게이트 바닥이 아무 근거 없이 함께 움직인다.** §2-b 가 금지한 결합이다.

**깨지는 조건 — 상류가 바꾸고 우리가 모를 때만**

| 시나리오 | 실제 최악 | 우리 계산 | 결과 |
|---|---|---|---|
| 틱 10 → 30분 | 150분 | 130분(틱 항이 없어 안 움직임) | `staleAfterMin=150` 이 부팅 통과하나 게이트가 상시 발동 |
| 스윕 60 → 30분(지터 0~60 유지) | 100분 | 70분(지터를 간격의 1배로 묶어서) | `staleAfterMin=80` 이 부팅 통과하나 게이트가 상시 발동 |

**피해 등급: §3-a 2위(못 보냄).** 결과는 `unknown(stale)` 이라 틀린 사람에게 역할을 주지는
않는다. 온보딩이 멈추고, `follower_lookup_unknown_total{reason="stale"}` 이 무고장 상태에서
오르는 것이 신호로 남는다 — 조용히 썩지는 않는다.

**★ 고치기 전 확인 필요**: chzzkbot 이 *"60분 + 채널 고정 지터(0~60분)"* 라고만 알려줘서,
**지터 범위가 스윕 간격에서 파생되는지 고정 60분인지 미확인**이다. 이것이 위 시나리오 B 의
결과를 정반대로 바꾼다. 상류에 먼저 물어야 한다.

**고칠 때 할 일** (값 130 불변 — 동작 검증 단언은 전부 그대로 초록):
1. 상류에 지터 범위 성격 확인
2. `config/schema.ts` — `UPSTREAM_SWEEP_MAX_JITTER_MIN` · `UPSTREAM_SWEEP_TICK_MIN` 신설,
   파생식 재작성, `UPSTREAM_FOLLOWER_CACHE_MIN` 주석의 "피연산자" 문장 제거,
   superRefine ③ 메시지 문자열 갱신
3. `test/unit/config-loader.test.ts:251` — 유도 관계 미러링 갱신
4. 전체 테스트 재실행

**★ S1-J 와 묶는 것을 검토할 것.** `schema.ts:58` 이 적어 둔 대로 `staleAfterMin=150` 자체가
실측이 아니라 소스 상수 추론이고, S1-J(실배포 `cached_at` 나이 분포 실측)가 그 값을 확정한다.
다만 값 조정과 파생식 정정을 한 번에 하면 어느 쪽이 무엇을 바꿨는지 분리가 어려워지므로,
**파생식 정정을 먼저 따로 하는 편**이 검토가 쉽다.

**참고 — 현재 실제 여유** (상류 확인값, 2026-09-07):

| 채널 | 지터 | 실제 최악 나이 | `staleAfterMin`(150) 대비 여유 |
|---|---|---|---|
| 시스네 | 2.6분 | 72.6분 | 77.4분 |
| 아이곰 | 45.9분 | **115.9분** | **34.1분** ← 생각보다 빠듯하다 |

### 8-d. ★ 라이브 공지에 그림이 없을 때

> 상류 코드 확인: 2026-09-09

방송 공지 임베드의 그림은 chzzkbot 이 `liveImageUrl`(방송 썸네일) · `channelImageUrl`(채널
프로필) 두 칸으로 보내 준다. **우리는 썸네일 → 프로필 순으로 하나만 고르고, 쓸 것이 없으면
그림 칸 자체를 뺀다.** 상류는 방송을 인식할 때 딱 한 번만 훑으므로 **나중에 채워지지 않는다** —
"썸네일 생기면 다시 그리기" 는 만들지 않았고, 만들어서도 안 된다.

공지를 낼 때마다 로그 한 줄이 남는다. **웹훅·폴링·기동복구 세 경로 모두** 이 줄을 남기므로
감지 경로를 먼저 가릴 필요가 없다:

```bash
journalctl --user -u cisnesdiscord -n 500 | grep '방송 공지 그림'
```

```
방송 공지 그림  liveHash=df09256e detectedVia=webhook image=live
방송 공지 그림  liveHash=a1b2c3d4 detectedVia=api-poll image=channel imageDropped=["liveImageUrl"]
```

**칸이 둘이고, 서로 다른 질문에 답한다.**

`image` — **무엇을 실었나**

| 값 | 뜻 |
|---|---|
| `live` | 썸네일을 실었다 |
| `channel` | 썸네일이 없어 프로필로 내려갔다. 방송 시작 직후엔 흔하다 |
| `none` | 실을 것이 없어 그림 칸을 뺐다 |
| `unavailable` | **아웃박스 재발송이다.** 그림 주소를 저장하지 않으므로(§8-a) 재조립할 재료가 없다. 정상이고 조치 대상이 아니다 |

`imageDropped` — **무엇을 버렸나** (버린 것이 없으면 이 칸은 아예 안 나온다)

> ★★ **이 칸이 보이면 그것만으로 우리 쪽을 뒤질 이유다.** `image` 값이 무엇이든 상관없다 —
> 오히려 `image=channel` 과 함께 나오는 것이 가장 흔한 모양이다(썸네일이 못 쓸 값이고
> 프로필이 받아 준 경우). 공지는 멀쩡해 보이지만 치지직 형식이 우리가 아는 모양이 아니라는
> 뜻이고, **그 기록은 여기에만 남는다** — 상류는 `{` 만 보므로 이 값은 상류 로그를
> 통과한 것이다.

**조치:** 로그의 `imageDropped` 가 가리키는 칸의 원문 주소를 상류(`bbearDev/chzzkbot`)에
전달한다. 상류가 파싱·프로토콜 검사를 가드에 더할지 판단할 근거가 된다.

#### `image=none` 이 계속 나올 때

방송이 한참 진행 중인데 `none` 이고 `imageDropped` 도 없다면, 키가 아예 오지 않은 것이다.
여기서 두 경우가 갈리는데 **우리 쪽에서는 구분할 수 없다**:

- **(a)** 치지직이 애초에 안 줬다 — 정상이고 방송 시작 직후에 흔하다
- **(b)** 치지직이 줬는데 **상류 가드가 버렸다** — 치지직이 `{type}` 이 아닌 **새로운 형식의
  자리표시자**를 쓰기 시작했다는 뜻이다. 알아야 하는 사고다

> ★ 평범한 `{type}` 틀은 (b) 가 아니다. 상류가 `720` 으로 **채워서** 완성된 주소로 보낸다.
> 상류 가드가 실제로 버리는 것은 채우고도 `{` 가 남은 경우뿐이다.

구분은 chzzkbot 로그에만 남는다:

```bash
ssh cubeat 'cd ~/git/chzzkbot && grep -h "이미지 주소를 완성하지 못했습니다" data/logs/bot.*.log | tail'
```

그 줄에 `field`(어느 칸인지)와 `raw`(치지직이 준 원문)가 함께 찍힌다.

> ★ **그림이 빠져도 공지는 반드시 나간다.** `image.url` 이 URL 로 안 읽히면 디스코드는
> 임베드 하나가 아니라 **요청 전체를 400 으로 거절한다.** 그래서 검사를 페이로드 스키마가
> 아니라 임베드를 만드는 자리에 뒀다 — 스키마에서 400 으로 튕기면 그 웹훅이 유실되고,
> 그림 한 장 때문에 **방송 공지가 통째로 사라진다**(§3-a 2위).

## 9. 백업

```bash
sqlite3 data/cisnes.db ".backup 'backup/cisnes-$(date +%F).db'"
```
`.env` 는 **백업에 포함하지 않는다**(시크릿). 분실 시 재발급 절차는 `docs/s0-prerequisites.md`.
