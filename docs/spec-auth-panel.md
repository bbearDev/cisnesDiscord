# 명세 — 사용자용 인증 진입점을 슬래시 명령에서 **패널(임베드 + 버튼)** 로 바꾼다

상태: **구현됨 (2026-09-12)** · 대상: `/인증` · `/연동상태`(본인 조회) · 근거 리뷰: 2026-09-12 인증 경로 점검

> 구현 시 확정된 것 — §7 의 결정 4개는 전부 권장안으로. 추가로 **[치지직 계정 인증] 버튼은 초록(Success)**,
> 운영자용 **`/인증채널`** 명령(게이트 채널 지정 + 즉시 게시)이 들어갔다 (D-7 · §9).

---

## 0. 한 줄 요약

게이트 채널에 봇이 **패널 메시지 하나**(임베드 + 버튼 2개)를 유지한다. 멤버는 슬래시 명령 대신
버튼을 누르고, 인증 링크는 본문 URL 이 아니라 **Link 버튼**으로 받는다.
운영자용 `/연동해제` · `/연동상태 <대상>` 은 슬래시 명령으로 남는다.
**OAuth 흐름(`/oauth/start` → 치지직 → `/oauth/callback`)·세션·리밋·판정은 한 줄도 바뀌지 않는다.**

```
  [게이트 채널]                           [ephemeral 답장 — 본인만 봄]
  ┌─────────────────────────────┐         ┌──────────────────────────────┐
  │ 📌 치지직 팔로워 인증        │  클릭   │ 치지직 계정 연동을 시작합니다  │
  │  1. 아래 버튼을 누릅니다      │ ──────▶ │ (약 10분간 유효)               │
  │  2. 치지직 로그인·동의        │         │ [🔗 치지직에서 인증 진행]      │  ──▶ /oauth/start?s=…
  │  3. 역할 자동 부여            │         └──────────────────────────────┘        (기존 흐름 그대로)
  │ [치지직 계정 인증]🟢 [내 연동 상태] │
  └─────────────────────────────┘
```

---

## 1. 범위

| 포함 | 제외 (변경 없음) |
|---|---|
| 패널 게시·갱신·재게시 (`ensureAuthPanel`) | `web/session.ts` · `web/routes/oauth-callback.ts` · `chzzk/**` |
| 버튼 상호작용 라우팅 (`custom_id` → 핸들러) | `discord/commands/guard.ts` (쿨다운·동시 상한 그대로 적용) |
| `/인증` 답장을 Link 버튼으로 | `discord/gate.ts` · `store/**` · DB 스키마 (**마이그레이션 없음**) |
| `/인증` 슬래시 **등록 제거** | `/연동해제` 슬래시 (정의·로직 그대로) |
| `/연동상태` 슬래시를 **운영자 전용 표시**로 (결정 1) | 판정 순서 AC-12 (이미 연동 → 진행 중 → 리밋 → 발급) |
| `DiscordGateway` 에 `editMessage` 추가 + `SendPayload.components` | 인텐트 (`Guilds`·`GuildMembers`·`GuildMessages` 그대로) |

---

## 2. 사용자 시나리오

| # | 행위 | 결과 |
|---|---|---|
| U-1 | 멤버가 패널의 **[치지직 계정 인증]** 클릭 | ephemeral 답장: 안내 + **[치지직에서 인증 진행]** Link 버튼 (`/oauth/start?s=<state>`). 판정은 `link.ts` 그대로 — 이미 연동 / 진행 중(같은 링크 재제시) / 쿨다운·혼잡 / 발급 |
| U-2 | Link 버튼 클릭 → 치지직 동의 → 콜백 | **기존과 동일.** 브라우저 결과 페이지, 역할·닉네임 |
| U-3 | 멤버가 **[내 연동 상태]** 클릭 | ephemeral 답장: `status.ts` 의 본인 조회 (연동 채널명·시각 / 미연동 안내) |
| U-4 | 운영자가 `/연동해제 대상:@멤버` | 기존과 동일 |
| U-5 | 운영자가 `/연동상태 대상:@멤버` | 기존과 동일. 일반 멤버에게는 명령이 **표시되지 않는다** (결정 1) |
| U-6 | DM 에서 버튼이 눌리는 경우 | 발생하지 않는다 (패널은 길드 채널에만 있다). 방어적으로 `guildId === null` 이면 슬래시와 같은 거부 문구 |
| U-7 | 봇 재기동 | 패널은 **그 자리 그대로**. 문안이 바뀌었으면 기동 시 PATCH 로 동기화 (결정 3) |
| U-8 | 누군가 패널 메시지를 지움 | 다음 기동 때 PATCH 가 404 → **새로 게시**. 즉시 복구가 필요하면 재기동 |

