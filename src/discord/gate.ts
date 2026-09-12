import { toDiscordSendError, type SendOptions } from './client.js';

/**
 * 게이트 적용 — 역할 부여 + 닉네임 변경 (AC-6 · AC-11 · AC-12).
 *
 * ★★ **두 동작은 각각 독립된 try 안에 있다** (계획 §S4).
 *   이유는 AC-11 하나로 충분하다: *"`setNickname` 실패 시 **인증 성공 처리** + 기록"*.
 *   같은 try 에 두면 닉네임 변경 한 번의 403(상위 역할 멤버는 봇이 닉네임을 못 바꾼다)이
 *   **역할까지 되돌린다** — 이미 이룬 것을 정리 실패로 취소하는 것이 더 나쁘다(§3-a).
 *
 * ★ 닉네임은 역할이 실패해도 **시도한다.** 두 동작을 순서 의존으로 묶으면
 *   "어느 쪽이 먼저 실패했는가" 가 재시도 경로의 분기가 되고, 그 분기가
 *   AC-11 이 없애려던 결합을 다시 만든다.
 *
 * ★ **역할은 `cache.has` 로 먼저 본다** (AC-12 c). 같은 사람이 인증 버튼을 5번 눌러도
 *   REST 호출이 5번 나가면 안 된다 — 429 를 스스로 부르는 짓이다.
 *   캐시가 답을 모르면(`undefined`) 그때만 REST 를 부른다. 부여는 멱등이라
 *   중복 호출이 오류가 되지는 않지만, **오류가 안 난다는 것이 불러도 된다는 뜻은 아니다.**
 */

/**
 * 게이트가 쓰는 만큼의 디스코드 표면.
 *
 * ★ `DiscordGateway` 전체를 요구하지 않는다. 여기서 쓰는 것은 둘(+캐시 조회)뿐이고,
 *   표면을 좁혀야 테스트가 가짜를 세 줄로 만든다.
 */
export interface GateGateway {
  addRole(guildId: string, userId: string, roleId: string, opts?: SendOptions): Promise<void>;
  setNickname(
    guildId: string,
    userId: string,
    nickname: string | null,
    opts?: SendOptions,
  ): Promise<void>;
  /**
   * 캐시 선확인 (AC-12 c). **모르면 `undefined`** — 그때만 REST 를 부른다.
   *
   * `discord.js` 의 `guild.members.cache.get(id)?.roles.cache.has(roleId)` 가
   * 이 자리에 온다. 캐시에 멤버가 없으면 `false` 가 아니라 `undefined` 여야 한다 —
   * `false` 로 접으면 "캐시에 없다" 가 "역할이 없다" 로 읽혀 매번 REST 를 부른다.
   */
  hasRole?(guildId: string, userId: string, roleId: string): boolean | undefined;
}

export type GatePart = 'role' | 'nickname';

export interface GateFailure {
  part: GatePart;
  /** `toDiscordSendError` 분류. `forbidden` 이면 재시도해도 안 풀린다 */
  kind: string;
  detail: string;
}

export interface GateOutcome {
  /** 역할이 붙어 있는가. 이미 갖고 있었어도 `true` */
  roleGranted: boolean;
  /** REST 를 부르지 않고 캐시로 끝났는가 (AC-12 c) */
  roleAlreadyHeld: boolean;
  /** 닉네임을 실제로 바꿨는가. 요청하지 않았으면 `false` */
  nicknameApplied: boolean;
  /**
   * ★★ **AC-11 — 인증 성공 여부는 역할만으로 정해진다.**
   *   닉네임 실패는 여기에 영향을 주지 않고 `failures` 에만 남는다.
   */
  verified: boolean;
  failures: GateFailure[];
}

export interface ApplyGateInput {
  guildId: string;
  userId: string;
  roleId: string;
  /**
   * 바꿀 닉네임. `undefined` 면 **건드리지 않는다**.
   *
   * ★ 가정 6 — 치지직 닉네임이 바뀌어도 재동기화 잡을 만들지 않는다.
   *   여기서 한 번 맞추고 끝이다.
   */
  nickname?: string | null | undefined;
}

/** 디스코드 닉네임 상한. 넘겨 보내면 400 이 난다 */
export const MAX_NICKNAME_LENGTH = 32;

export function clampNickname(value: string): string {
  return value.length <= MAX_NICKNAME_LENGTH ? value : value.slice(0, MAX_NICKNAME_LENGTH);
}

export async function applyGate(
  gw: GateGateway,
  input: ApplyGateInput,
  opts?: SendOptions,
): Promise<GateOutcome> {
  const failures: GateFailure[] = [];
  let roleGranted = false;
  let roleAlreadyHeld = false;
  let nicknameApplied = false;

  // ── ① 역할 (독립 try) ──────────────────────────────────────────
  try {
    const cached = gw.hasRole?.(input.guildId, input.userId, input.roleId);
    if (cached === true) {
      roleGranted = true;
      roleAlreadyHeld = true;
    } else {
      await gw.addRole(input.guildId, input.userId, input.roleId, opts);
      roleGranted = true;
    }
  } catch (e: unknown) {
    const err = toDiscordSendError(e);
    failures.push({ part: 'role', kind: err.kind, detail: err.message });
  }

  // ── ② 닉네임 (독립 try) — ★ 실패해도 인증은 성공이다 (AC-11) ──
  if (input.nickname !== undefined) {
    try {
      const next = input.nickname === null ? null : clampNickname(input.nickname);
      await gw.setNickname(input.guildId, input.userId, next, opts);
      nicknameApplied = true;
    } catch (e: unknown) {
      const err = toDiscordSendError(e);
      failures.push({ part: 'nickname', kind: err.kind, detail: err.message });
    }
  }

  return { roleGranted, roleAlreadyHeld, nicknameApplied, verified: roleGranted, failures };
}
