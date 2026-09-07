// 출처: chzzkbot src/runtime-wiring.ts 의 폴 루프 (재진입 가드 · finally 해제 ·
//       disposed 조기 반환). 판정은 상류에 없던 것이라 여기서 새로 세운다 — 계획 §14
import type { LiveApiClient } from '../chzzk/live-api-client.js';
import type { OpsAlertService } from '../runtime/alerts/ops-alert-service.js';
import type { Clock, Disposable } from '../runtime/clock.js';
import {
  jobFromPoll,
  type LiveAnnounceFn,
  type LiveLedger,
  type LiveSessionStore,
} from './live-announce.js';
import { isConfirmedStuck, isUnknown, judgeLiveState, type LiveJudgment } from './live-state.js';
import type { StuckAlert, StuckWatch } from './stuck-watch.js';

/**
 * `GET /api/live` 폴러 — 웹훅의 **배달 백스톱** (계획 §5.1 W3 · §S5).
 *
 * ★★ **배달 백스톱이지 감지 백스톱이 아니다.**
 *   웹훅과 조회 API 는 **같은 `live_sessions`** 를 읽는다. chzzkbot 이 방송을
 *   감지하지 못하면(무채팅 방송) 폴링도 못 메운다 — 그 구간은 기계가 아니라
 *   S0-13 스트리머 운영 절차가 담당한다. "폴링이 있으니 누락 0" 은 **틀린 안심**이다.
 *
 * ★ 판정은 전부 `live-state.ts` 가 한다. 이 파일에는 `live` · `confirmed` ·
 *   `status` 를 읽는 줄이 **하나도 없다.**
 *
 * ```
 * announce  →  liveHash 미공지면 공지 (detected_via='api-poll', 제목 없음)
 * ended     →  live_sessions.status 갱신만. 공지 없음 (종료 공지는 만들지 않는다)
 * unknown   →  아무것도 하지 않는다. stuck-watch 에만 넘긴다
 * ```
 *
 * ★ 스트릭은 **스스로 세지 않는다.** `stuck-watch.ts` 에 관측을 넘길 뿐이다 —
 *   *"중간에 1회라도 성공하면 리셋"* 규칙이 제어 흐름에 얽히는 것을 막는 것이
 *   그 모듈의 존재 이유다 (§10 시나리오 1 완화책).
 */

export type LivePollOutcome = 'ran' | 'skipped' | 'disposed';

export interface LivePollTick {
  outcome: LivePollOutcome;
  judgment?: LiveJudgment;
  /** 이번 틱에 원장을 선점했는가 (= 공지를 새로 냈는가) */
  announced: boolean;
  /** 이번 틱에 발화한 경보들 */
  alerts: readonly StuckAlert[];
}

export interface LivePollEvent {
  type:
    | 'tick'
    | 'skipped'
    | 'announced'
    | 'duplicate'
    | 'ended'
    | 'unknown'
    | 'unknown-channel'
    | 'store-failed'
    | 'announce-failed';
  judgment?: LiveJudgment;
  liveHash?: string;
  reason?: string;
  channelIds?: readonly string[];
}

export interface LivePollerOptions {
  client: LiveApiClient;
  /** `live.channelId`. 경보 스코프 키이자 stuck-watch 의 scopeKey 다 */
  channelId: string;
  ledger: LiveLedger;
  sessions: LiveSessionStore;
  announce: LiveAnnounceFn;
  stuckWatch: StuckWatch;
  alerts: OpsAlertService;
  clock: Clock;
  /** `live.apiPollIntervalMin` × 60_000 (기본 3분). ★ 재시도 창 7분보다 짧아야 한다 */
  intervalMs: number;
  /** AC-P6. 폴링이 선점했을 때만 유예창이 걸린다 */
  silenceWatch?: { noteClaim(liveHash: string): void };
  onEvent?: (e: LivePollEvent) => void;
}

export interface LivePoller {
  /** 기동 시 1회 + 주기 타이머. 두 번 불러도 타이머는 하나다 */
  start(): void;
  /** 한 바퀴. 테스트가 직접 부른다 */
  poll(): Promise<LivePollTick>;
  dispose(): void;
  readonly inFlight: boolean;
}