---

## 3. 설계

### D-1 패널 정의 — `src/discord/panel.ts` (신규)

```ts
export const AUTH_PANEL_BUTTON_LINK   = 'cisnes:auth:link';    // [치지직 계정 인증]
export const AUTH_PANEL_BUTTON_STATUS = 'cisnes:auth:status';  // [내 연동 상태]
export const AUTH_PANEL_STATE_KEY     = 'auth_panel';          // runtime_state 키

export function buildAuthPanel(): SendPayload   // 순수 함수. embeds 1 + components 1행
```

- **빌더(`ButtonBuilder`)를 쓰지 않는다.** `commands/types.ts` 가 `SlashCommandBuilder` 를 거부한 것과 같은 이유 —
  테스트가 비교할 수 있는 것은 결국 API JSON 이다. `type`/`style` 은 `discord.js` 의 `ComponentType`·`ButtonStyle` enum 리터럴로
  박아 `interaction.reply()` 의 타입에 그대로 맞는다 (ActionRow=`1`, Button=`2`, Success=`3` · Secondary=`2` · Link=`5`).
- `custom_id` 에 `cisnes:` 접두를 둔다. 같은 서버의 다른 봇 버튼과 겹치지 않게 하고, 앞으로 버튼이 늘어도
  라우팅이 접두 하나로 갈린다 (상한 100자).
- 임베드 문안 (§6). 색은 `AUTH_PANEL_COLOR = 0x00ffa3`(치지직 그린), 푸터 없음.

### D-2 패널 수명주기 — `ensureAuthPanel()` (같은 파일)

```
입력: gateChannelId (guild_config.gate_channel_id) · runtime_state · gateway(send, editMessage) · timeoutMs
① gate 채널 없음                → 'skipped:no-gate-channel'. 호출 0회. error 로그
② state = runtime_state[auth_panel] (JSON {channelId, messageId})
③ state 있음 && channelId 같음  → editMessage(PATCH)
      성공                      → 'updated'
      404 (Unknown Message)     → ④ 로
      그 외 실패(429·5xx·timeout) → 'skipped:edit-failed'. state 유지. warn 로그 (다음 기동에 재시도)
④ state 없음 | 404 | 채널 변경   → send(POST) → runtime_state[auth_panel] = {channelId, messageId} → 'posted'
      실패                      → 'skipped:send-failed'. error 로그 (timeout 이면 detail 이 "올라갔을 수 있다" 를 말한다)
      기록 실패                  → 그래도 'posted' (패널은 올라갔다). 로그만
⑤ state 읽기 실패              → 'skipped:state-unreadable'. 호출 0회 — 모르는 채 올리면 둘이 된다
```

- `ensure()` 는 **직렬화**된다 — 기동 중 `/인증채널`, 운영자 더블클릭이 겹쳐도 POST 는 한 번이다.

- **호출 시점: `app.start()` 안**, 폴러들 뒤·기동 로그 앞. `gateway.login()`(부트스트랩)은 이미 끝났고, REST 는 게이트웨이
  준비 여부와 무관하다. `ClientReady` 훅에 두지 않는 이유: 하니스(가짜 게이트웨이)에서는 그 이벤트가 없어
  **e2e 가 패널 경로를 못 탄다.**
