// 출처: chzzkbot src/runtime/alerts/types.ts — 종류 목록과 스코프 개념을 이 저장소의 것으로 교체
/**
 * 경보 종류 — DB `alert_state.alert_kind` CHECK 와 **한 글자도 다르면 안 된다.**
 *
 * 다르면 INSERT 가 CHECK 위반으로 실패하는데, 하필 그 실패가
 * "경보를 보내려던 순간"에 일어나므로 **아무도 모르게 경보가 사라진다.**
 * chzzkbot 이 실제로 겪은 사고이고(계획 §8), 통합 테스트가 두 목록을 대조한다.
 */
export const ALERT_KINDS = [
  /** AC-P1 — `live:true, confirmed:false` 가 `live.confirmedStuckMin` 이상 지속 */
  'confirmed_stuck',
  /** AC-P2 — `GET /api/live` 의 `unknown` 이 `live.pollFailThresholdCount` 회 연속 */
  'live_api_unknown',
  /** AC-P4 — RSS 폴 연속 실패 */
  'rss_fail',
  /** AC-P5 — WebSub 서명 검증 실패. 조용한 202 의 원인을 특정하는 유일한 축 */
  'websub_signature',
  /** AC-P6 — 폴링이 announce 를 claim 했는데 유예창 안에 웹훅 기록이 없다 */
  'webhook_silence',
  /** AC-P7 — 리스 잔량 부족 또는 갱신 연속 실패 */
  'websub_lease',
  /**
   * §5.2 — 팔로워 스냅샷이 `follower.staleAfterMin` 보다 낡았다.
   *
   * ★ **배선은 하되 임계 확정(S1-J) 전까지 경보를 켜지 않는다.**
   *   150분은 소스 상수 추론이지 실측이 아니다. 검증 안 된 임계로 경보하면
   *   `stale` 이 지정한 "스코프 상실·동기화 중단의 유일한 관측 축"이
   *   오탐에 덮인다. **게이트는 지금 켜고 경보는 나중에** 켠다 — 게이트는
   *   틀려도 안전한 방향(보류)이고 경보는 임계가 맞아야 의미가 있다.
   */
  'follower_stale',
  /**
   * §5.2-c — 폴링 응답에 **우리 설정에 없는 채널**이 보인다.
   *
   * chzzkbot 이 2채널을 서빙 중이므로 `?channel=` 없이 무필터로 폴링하고
   * 우리가 거른다. 무필터여야 이 누락 탐지가 성립한다 — 필터를 붙이면
   * 응답에 우리 채널만 와서 이 경보가 영영 발화하지 않는다.
   */
  'unknown_channel',
  /** AC-19 — 디스코드 발송이 재시도 3회를 소진했다 */
  'discord_send_failed',
  /** §5.6.2 — `verification_sessions` 가 MAX_PENDING 에 도달했다 (공격 관측) */
  'auth_pending_max',
  /** AC-30 — 다운타임 감지. 밀린 유튜브 업로드를 몇 건 생략했는지 함께 싣는다 */
  'downtime_detected',
  /** AC-34 — 하트비트가 낡았다 (프로세스 안에서 관측된 분. 밖은 systemd 워치독) */
  'heartbeat_stale',
] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];

/**
 * 디바운스 면제 종류.
 *
 * ★ 지금은 비어 있다. chzzkbot 은 폭주(`flood_guard`)를 면제했는데, 그건
 *   "채팅창이 실시간으로 도배되는 중"이라 30분 디바운스가 실질 피해를 키우기
 *   때문이다. 여기 경보는 전부 **이미 임계·스트릭을 넘긴 뒤**에야 나므로
 *   그 자체가 디바운스 역할을 한다 — 면제를 더하면 같은 장애가 30분간
 *   반복 발송된다. 배열을 남겨 두는 이유는 필요해질 때 **한 곳만** 고치기 위해서다.
 */
export const DEBOUNCE_EXEMPT: readonly AlertKind[] = [];

/**
 * 종류별 디바운스 간격(분) 재정의. 없는 종류는 `alerts.minIntervalMin`(기본 30)을 쓴다.
 *
 * ★★ 왜 필요한가 — **경보의 유효기간이 종류마다 다르다.**
 *   기본 30분은 *"조치하면 곧 멎는 상태"* 를 전제한다. 그런데 `websub_lease` 는
 *   리스 잔여가 임계 아래로 내려간 **마지막 하루 내내** 참이다(리스 5일 × 20%).
 *   30분이면 하루에 **48번** 오는데, 첫 한 번 이후로는 새로 알려 주는 것이 없다.
 *
 * ★ 실측(2026-09-18): 허브 장애로 갱신이 막힌 동안 이 경보가 30분마다 울렸고,
 *   매번 *"억제된 동일 경보 5~6건"* 이 붙었다. 운영자가 할 수 있는 일은 없었고
 *   (허브가 503), 그 사이 다른 경보가 이 소음에 묻힐 위험만 커졌다.
 *
 * ★★ **6시간도 모자랐다** (실측 2026-09-20). 처음에는 *"임계 아래 구간이 대략
 *   하루이니 네 번 알린다"* 로 6시간을 골랐는데, 그 전제가 틀렸다 —
 *   **만료된 뒤에는 잔여가 영영 0%** 라 구간이 하루로 끝나지 않는다.
 *   한 채널이 일주일째 이 상태이고(허브가 그 토픽을 막았다 · 23전 0승),
 *   경보는 *"억제된 동일 경보 71건"* 을 달고 6시간마다 계속 왔다.
 *
 *   **새로 알려 주는 것이 없는 경보는 경보가 아니다.** 게다가 이 경보는 행동을
 *   유발하지 못한다 — 눌러도 503 이고, 업로드 공지는 RSS 가 계속 낸다.
 *
 * ★ 24시간을 고른 이유: **끄지는 않는다.** 하루 한 번은 "이 상태가 아직 이어진다" 를
 *   잊지 않게 해 주고, 그 한 줄이 사라지면 그때가 회복된 때다. 완전히 죽이면
 *   (무한대) 같은 일이 다음에 났을 때 아무도 모른다 (§3-a 안 보내기).
 *
 * ⚠️ 이것은 **소음 대책이지 원인 대책이 아니다.** 진짜 답은 "리스 만료" 가 아니라
 *   **"WebSub·RSS 두 경로가 다 죽었을 때"** 를 경보하는 것이다 — 리스가 0% 여도
 *   RSS 가 살아 있으면 공지는 나간다. 그 조건부 경보는 별건으로 남겨 둔다.
 */
export const DEBOUNCE_INTERVAL_OVERRIDE_MIN: Partial<Record<AlertKind, number>> = {
  websub_lease: 1_440,
};

export function isAlertKind(v: string): v is AlertKind {
  return (ALERT_KINDS as readonly string[]).includes(v);
}

/**
 * 스코프가 없는 경보의 `alert_state.scope` 값.
 *
 * ★ 왜 `''`(빈 문자열)이 아닌가.
 *   빈 문자열은 **버그로 `undefined` 가 흘러온 경로**와 구분되지 않는다.
 *   그러면 "전역 경보"와 "스코프 식별에 실패한 경보"가 같은 버킷에 섞여,
 *   망가진 채널 하나가 시스템 경보 전체를 디바운스로 삼킨다.
 *   치지직 channelId 는 32자 hex, 유튜브 channelId 는 `UC…`, 디스코드 길드 id 는
 *   숫자열이라 이 값과 충돌할 수 없다.
 */
export const SYSTEM_SCOPE = '__system__';
