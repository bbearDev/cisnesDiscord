import { UPSTREAM_FOLLOWER_CACHE_MIN } from '../config/schema.js';
import {
  type FollowerLookup,
  type FollowerUnknownReason,
} from '../chzzk/follower-check.js';
import type { GateOutcome } from './gate.js';
import { AUTH_PANEL_LINK_LABEL } from './panel.js';

/**
 * 사람에게 나가는 문안 — **R-4(정직한 안내)** 의 구현체 (계획 §5.2).
 *
 * ★ 여기 한 곳에 모으는 이유. 같은 판정이 **디스코드 답장**(패널 버튼, `/연동상태`)과
 *   **브라우저 콜백 페이지** 두 곳에 나간다. 문안을 두 곳에 적으면 한쪽만 고쳐지고,
 *   그때 갈라지는 것이 하필 *"스냅샷 시각과 다음 재시도 시각을 둘 다 싣는다"*
 *   라는 R-4 요건이다.
 *
 * ★★ **거부 안내에는 스냅샷 시각과 다음 재시도 시각이 반드시 둘 다 들어간다.**
 *   하나만 있으면 사용자는 *"지금 팔로우했는데 왜 안 되지"* 에서 멈춘다.
 *   상류 캐시가 최대 10분 늦다는 사실을 **숨기지 않고 그대로 말한다** —
 *   그게 정직한 안내이고, 숨기면 같은 사람이 5초마다 다시 누른다(그리고 그것이
 *   §5.6.2 가 막아야 할 부하가 된다).
 *
 * ★ **`unknown` 과 `no` 의 문안이 다르다.** `unknown` 은 *"잠시 후 다시"* 이고
 *   `no` 는 *"팔로우한 뒤 다시"* 다. 사용자가 해야 할 일이 다르므로 같은 문장을
 *   쓰면 안 된다 — 문안을 합치는 순간 코드가 아니라 **말이** `unknown` 을 `no` 로 접는다.
 */

const KST_OFFSET_MS = 9 * 3_600_000;

/**
 * `2026-09-06 18:55 KST`.
 *
 * ★ 표기 시간대를 문자열에 박는다. 안 박으면 UTC 로 읽는 사람과 KST 로 읽는 사람이
 *   9시간 다른 결론을 내고, 그 차이가 정확히 "왜 안 되지" 의 원인이 된다.
 */
export function formatKst(ms: number): string {
  const shifted = new Date(ms + KST_OFFSET_MS).toISOString();
  return `${shifted.slice(0, 10)} ${shifted.slice(11, 16)} KST`;
}