- **재기동마다 PATCH 한다** (결정 3). 문안을 고치고 배포하면 패널이 따라온다. 비용은 기동당 REST 1회.
- 채널이 바뀌었을 때 **옛 패널은 지우지 않는다** (결정 2). 버튼은 `custom_id` 로 전역 라우팅되므로 옛 패널도
  계속 동작한다 — 해롭지 않고, 지우는 것은 운영자의 일이다. 게이트웨이 표면을 `deleteMessage` 만큼 넓히지 않는다.
- **실패해도 기동은 막지 않는다** (Principle 2). 대신 결과를 **기동 로그 `'기동을 마쳤습니다'` 에
  `authPanel: 'posted' | 'updated' | 'skipped:<reason>'` 필드로 찍는다** — 런북 §2-5 가 이 값을 본다.
  ★ `/인증` 슬래시가 사라지므로 **패널이 없으면 인증 진입점이 0개**다. 그래서 `skipped:*` 는 warn 이 아니라 **error** 다.
- 타임아웃: `announcer.ts` `sendOnce` 와 같은 `AbortController` + `setTimeout` + `finally clearTimeout` 패턴. 5초.

### D-3 게이트웨이 표면 — `src/discord/client.ts`

```ts
export interface LinkButton   { type: ComponentType.Button; style: ButtonStyle.Link; label: string; url: string }
export interface ActionButton { type: ComponentType.Button; style: Primary | Secondary | Success | Danger; label: string; custom_id: string }
export interface ActionRow    { type: ComponentType.ActionRow; components: (LinkButton | ActionButton)[] }

export interface SendPayload { content?: string; embeds?: AnnouncementEmbed[]; components?: ActionRow[] }

interface DiscordGateway {
  …
  editMessage(channelId: string, messageId: string, payload: SendPayload, opts?: SendOptions): Promise<void>;
}
```

- `editMessage` = `client.rest.patch(Routes.channelMessage(channelId, messageId), { body, signal })`, 예외는 기존
  `call()` 로 `DiscordSendError` 로 접는다. **`DiscordFailureKind` 에 `not-found` 를 추가하지 않는다** —
  그 어휘는 `discord_send_failures{kind}` 지표 라벨이다. 404 는 `err.status === 404` 로 본다 (이미 실려 있다).
- 하니스 `test/e2e/harness/fake-discord.ts`: `editMessage` 구현 + `edited: EditRecord[]` 기록 + 404 를 흉내 내는
  `forgetMessage(messageId)`.

### D-4 상호작용 라우팅 — `src/main.ts` `onInteraction`

```ts
if (interaction.isButton()) {
  if (interaction.guildId === null) { …DM 거부 (슬래시와 같은 문구)… }
  const reply = await dispatchButton(interaction.customId, {
    guildId: interaction.guildId,
    userId: interaction.user.id,
    isOperator: interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
    targetUserId: undefined,
  });
  await interaction.reply({ content: reply.content, components: reply.components, flags: MessageFlags.Ephemeral });
  return;
}
```

- `buttons: Map<customId, Command>` — `AUTH_PANEL_BUTTON_LINK → linkCommand`, `AUTH_PANEL_BUTTON_STATUS → statusCommand`.
- 모르는 `custom_id` 는 **반드시 응답한다** (ephemeral "알 수 없는 버튼입니다"). 버튼 상호작용은 **우리 앱이 보낸
  메시지의 것만** 우리에게 오므로, 모르는 id 는 다른 봇이 아니라 **옛 버전 패널**의 버튼이다. 응답하지 않으면
  사용자는 "상호작용 실패" 만 본다 — `dispatchCommand` 의 '알 수 없는 명령입니다' 와 같은 규율.
- `dispatchCommand` 와 같은 모양의 `dispatchButton` 을 `App` 에 노출한다 (테스트 주입점).
- 버튼도 **3초 응답 제한**이 같다. 상태 조회는 DB 만 만진다. 인증 버튼은 상류(치지직) 호출이 0 이지만
  **역할 재부여(결정 4)는 디스코드 REST 1회**를 부르므로 `REGRANT_TIMEOUT_MS`(2.5초) 로 끊는다 — 넘기면
  `timeout` 실패로 접혀 안내가 제때 나간다. 슬래시 쪽은 `Command.defer === true` 인 명령(`/인증채널`)만
  `deferReply` → `editReply` 로 간다. 상호작용 접기는 `discord/interactions.ts` 가 하고 단위 테스트가 잡는다.