export function createLivePoller(opts: LivePollerOptions): LivePoller {
  const { clock, stuckWatch, alerts } = opts;

  /**
   * 이미 경보한 낯선 채널.
   *
   * ★★ **매 폴마다 경보하지 않는다.** 실측상 chzzkbot 은 아이곰 채널을 상시
   *   서빙 중이므로, 관측할 때마다 울리면 3분마다(디바운스가 있어도 30분마다)
   *   같은 사실이 반복되고 그 소음이 진짜 신호를 덮는다.
   *   보호 목록 (b) 가 잡아야 하는 것은 *"설정에 없는 채널이 **나타났다**"* 이므로
   *   **처음 본 채널에만** 발화한다. 재기동하면 다시 한 번 확인시켜 준다.
   */
  const alertedUnknownChannels = new Set<string>();

  /** ★ 재진입 가드. 무응답 소켓이 3초 타임아웃에 걸리는 동안 다음 틱이 오면 겹친다 */
  let inFlight = false;
  let disposed = false;
  let timer: Disposable | undefined;

  const isDisposed = (): boolean => disposed;

  const emit = (e: LivePollEvent): void => {
    try {
      opts.onEvent?.(e);
    } catch {
      /* 진단 로그가 폴링을 죽이면 안 된다 (Principle 2) */
    }
  };

  /** 경보 문구는 **사람이 다음에 칠 명령**을 싣는다 (계획 §5.1 AC-P1) */
  async function raiseStuck(alert: StuckAlert): Promise<void> {
    if (alert.domain === 'confirmed-stuck') {
      await alerts.raise(
        alert.kind,
        `방송 신원 확정이 멈췄습니다 (confirmed 고착) — ${alert.scopeKey}\n` +
          `지속: ${String(Math.round(alert.value / 60_000))}분 ` +
          `(임계 ${String(Math.round(alert.threshold / 60_000))}분)\n` +
          'chzzkbot 이 방송은 인식했는데 전수 스캔이 openDate 를 붙이지 못한 상태입니다.\n' +
          '→ 웹훅이 영영 발사되지 않고, 폴링도 liveHash 가 없어 공지할 수 없습니다.\n' +
          "확인: journalctl --user -u chzzkbot | grep '방송을 인식했습니다'",
      );
      return;
    }
    await alerts.raise(
      alert.kind,
      `GET /api/live 가 ${String(alert.value)}회 연속 unknown 입니다 ` +
        `(임계 ${String(alert.threshold)}회) — ${alert.scopeKey}\n` +
        '조회 API 가 조용히 죽는 것을 잡는 유일한 축입니다.\n' +
        '확인: chzzkbot 프로세스 상태 · 토큰 일치 · 우리 쪽 이그레스',
    );
  }

  async function poll(): Promise<LivePollTick> {
    if (isDisposed()) return { outcome: 'disposed', announced: false, alerts: [] };
    if (inFlight) {
      emit({ type: 'skipped' });
      return { outcome: 'skipped', announced: false, alerts: [] };
    }
    inFlight = true;

    try {
      const res = await opts.client.fetch();
      const at = clock.now();

      let judgment: LiveJudgment;
      /**
       * ★ 채널 행을 실제로 본 틱인가.
       *   못 본 틱(연결 실패·채널 부재)에는 `confirmed-stuck` 을 **관측하지 않는다.**
       *   "관측 없음"을 "정상 관측"으로 넣으면 API 가 깜빡일 때마다 AC-P1 의
       *   지속시간이 리셋되어, 고착이 5분을 넘겨도 영영 발화하지 않는다.
       */
      let sawChannel = false;

      if (!res.ok) {
        judgment = judgeLiveState({
          kind: 'failure',
          failure: res.failure,
          ...(res.detail === undefined ? {} : { detail: res.detail }),
        });
      } else {
        const fresh = res.unknownChannelIds.filter((id) => !alertedUnknownChannels.has(id));
        if (fresh.length > 0) {
          for (const id of fresh) alertedUnknownChannels.add(id);
          emit({ type: 'unknown-channel', channelIds: fresh });
          // ★ 무필터 폴링이라야 이 경보가 성립한다 (§5.2-c 보호 목록 (b)).
          //   `?channel=` 을 붙이면 응답에 우리 채널만 와서 이 줄이 영영 안 돈다.
          await alerts.raise(
            'unknown_channel',
            '설정에 없는 채널이 GET /api/live 응답에 처음 보입니다: ' +
              `${fresh.join(', ')}\n` +
              `우리 대상은 ${opts.channelId} 하나입니다. 공지는 그 채널만 갑니다.\n` +
              'LIVE_API_TOKEN 은 chzzkbot 에 등록된 모든 채널을 여는 운영자 토큰이므로, ' +
              '거르는 책임은 우리에게 있습니다.',
          );
        }
        judgment =
          res.target === undefined
            ? judgeLiveState({ kind: 'channel-missing' })
            : judgeLiveState({ kind: 'channel', channel: res.target });
        sawChannel = res.target !== undefined;
      }

      // ── 스트릭 관측 (AC-P2 · AC-P1) ─────────────────────────────
      const fired: StuckAlert[] = [];
      const unknownAlert = stuckWatch.observe(
        'live-api-unknown',
        opts.channelId,
        isUnknown(judgment),
        at,
      );
      if (unknownAlert !== undefined) fired.push(unknownAlert);
      if (sawChannel) {
        const stuckAlert = stuckWatch.observe(
          'confirmed-stuck',
          opts.channelId,
          isConfirmedStuck(judgment),
          at,
        );
        if (stuckAlert !== undefined) fired.push(stuckAlert);
      }
      for (const a of fired) await raiseStuck(a);

      // ── 상태별 처리 ─────────────────────────────────────────────
      let announced = false;
      if (judgment.state === 'announce') {
        announced = await onAnnounce(judgment.liveHash, judgment.channel, at);
      } else if (judgment.state === 'ended') {
        try {
          opts.sessions.closeOpen(new Date(at).toISOString());
        } catch (e: unknown) {
          emit({ type: 'store-failed', reason: e instanceof Error ? e.message : String(e) });
        }
        emit({ type: 'ended', judgment });
      } else {
        // ★ unknown 에서는 **아무것도 하지 않는다.** 상태를 바꾸지도, 공지하지도 않는다.
        emit({ type: 'unknown', judgment, reason: judgment.reason });
      }

      emit({ type: 'tick', judgment });
      return { outcome: 'ran', judgment, announced, alerts: fired };
    } finally {
      // ★★ finally 여야 한다. 예외로 플래그가 남으면 폴링이 영구히 잠기고,
      //    침묵이라 지표에도 안 나타난다 (§3-a 2위의 최악 형태).
      inFlight = false;
    }
  }

  /**
   * `announce` — 원장을 선점한 쪽만 공지한다.
   *
   * ★ `seeded` 를 **세우지 않는다** (계획 rev.4 B-1). 세우면 이후 claim 이 반드시
   *   실패해 방송 공지가 영영 나가지 않고, 스키마 CHECK 가 그걸 애초에 거부한다.
   */
  async function onAnnounce(
    liveHash: string,
    channel: Parameters<typeof jobFromPoll>[0],
    at: number,
  ): Promise<boolean> {
    const iso = new Date(at).toISOString();

    let claimed: boolean;
    try {
      // ★ eventKey 는 **받은 liveHash 그대로**. 우리가 계산하지 않는다.
      claimed = opts.ledger.claim('live_start', liveHash, iso, 'api-poll');
    } catch (e: unknown) {
      // 원장을 못 쓰면 공지하지 않는다 — 선점 없이 보내면 중복이 난다(§3-a 3위).
      emit({ type: 'store-failed', liveHash, reason: e instanceof Error ? e.message : String(e) });
      return false;
    }

    if (!claimed) {
      emit({ type: 'duplicate', liveHash });
      return false;
    }

    // 세션 행은 공지의 전제가 아니다. 실패해도 공지는 나간다.
    try {
      const { openDate, openedAt } = channel;
      if (openDate !== undefined && openedAt !== undefined) {
        opts.sessions.record(
          {
            liveHash,
            openDate,
            openedAt,
            ...(channel.liveId === undefined ? {} : { liveId: String(channel.liveId) }),
            ...(channel.categoryValue === undefined
              ? {}
              : { categoryValue: channel.categoryValue }),
            status: 'live',
          },
          iso,
        );
      }
    } catch (e: unknown) {
      emit({ type: 'store-failed', liveHash, reason: e instanceof Error ? e.message : String(e) });
    }

    // ★ AC-P6 — 폴링이 먼저 찾았다. 유예창 안에 웹훅이 오지 않으면 경보 1건.
    opts.silenceWatch?.noteClaim(liveHash);

    try {
      await opts.announce(jobFromPoll(channel, liveHash));
    } catch (e: unknown) {
      // 발송기는 던지지 않기로 돼 있지만 계약을 신뢰하지 않는다. 여기서 새면
      // 폴 루프가 죽고, 원장 행은 아웃박스가 다시 집는다.
      emit({ type: 'announce-failed', liveHash, reason: e instanceof Error ? e.message : String(e) });
    }
    emit({ type: 'announced', liveHash });
    return true;
  }

  return {
    get inFlight() {
      return inFlight;
    },

    start(): void {
      if (isDisposed() || timer !== undefined) return;
      // 기동 직후 1회 — 꺼져 있던 동안 시작된 방송을 여기서 잡는다 (AC-29).
      void poll();
      timer = clock.setInterval(() => {
        void poll();
      }, opts.intervalMs);
    },

    poll,

    dispose(): void {
      disposed = true;
      timer?.dispose();
      timer = undefined;
    },
  };
}