/** `3시간 12분 전` / `45초 전` */
export function formatAge(sec: number): string {
  if (sec < 60) return `${String(Math.max(0, Math.round(sec)))}초 전`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${String(min)}분 전`;
  const h = Math.floor(min / 60);
  return `${String(h)}시간 ${String(min % 60)}분 전`;
}

/**
 * 다음 재시도 시각.
 *
 * ★ AD-2 재조회가 예약돼 있으면 **그 시각**이다. 자동 재확인이 도는 시점보다 먼저
 *   사람이 다시 눌러 봐야 상류 캐시는 그대로라 결과가 같다.
 */
export function nextRetryAt(lookup: FollowerLookup, now: number): number {
  if (lookup.recheckAt !== undefined) return lookup.recheckAt;
  const cacheMs = UPSTREAM_FOLLOWER_CACHE_MIN * 60_000;
  if (lookup.cachedAt !== undefined) {
    const cached = Date.parse(lookup.cachedAt);
    if (Number.isFinite(cached) && cached + cacheMs > now) return cached + cacheMs;
  }
  return now + cacheMs;
}

/** 스냅샷 시각 한 줄. `cachedAt` 이 없으면(형태 불량) 그 사실을 말한다 */
function snapshotLine(lookup: FollowerLookup): string {
  if (lookup.cachedAt === undefined) {
    return '· 팔로워 목록 스냅샷 시각: 확인하지 못했습니다';
  }
  const at = Date.parse(lookup.cachedAt);
  const age = lookup.snapshotAgeSec === undefined ? '' : ` (${formatAge(lookup.snapshotAgeSec)})`;
  return `· 팔로워 목록 스냅샷 기준: ${formatKst(at)}${age}`;
}

/** `unknown` 사유를 사람 말로. **어느 것도 "팔로워가 아닙니다" 라고 말하지 않는다** */
const UNKNOWN_DETAIL: Readonly<Record<FollowerUnknownReason, string>> = {
  'not-synced': '팔로워 목록이 아직 준비되지 않았습니다',
  stale: '팔로워 목록이 최신이 아닙니다',
  'http-4xx': '팔로워 확인 요청이 거부됐습니다',
  'http-5xx': '팔로워 확인 서버가 응답하지 못했습니다',
  timeout: '팔로워 확인이 제한 시간 안에 끝나지 않았습니다',
  'wrong-channel': '팔로워 확인 응답이 이 채널의 것이 아닙니다',
  'bad-shape': '팔로워 확인 응답을 해석하지 못했습니다',
};

/**
 * ★ `no` — 거부 안내. **스냅샷 시각 + 다음 재시도 시각을 둘 다 싣는다** (R-4).
 */
export function notFollowerMessage(lookup: FollowerLookup, now: number): string {
  const lines = [
    '아직 팔로워로 확인되지 않았습니다.',
    snapshotLine(lookup),
    `· 다시 시도 가능한 시각: ${formatKst(nextRetryAt(lookup, now))}`,
  ];
  if (lookup.recheckAt !== undefined) {
    // AD-2 — 사람이 다시 누르지 않아도 한 번은 우리가 확인한다. 그 사실을 말해 준다.
    lines.push(
      `· 그 시각에 **자동으로 한 번 더** 확인합니다. 팔로우가 확인되면 역할이 바로 부여됩니다.`,
    );
  }
  lines.push(
    '',
    `치지직에서 채널을 팔로우한 뒤 다시 시도해 주십시오. **방금 팔로우하셨다면 최대 ${String(UPSTREAM_FOLLOWER_CACHE_MIN)}분 뒤** 다시 시도해 주십시오.`,
  );
  return lines.join('\n');
}

/**
 * ★ `unknown` — **거부가 아니라 보류다.**
 *
 *   "팔로우하세요" 라고 쓰지 않는다. 우리가 모르는 것이지 그 사람이 안 한 것이 아니다.
 */
export function unknownMessage(lookup: FollowerLookup, now: number): string {
  const detail =
    lookup.reason === undefined ? '팔로워 확인에 실패했습니다' : UNKNOWN_DETAIL[lookup.reason];
  return [
    `팔로워 여부를 **확인하지 못했습니다** — 팔로우하지 않으셨다는 뜻이 아닙니다.`,
    `· 사유: ${detail}`,
    snapshotLine(lookup),
    `· 다시 시도 가능한 시각: ${formatKst(nextRetryAt(lookup, now))}`,
    '',
    `잠시 후 **${AUTH_PANEL_LINK_LABEL}** 버튼을 다시 눌러 주십시오. 계속 같은 안내가 나오면 운영자에게 알려 주십시오.`,
  ].join('\n');
}

export function linkedMessage(channelName: string, gate: GateOutcome): string {
  const lines = [`인증이 완료됐습니다. 치지직 채널 **${channelName}** 을(를) 연동했습니다.`];
  if (gate.roleAlreadyHeld) lines.push('· 역할은 이미 갖고 계셔서 그대로 두었습니다.');
  else lines.push('· 역할을 부여했습니다.');

  // ★ AC-11 — 닉네임 실패는 **인증 실패가 아니다.** 그래서 여기 문안도
  //   "실패했습니다" 가 아니라 "바꾸지 못했습니다" 다.
  const nick = gate.failures.find((f) => f.part === 'nickname');
  if (nick !== undefined) {
    lines.push(
      '· 서버 닉네임은 바꾸지 못했습니다(봇보다 높은 역할을 갖고 계신 경우입니다). **인증 자체는 정상 완료됐습니다.**',
    );
  } else if (gate.nicknameApplied) {
    lines.push('· 서버 닉네임을 치지직 채널명으로 맞췄습니다.');
  }
  return lines.join('\n');
}

export function alreadyLinkedMessage(channelName: string): string {
  return [
    `이미 치지직 채널 **${channelName}** 로 인증돼 있습니다.`,
    '다른 계정으로 바꾸시려면 운영자에게 `/연동해제` 를 요청해 주십시오.',
  ].join('\n');
}

/** ★ AC-7 — 거부. 기존 연동은 **건드리지 않았다**는 사실을 함께 말한다 */
export function duplicateChannelMessage(channelName: string): string {
  return [
    `치지직 채널 **${channelName}** 은(는) 이미 이 서버의 다른 계정에 연동돼 있습니다.`,
    '기존 연동은 그대로 유지됩니다. 본인 계정이 맞다면 운영자에게 문의해 주십시오.',
  ].join('\n');
}

/**
 * 역할 부여 실패. 연동 행은 이미 있다.
 *
 * ★ "버튼을 다시 누르면 역할만 부여된다" 는 약속은 `commands/link.ts` 의 1번 분기가 지킨다 —
 *   이미 연동된 사람에게 역할이 없으면 게이트만 다시 적용한다. 문안이 코드보다 앞서면 안 된다.
 */
export function gateFailedMessage(gate: GateOutcome): string {
  const role = gate.failures.find((f) => f.part === 'role');
  const why =
    role?.kind === 'forbidden'
      ? '봇에게 역할을 부여할 권한이 없습니다(봇 역할이 대상 역할보다 아래에 있는지 확인이 필요합니다).'
      : '역할을 부여하지 못했습니다.';
  return `${why} 운영자에게 알려 주십시오. 연동은 저장돼 있으니 원인이 해결된 뒤 **${AUTH_PANEL_LINK_LABEL}** 버튼을 다시 누르시면 역할만 부여됩니다.`;
}

/**
 * 이미 연동된 사람에게 역할만 다시 붙였다 (`commands/link.ts` 1번 ★★).
 *
 * @param knownMissing 캐시가 "역할이 없다" 를 **확실히** 알았는가. 몰랐으면(캐시 미스) 부여는
 *   멱등 호출이라 "빠져 있던" 이라고 단정하지 않는다.
 */
export function roleRegrantedMessage(channelName: string, knownMissing: boolean): string {
  return [
    `치지직 채널 **${channelName}** 로 이미 인증돼 있습니다.`,
    knownMissing ? '· 빠져 있던 역할을 다시 부여했습니다.' : '· 역할을 확인해 부여했습니다.',
  ].join('\n');
}

export function exchangeFailedMessage(): string {
  return [
    '치지직 인증을 완료하지 못했습니다.',
    `인가 코드는 1회용이라 이미 사용됐을 수 있습니다. 디스코드에서 **${AUTH_PANEL_LINK_LABEL}** 버튼을 다시 눌러 처음부터 진행해 주십시오.`,
  ].join('\n');
}

export function badStateMessage(): string {
  return [
    '인증 요청을 확인하지 못했습니다.',
    '브라우저를 열어둔 채 오래 두었거나, 다른 창에서 시작한 인증일 수 있습니다.',
    `디스코드에서 **${AUTH_PANEL_LINK_LABEL}** 버튼을 다시 눌러 처음부터 진행해 주십시오.`,
  ].join('\n');
}

/** 우리 앱 메시지의 버튼인데 지금 코드가 모르는 `custom_id` — 옛 버전 패널이다 */
export function unknownButtonMessage(): string {
  return '이 버튼은 더 이상 쓰이지 않습니다. 게이트 채널의 최신 인증 패널을 이용해 주십시오.';
}

export function cooldownMessage(retryAfterSec: number): string {
  return `조금 전에 이미 인증을 시작하셨습니다. ${String(retryAfterSec)}초 뒤에 다시 시도해 주십시오.`;
}

export function busyMessage(): string {
  return '지금 인증을 진행 중인 분이 많습니다. 잠시 후 다시 시도해 주십시오.';
}