### D-5 `/인증` 답장 — `commands/link.ts` · `commands/types.ts`

```ts
export interface Command { execute(ctx: CommandContext): Promise<CommandReply>; readonly defer?: boolean }
export interface SlashCommand extends Command { readonly definition: CommandDefinition }
export interface CommandReply { content: string; ephemeral: true; components?: ActionRow[] }
export interface CommandContext { …; targetChannelId?: string }   // `/인증채널` 의 대상
```

- `createLinkCommand` 는 **`Command`** 를 돌려준다. `LINK_COMMAND` 정의·`LINK_COMMAND_NAME` 은 삭제한다
  (죽은 정의를 남기면 누군가 다시 등록한다). 이미 연동됐는데 역할이 없으면 게이트만 다시 적용한다 (결정 4).
- `startReply`: 본문에서 URL 줄을 **빼고**, `components` 에 Link 버튼 `{ type:2, style:5, label:'치지직에서 인증 진행', url }` 하나.
  `buildStartUrl` 은 그대로.
- **`<>` 규율은 "본문에 URL 을 싣지 않는다" 로 대체된다.** 컴포넌트 URL 은 미리보기 크롤링 대상이 아니다 —
  2026-09-08 관측한 `Discordbot/2.0` 의 `/oauth/start` 선점 문제가 구조적으로 사라진다.
  기존 테스트 `★ 인증 링크는 <> 로 감싸 나간다` → `★ 인증 링크는 본문이 아니라 Link 버튼으로만 나간다 (content 에 URL 0건)`.

### D-6 슬래시 명령 목록

| 명령 | 전 | 후 |
|---|---|---|
| `/인증` | 등록 | **등록 제거.** `PUT applicationGuildCommands` 가 전체 교체라 다음 기동에 디스코드에서 사라진다 |
| `/연동상태` | 전원 표시 | `default_member_permissions: ManageGuild` 추가 → **운영자에게만 표시** (결정 1). `status.ts` 로직은 그대로 — 본인 조회 경로를 버튼이 쓴다 |
| `/연동해제` | 운영자 | 변경 없음 |
| `/인증채널 채널:#…` | (없음) | **신설.** 운영자 전용. `guild_config.gate_channel_id` 를 저장하고 **그 자리에서** 패널을 게시한다. `defer: true` (게시 REST 가 3초 창을 넘길 수 있다) |

기동 로그 `'슬래시 명령을 등록했습니다'` 의 `count` 는 3 그대로 (`인증` 빠지고 `인증채널` 들어옴), `names` 필드가 추가된다.

### D-7 설정·운영 전제

- **`guild_config.gate_channel_id` 가 채워져 있어야 한다.** 컬럼은 이미 있다 (`001_init.sql:28`). 채우는 길이 둘:
  런북 §1-2-a 의 sqlite3 시딩, 또는 디스코드 안에서 **`/인증채널 채널:#게이트`** (운영자 전용 — 저장 + 즉시 게시,
  결과를 답장에 싣는다. 채널을 옮기면 옛 패널을 지우지 않았다는 사실을 답장이 말한다).
- 봇 권한: 게이트 채널에서 `View Channel` · `Send Messages` · `Embed Links` (S0-7 에 이미 있음). **추가 인텐트 없음.**
- 패널을 강제로 다시 만들려면: 메시지 삭제 → 재기동 (404 → 재게시). 또는
  `sqlite3 data/cisnes.db "DELETE FROM runtime_state WHERE key='auth_panel'"` → 재기동.

### D-8 관측

| 로그 | 레벨 | 필드 |
|---|---|---|
| `인증 패널 게시` | info | channelId, messageId |
| `인증 패널 갱신` | info | channelId, messageId |
| `인증 패널 게시 실패` / `갱신 실패` | **error** / warn | detail (status·kind) |
| `기동을 마쳤습니다` | info | **`authPanel`** 필드 추가 |

지표는 늘리지 않는다. 진입 거절은 `auth_flow_rejected{reason}`, 흐름 수는 `verification_sessions` 가 이미 센다.

