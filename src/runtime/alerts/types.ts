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
