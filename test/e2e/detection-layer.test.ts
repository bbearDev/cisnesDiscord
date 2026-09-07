import { describe, expect, it } from 'vitest';

import { SIS, boot, flush } from '../helpers/app-harness.js';

/**
 * ★★ 감지 계층 공유 재현 — 계획 §12-b "남는 누락".
 *
 * ## 이 파일이 고정하는 것은 **버그가 아니라 거래다**
 *
 * chzzkbot 의 자동 감지 트리거는 **첫 채팅 하나뿐**이다. 아무도 채팅을 치지 않으면
 * 세션이 열리지 않고, 세션이 없으면 웹훅도 `/api/live` 도 침묵한다.
 * 그때 조회 API 가 답하는 것은 `live:false, confirmed:false, status:'running'` 인데,
 * ★ **이것은 "방송 중 아님" 의 정상 응답과 글자 하나 다르지 않다.**
 *
 * 그래서 무채팅 방송은 **기계가 잡을 수 없다.** 사용자가 내린 결정은
 * chzzkbot 수정도 자체 감지도 하지 않고 **운영 절차(S0-13)로 닫는 것**이다 —
 * 스트리머가 방송 직후 채팅 한 줄을 친다.
 *
 * ## 왜 테스트로 고정하는가
 *
 * 이 구멍을 문서로만 두면 나중에 누가 *"방송 중인데 공지가 안 나간다"* 를
 * 버그로 접수하고, 고치려다 **`live:false` 를 추측으로 메우는 코드**를 넣는다.
 * 그 순간 §3-a 3위(틀리게 보내기)로 떨어져 끝난 방송에 시작 공지가 나간다.
 *
 * **이 테스트는 "공지 0건 · 경보 0건" 이 정상임을 못 박는다.**
 * 누군가 이 동작을 바꾸면 여기가 빨간불이 되고, 그때 §12-b 를 다시 읽게 된다.
 *
 * ⚠️ 여기서 확인하는 "누락 0" 의 유효 범위는 **세션이 열린 방송에 한한다.**
 *    S9 수동 항목 M-1/M-2 가 이 예행을 실제 방송으로 마무리한다.
 */

/** 세션이 없는 채널 — 무채팅 방송과 평상시가 **구분되지 않는** 바로 그 응답 */
const NO_SESSION = {
  version: 1,
  generatedAt: '2026-09-06T19:00:00.000Z',
  channels: [
    {
      channelId: SIS,
      channelName: '시스네',
      live: false,
      confirmed: false,
      exact: false,
      status: 'running',
      socketState: 'connected',
    },
  ],
};

describe('§12-b 남는 누락 — 무채팅 방송은 기계가 잡을 수 없다', () => {
  it('★★ 세션 없음을 100회 폴링하고 웹훅도 없으면 공지 0건 · 경보 0건', async () => {
    const { app, fake, clock, alertEvents } = await boot((u) => {
      u.setLiveResponse(NO_SESSION);
    });
    // ★ app.start() 를 부르지 않는다. 기동 폴이 in-flight 인 동안 우리 poll() 이
    //   `skipped` 로 튕겨 **테스트가 공짜로 통과**한다 (실제로 그렇게 통과했다).
    for (let i = 0; i < 100; i++) {
      const tick = await app.livePoller.poll();
      // ★★ 공짜 통과 방지: 폴이 실제로 돌았는지 매번 확인한다.
      expect(tick.outcome).not.toBe('skipped');
      clock.advance(3 * 60_000);
    }

    // 공지 0건 — 방송 중인지 알 수 없으므로 보내지 않는다
    expect(fake.sent).toHaveLength(0);
    // ★ 경보도 0건이다. 이 응답은 **정상**이지 고장이 아니다.
    expect(alertEvents).toHaveLength(0);
    // ★ unknown 도 아니다 — `!live && status==='running'` 은 `ended` 로 접힌다.
    //   unknown 으로 셌다면 100회 폴링이 AC-P2 경보를 100번 울렸을 것이다.
    expect(app.stuckWatch.value('live-api-unknown', SIS, clock.now())).toBe(0);
    expect(app.stuckWatch.value('confirmed-stuck', SIS, clock.now())).toBe(0);
  });

  it('원장에도 아무 행이 생기지 않는다 — 나중에 선점을 막지 않는다', async () => {
    const { app } = await boot((u) => {
      u.setLiveResponse(NO_SESSION);
    });
    for (let i = 0; i < 5; i++) {
      expect((await app.livePoller.poll()).outcome).not.toBe('skipped');
    }

    expect(app.ledger.pendingRetries(100)).toHaveLength(0);
    // ★ 그래서 나중에 그 방송이 인식되면 정상적으로 선점된다.
    expect(app.ledger.claim('live_start', 'df09256e', new Date().toISOString(), 'webhook')).toBe(
      true,
    );
  });

  it('★ 그 침묵은 "고장" 과 구분되지 않는다 — 이것이 계획이 인정한 한계다', async () => {
    // 같은 응답이 "무채팅 방송 중" 일 수도 "방송을 안 하는 중" 일 수도 있다.
    // 우리 코드에는 둘을 가를 근거가 **없다.** 그 사실 자체를 단언한다.
    const { app, clock } = await boot((u) => {
      u.setLiveResponse(NO_SESSION);
    });
    expect((await app.livePoller.poll()).outcome).not.toBe('skipped');

    // 판정은 `ended` 다 — 공지 대상이 없으므로 상태 갱신만 하고 끝난다.
    // `unknown` 이었다면 경보 축이 살아 있었겠지만, 계약상 이 응답은 정상이다.
    expect(app.stuckWatch.value('live-api-unknown', SIS, clock.now())).toBe(0);
    expect(app.ops.count()).toBe(0);
  });
});

describe('★ 대비 — 세션이 열리는 순간 같은 경로가 공지한다 (S9 M-2 의 예행)', () => {
  it('무채팅으로 침묵하다가 스트리머가 채팅 한 줄을 치면 공지 1건이 나간다', async () => {
    const { app, fake, upstream, clock } = await boot((u) => {
      u.setLiveResponse(NO_SESSION);
    });
    // ── 1단계: 무채팅 방송 — 우리는 아무것도 모른다 ──────────────
    const first = await app.livePoller.poll();
    expect(first.outcome).not.toBe('skipped');
    expect(first.announced).toBe(false);
    expect(fake.sent).toHaveLength(0);

    // ── 2단계: 스트리머가 채팅 한 줄 → 세션이 열리고 스캔이 openDate 를 붙인다 ──
    //    (실제로는 chzzkbot 이 바꾼다. 하니스는 그 결과만 재현한다)
    upstream.loadLiveFixture('chzzkbot/api-live-announce.json');
    clock.advance(3 * 60_000);
    const second = await app.livePoller.poll();
    expect(second.announced).toBe(true);
    // 발송은 비동기다 — 원장 선점은 동기이고 디스코드 발송은 그 뒤에 붙는다.
    await flush();

    // ★ 우리 쪽에 고친 것이 하나도 없는데 공지가 나간다 — 같은 폴러, 같은 판정식이다.
    //   이것이 §12-b 가 "운영 절차로 닫는다" 고 말할 수 있는 근거다.
    expect(fake.sent).toHaveLength(1);
    expect(app.ledger.get('live_start', 'df09256e')?.detectedVia).toBe('api-poll');
  });
});