---

## 4. 테스트

| 파일 | 내용 |
|---|---|
| `test/unit/panel.test.ts` (신규) | `buildAuthPanel()` JSON — `custom_id` 둘이 상수와 같다 · style 1/2 · 임베드 1개 · `custom_id ≤ 100자` |
| `test/unit/panel-ensure.test.ts` (신규) | (a) state 없음 → send 1·저장 (b) state 있음 → edit 1·send 0 (c) edit 404 → send 1·state 갱신 (d) edit 5xx → send 0·state 유지 (e) gate 채널 없음 → 호출 0 (f) 채널 변경 → 새 채널에 send·옛 메시지 delete 0 |
| `test/unit/discord-client.test.ts` | `editMessage` 가 PATCH `channelMessage` 를 부른다 · 404 가 `status: 404` 로 실린다 |
| `test/e2e/auth-flow.test.ts` | `runLink` 는 `reply.components` 에서 URL 추출 · `<>` 테스트 교체 · **content 에 `/oauth/start` 0건** · AC-3/7/11/12/AD-2 시나리오는 그대로 통과해야 한다 (흐름 불변의 증거) |
| `test/integration/main-wiring.test.ts` | 등록 명령 2개(`/인증` 없음) · `/연동상태` 정의에 `default_member_permissions` · `dispatchButton` 라우팅(두 버튼 · 모르는 id) · 기동 시 패널 send 1회 / 재기동 시 edit 1회·send 0회 |
| `test/helpers/app-harness.ts` | `seedDb` 가 `gateChannelId` 를 심는다 |

---

## 5. 문서

- `docs/runbook-ops.md` — §1-2 `guild_config` 시딩(`gate_channel_id` 포함) · §2-5 기동 확인에 `authPanel` 값 확인 ·
  §4 에 "패널이 없다 / 버튼이 안 보인다" 항목 · §7 일상 점검에 패널 존재 확인.
- `docs/acceptance-checklist.md` — AC-2 "슬래시 명령" 표현을 "패널 버튼" 으로. AC-12 (b) "같은 URL 재제시" 는 그대로.
- `.omc/plans/cisnes-discord-implementation.md` §S4 — 개정 노트 한 단락 (슬래시 → 패널, 이유: 진입 장벽·크롤러).

---

## 6. 문안 초안

**패널 임베드**
- 제목: `치지직 팔로워 인증`
- 설명:
  ```
  시스네 치지직 채널 팔로워임을 확인하면 인증 역할이 부여됩니다.

  1. 아래 **치지직 계정 인증** 버튼을 누릅니다.
  2. 본인에게만 보이는 답장의 버튼으로 치지직 로그인·동의를 진행합니다.
  3. 팔로워로 확인되면 역할이 자동으로 부여되고, 서버 닉네임이 치지직 채널명으로 맞춰집니다.

  ※ 답장 안의 링크는 **본인 전용**입니다. 다른 사람에게 전달하지 마십시오.
  ※ 방금 팔로우하셨다면 반영까지 최대 10분이 걸릴 수 있습니다.
  ```
- 버튼: `[치지직 계정 인증]` (**Success — 초록**) · `[내 연동 상태]` (Secondary — 회색)

**인증 버튼 ephemeral 답장** (`startReply`)
```
치지직 계정 연동을 시작합니다.                      ← resumed 면 "이미 시작하신 인증이 있습니다. **같은 링크**로 이어서 진행해 주십시오."
아래 버튼을 눌러 치지직 로그인·동의를 진행해 주십시오 (약 N분간 유효).
동의가 끝나면 자동으로 돌아와 팔로워 확인 후 역할이 부여됩니다.

※ 이 버튼의 링크는 **본인 전용**입니다. 다른 사람에게 전달하지 마십시오.
[🔗 치지직에서 인증 진행]
```
그 외 문안(이미 연동·쿨다운·혼잡·상태 조회)은 `messages.ts` 그대로.

---

## 7. 결정 — 전부 권장안으로 확정 (2026-09-12)

