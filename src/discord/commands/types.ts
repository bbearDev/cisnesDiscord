/**
 * 슬래시 명령의 공통 모양 (계획 §S4).
 *
 * ★ `discord.js` 의 `ChatInputCommandInteraction` 을 그대로 받지 않는다.
 *   그 타입을 요구하면 명령 한 줄을 테스트하려고 상호작용 객체 전체를 흉내 내야 하고,
 *   그러면 `/인증` 의 판정(이미 연동됨 / 진행 중 / 쿨다운)이 **테스트되지 않는 자리**가
 *   된다. 여기 넷(길드·유저·운영자 여부·대상)이면 판정에 필요한 전부다.
 *   상호작용에서 이 넷을 뽑는 것은 조립부(US-007)의 일이다.
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
  /** `/연동해제` 의 대상 멤버 */
  targetUserId?: string | undefined;
}

export interface CommandReply {
  content: string;
  /**
   * ★ 항상 `true`.
   *
   *   `/인증` 응답에는 **그 사람 전용 인증 URL** 이 실린다. 공개로 나가면
   *   다른 사람이 그 URL 로 인증을 완료해 **그 사람의 치지직 계정이 최초 요청자의
   *   디스코드 계정에 연동**된다. 연동 상태·거부 사유도 개인정보라 같이 가린다.
   */
  ephemeral: true;
}

/** 디스코드 명령 옵션 타입 중 우리가 쓰는 것 (`USER` = 6) */
export const OPTION_TYPE_USER = 6;

export interface CommandOptionDefinition {
  type: number;
  name: string;
  description: string;
  required: boolean;
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

export interface SlashCommand {
  readonly definition: CommandDefinition;
  /** **절대 던지지 않는다.** 던지면 사용자는 "애플리케이션이 응답하지 않음" 만 본다 */
  execute(ctx: CommandContext): Promise<CommandReply>;
}
