// 출처: chzzkbot src/chzzk/api/user-api.ts — 경로·스키마·"토큰 주인" 해석을 그대로 옮겼다
//       (계획 §14 · Principle 5). 전송만 우리 `http-budget` 으로 바꿨다.
import { z } from 'zod';

import type { HttpBudget } from '../../runtime/http-budget.js';
import { unwrapEnvelope, type ApiResult } from './envelope.js';

/**
 * 유저 API — `GET /open/v1/users/me`.
 *
 * ★ **이 응답은 "앱" 이 아니라 "토큰 주인" 이다** (상류 ADR-003, 실측 2026-08-28).
 *   우리 구성에서 토큰 주인은 **`/인증` 을 누른 시청자**이므로 여기서 오는
 *   `channelId` 가 곧 그 사람의 치지직 채널이다. 팔로워 판정(§5.2)과
 *   `account_links.chzzk_channel_id` 가 전부 이 값 위에 선다.
 *
 * ★ 이 호출의 access token 은 **호출 인자로만 존재한다.** 모듈이 보관하지 않고
 *   DB 에도 가지 않는다 (AC-10) — `oauth/viewer-token.ts` 머리말 참조.
 */

export const USERS_ME_PATH = '/open/v1/users/me';

export const UserMe = z.object({
  channelId: z.string().min(1),
  /**
   * ★ 선택으로 둔다. 상류 스키마는 필수지만, 상류 자신의 콜백 구현
   *   (`web/oauth-callback.ts` 의 `whoAmI`)은 없을 때 `channelId` 로 대체한다.
   *   **표시용 문자열 하나 때문에 인증을 통째로 실패시키는 것은 §3-a 로 손해다**
   *   — 그건 "안 보내기"(2위)이고, 대체 표기는 "늦게"(1위)조차 아닌 무손실이다.
   */
  channelName: z.string().min(1).optional(),
  /** 실측에서 관측됐으나 공식 문서에는 없다 */
  nickname: z.string().optional(),
});
export type UserMe = z.infer<typeof UserMe>;

export interface FetchUserMeInput {
  budget: HttpBudget;
  /** 치지직 오픈 API 기준 주소 */
  baseUrl: string;
  /** ★ 인자로만 흐른다. 어디에도 보관하지 않는다 (AC-10) */
  accessToken: string;
  /** 인증 왕복 10초 예산의 마감 시각 (§5.6.1) */
  deadlineAt?: number | undefined;
}

export async function fetchUserMe(input: FetchUserMeInput): Promise<ApiResult<UserMe>> {
  const res = await input.budget.request('users-me', `${input.baseUrl}${USERS_ME_PATH}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      Accept: 'application/json',
    },
    ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
  });
  return unwrapEnvelope(res, UserMe);
}

/** 표시용 이름. 없으면 채널 id 를 그대로 쓴다 (위 스키마 주석의 대체 규칙) */
export function displayNameOf(me: UserMe): string {
  return me.channelName ?? me.channelId;
}