| # | 항목 | 권장 | 대안 |
|---|---|---|---|
| 1 | `/연동상태` 슬래시 노출 | **운영자 전용 표시** (`default_member_permissions`) — "사용자용은 버튼" 이 일관된다 | 전원 표시 유지 (버튼과 슬래시 두 진입점) |
| 2 | 게이트 채널 변경 시 옛 패널 | **지우지 않는다** (게이트웨이 표면 최소) | `deleteMessage` 추가해 best-effort 삭제 |
| 3 | 재기동 시 패널 동기화 | **매번 PATCH** (문안이 코드를 따라온다, 기동당 REST 1회) | 존재 확인만(GET) — 문안 변경 시 수동 재게시 |
| 4 | 리뷰 1번(역할 부여 실패 후 재시도 불가) 동반 수정 | **같이 고친다** — 버튼 핸들러가 `link.ts` 를 그대로 쓰므로 "이미 연동 → `applyGate` 재적용(캐시 적중 시 REST 0)" 한 갈래면 "인증 버튼 재클릭 = 역할만 재부여" 가 자연스럽게 성립한다 | 문안만 고치고 별건으로 |

---

## 8. 변경 규모 · 순서 (구현 결과)

```
src/discord/panel.ts           신규   buildAuthPanel · ensureAuthPanel · 상수
src/discord/client.ts          수정   ActionRow 타입 · SendPayload.components · editMessage
src/discord/commands/types.ts  수정   InteractionHandler · CommandReply.components
src/discord/commands/link.ts   수정   InteractionHandler 반환 · Link 버튼 답장 · LINK_COMMAND 삭제
src/discord/commands/status.ts 수정   default_member_permissions (결정 1)
src/discord/commands/gate-channel.ts 신규   /인증채널 (§9)
src/discord/messages.ts        수정   gateFailedMessage 약속을 코드가 지키게 · roleRegranted · unknownButton · /인증 → 버튼 문안
src/main.ts                    수정   buttons 맵 · dispatchButton · isButton 분기 · defer 처리 · start() 에 ensureAuthPanel · 기동 로그 authPanel · 등록 목록
test/e2e/harness/fake-discord.ts  수정   editMessage · edited 기록 · 404 스위치
test/helpers/app-harness.ts       수정   gateChannelId 시딩
test/unit/{panel,panel-ensure,discord-client}.test.ts · test/e2e/auth-flow.test.ts · test/integration/main-wiring.test.ts
docs/runbook-ops.md · docs/acceptance-checklist.md · .omc/plans/… §S4
```

순서: ① `client.ts` 표면 + 하니스 → ② `panel.ts` + 단위 테스트 → ③ `types.ts`/`link.ts`/`status.ts` → ④ `main.ts` 배선 → ⑤ e2e·배선 테스트 갱신 → ⑥ 문서.
배포 1회. **배포 전 필수: `guild_config.gate_channel_id` 설정** (없으면 `/인증` 도 사라진 채 패널도 없다 — 진입점 0).

---

## 9. `/인증채널` — 운영자용 (구현 시 추가)

| 항목 | 값 |
|---|---|
| 정의 | `name: 인증채널` · `default_member_permissions: ManageGuild` · 옵션 `채널`(CHANNEL, 필수, `channel_types: [GUILD_TEXT]`) |
| 동작 | ① 운영자 검사 → ② `guild_config.gate_channel_id` 저장(COALESCE upsert — 다른 컬럼 무변화) → ③ `panel.ensure(채널)` → ④ 결과를 답장에 |
| 답장 | `posted` "…에 게시했습니다" / `updated` "…최신 문안으로 갱신했습니다" / `skipped` "저장했지만 게시하지 못했습니다 (reason — detail)" + 권한 확인 안내. 채널이 바뀌었으면 "이전 채널 <#…> 의 패널은 지우지 않았습니다" |
| `defer` | `true` — 조립부가 `deferReply` 후 `editReply`. 다른 명령은 그대로 `reply` |
| 전제 | `guild_config` 행이 있어야 슬래시가 등록된다 (`ClientReady` 의 `single()`). 첫 행은 런북 §1-2-a 로 심는다 |
