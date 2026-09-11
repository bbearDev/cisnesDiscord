import type { ActionRow } from '../client.js';

/**
 * 명령의 공통 모양 (계획 §S4 · `docs/spec-auth-panel.md`).
 *
 * ★ `discord.js` 의 `Interaction` 을 그대로 받지 않는다.
 *   그 타입을 요구하면 명령 한 줄을 테스트하려고 상호작용 객체 전체를 흉내 내야 하고,
 *   그러면 `인증` 의 판정(이미 연동됨 / 진행 중 / 쿨다운)이 **테스트되지 않는 자리**가
 *   된다. 여기 다섯(길드·유저·운영자 여부·대상 멤버·대상 채널)이면 판정에 필요한 전부다.
 *   상호작용에서 이것을 뽑는 것은 조립부(US-007)의 일이다.
 *
 * ★ **진입 수단이 둘이다.** 사용자용(`인증`·`연동상태` 본인)은 게이트 채널 패널의
 *   **버튼**으로, 운영자용(`/연동해제`·`/연동상태 대상`)은 **슬래시 명령**으로 들어온다.
 *   둘 다 같은 `CommandContext` 로 접혀 같은 `execute()` 를 타므로 명령 본체는
 *   자기가 어느 쪽으로 불렸는지 모른다 — 그래서 한 벌이다.
 */

export interface CommandContext {
  guildId: string;
  userId: string;
  /**
   * 호출자가 `Manage Guild` 를 갖는가.
   *
   * ★ 정의의 `default_member_permissions` 와 **두 겹**이다. 그쪽은 디스코드가
   *   명령을 아예 안 보여주는 것이고 이쪽은 우리가 거부하는 것이다.
   *   디스코드 쪽 설정은 서버 관리자가 UI 에서 덮어쓸 수 있으므로
   *   **표시 제어를 권한 검사로 쓰면 안 된다.**
   */
  isOperator?: boolean | undefined;
  /** `/연동해제` · `/연동상태` 의 대상 멤버 */
  targetUserId?: string | undefined;
  /** `/인증채널` 의 대상 채널 */
  targetChannelId?: string | undefined;
}

export interface CommandReply {
  content: string;
  /**
   * 답장에 붙일 버튼 행. `인증` 은 여기에 **본인 전용 링크 버튼**을 싣는다.
   *
   * ★ 링크를 본문이 아니라 버튼에 싣는 이유: 본문 URL 은 디스코드가 미리보기를
   *   만들려고 **직접 가져간다**(`Discordbot/2.0`). 그 크롤러가 `/oauth/start` 를
   *   열면 nonce 가 회전돼 사용자의 쿠키가 무효가 된다 — 실배포에서 관측됐다
   *   (2026-09-08). 링크 버튼의 URL 은 크롤링 대상이 아니다.
   */
  components?: ActionRow[];
  /**
   * ★ 항상 `true`.
   *
   *   `인증` 응답에는 **그 사람 전용 인증 URL** 이 실린다. 공개로 나가면
   *   다른 사람이 그 URL 로 인증을 완료해 **그 사람의 치지직 계정이 최초 요청자의
   *   디스코드 계정에 연동**된다. 연동 상태·거부 사유도 개인정보라 같이 가린다.
   */
  ephemeral: true;
}

/** 디스코드 명령 옵션 타입 중 우리가 쓰는 것 (`USER` = 6 · `CHANNEL` = 7) */
export const OPTION_TYPE_USER = 6;
export const OPTION_TYPE_CHANNEL = 7;
/** 채널 옵션이 받을 채널 종류 — `GUILD_TEXT` = 0. 패널은 텍스트 채널에만 놓인다 */
export const CHANNEL_TYPE_GUILD_TEXT = 0;

export interface CommandOptionDefinition {
  type: number;
  name: string;
  description: string;
  required: boolean;
  /** `CHANNEL` 옵션에서 고를 수 있는 채널 종류. 디스코드가 선택 UI 에서 걸러 준다 */
  channel_types?: number[];
}

/**
 * 등록용 명령 정의 — `PUT /applications/{id}/guilds/{gid}/commands` 본문 모양.
 *
 * ★ `SlashCommandBuilder` 를 쓰지 않는다. 빌더는 등록 시점에만 값이 있고
 *   테스트가 비교할 수 있는 것은 결국 이 JSON 이다. 중간 표현을 하나 줄인다.
 */
export interface CommandDefinition {
  name: string;
  description: string;
  /** 길드 전용. DM 에는 길드·역할이 없다 */
  dm_permission: false;
  /** 비트 문자열. 없으면 전원 실행 가능 */
  default_member_permissions?: string;
  options?: CommandOptionDefinition[];
}

/**
 * 명령 본체. 버튼이든 슬래시든 결국 이것을 탄다.
 *
 * ★ `definition` 이 없다. 버튼으로만 들어오는 명령(`인증`)은 디스코드에 등록할
 *   정의가 **없어야 한다** — 있으면 등록 목록에 실수로 끼어 슬래시가 되살아난다.
 */
export interface Command {
  /** **절대 던지지 않는다.** 던지면 사용자는 "애플리케이션이 응답하지 않음" 만 본다 */
  execute(ctx: CommandContext): Promise<CommandReply>;
  /**
   * 응답 전에 디스코드 REST 를 부르는 명령은 `true` 로 둔다.
   *
   * ★ 상호작용은 **3초 안에** 첫 응답이 가야 한다. DB 만 만지는 명령은 그 안에 끝나지만
   *   `/인증채널` 은 패널을 **게시하고 나서** 결과를 답하므로 발송 타임아웃(5초)이
   *   그 창을 넘을 수 있다. 조립부가 이 값을 보고 먼저 "생각 중" 을 보낸 뒤 고쳐 쓴다.
   */
  readonly defer?: boolean;
}

/** 슬래시로 **등록되는** 명령 — 운영자용만 여기 온다 */
export interface SlashCommand extends Command {
  readonly definition: CommandDefinition;
}
