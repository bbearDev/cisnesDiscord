import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createAnnouncementLedgerRepo } from '../../src/store/repos/announcement-ledger-repo.js';
import { createHttpBudget } from '../../src/runtime/http-budget.js';
import { createFollowerChecker } from '../../src/chzzk/follower-check.js';
import { systemClock } from '../../src/runtime/clock.js';
import { measureDowntime, recoverYoutube } from '../../src/recovery/downtime.js';
import { boot, flush } from '../helpers/app-harness.js';
import { SYSTEMD_TIMEOUT_STOP_SEC } from '../../src/config/schema.js';
import { BIND_ERROR_EXIT_CODE } from '../../src/web/server.js';
import { LOCK_ERROR_EXIT_CODE } from '../../src/main.js';

/**
 * ★★ 얇은 방어를 보강한다 — **변이 테스트로 찾은 자리**.
 *
 * ## 어떻게 찾았는가
 *
 * 소스의 불변식을 하나씩 일부러 깨뜨리고 스위트가 잡는지 셌다.
 * 대부분은 3~21건이 잡았는데 **두 곳은 정확히 1건**만 잡았다:
 *
 * | 깨뜨린 것 | 잡은 테스트 |
 * |---|---|
 * | `unknown` 을 `ended` 로 접기 | 6 |
 * | 신선도 게이트를 `isFollower` 뒤로 옮기기 | 6 |
 * | FM5 재진입 가드 제거 | 3 |
 * | R5 채널 필터 제거 | 21 |
 * | **시딩 행 아웃박스 가드 제거** | **1** |
 * | **신선도 경계 `>=` → `>`** | **1** |
 *
 * ## 왜 1건이 문제인가
 *
 * 잡히기는 한다. 그러나 **그 테스트 하나를 무심코 고치면 방어가 통째로 사라지고,
 * 사라진 사실을 아무도 모른다.** 두 불변식 모두 깨졌을 때의 증상이 조용하다 —
 * 하나는 최초 기동에 과거 영상 15건이 도배되는 것이고(AC-26), 다른 하나는
 * 낡은 스냅샷으로 신규 멤버를 거부하는 것이다(§3-a 3위).
 *
 * ★ 여기서는 **다른 각도**로 같은 불변식을 건다. 같은 각도로 한 번 더 쓰면
 *   한 번의 리팩터링이 둘을 함께 지운다.
 */

const SIS = 'c3355ea2b3bea6c646789510796379d6';
const AT = '2026-09-06T19:00:00.000Z';

function ledgerOf(): ReturnType<typeof createAnnouncementLedgerRepo> {
  const db = new Database(':memory:');
  db.exec(readFileSync('src/store/migrations/001_init.sql', 'utf8'));
  return createAnnouncementLedgerRepo(db);
}

describe('★ AC-26 — 시딩 행 가드가 기대는 두 신호가 실제로 서 있다', () => {
  /**
   * 조립부의 가드는 `detectedVia === 'seed'` **또는** `seeded === true` 를 본다.
   * 둘 다 보는 이유는 어느 한쪽이 바뀌어도 문이 닫혀 있게 하기 위해서다.
   * ★ 그러나 **두 신호가 애초에 세워지지 않으면** 이중 방어가 이중이 아니게 된다.
   *   그 전제를 여기서 건다 — 가드 자체를 다시 테스트하는 것이 아니라, 가드가
   *   기대는 **데이터가 실제로 그 모양인지**를 본다.
   */
  it('시딩이 만든 행은 detected_via=seed 와 seeded=1 을 **둘 다** 갖는다', async () => {
    const ledger = ledgerOf();
    await recoverYoutube({
      window: measureDowntime(Date.parse(AT) - 7 * 60 * 60 * 1_000, Date.parse(AT)),
      videos: [
        { videoId: 'SEEDA', channelId: 'UC1', publishedAt: '2026-09-01T00:00:00Z' },
        { videoId: 'SEEDB', channelId: 'UC1', publishedAt: '2026-09-02T00:00:00Z' },
      ],
      ledger,
      announce: () => Promise.resolve(),
      at: AT,
    });

    for (const id of ['SEEDA', 'SEEDB']) {
      const row = ledger.get('youtube_upload', id);
      expect(row?.detectedVia).toBe('seed');
      expect(row?.seeded).toBe(true);
    }
  });

  it('★ 그리고 그 행들은 실제로 아웃박스 회수 대상에 들어간다 — 가드가 없으면 나간다', async () => {
    // ★ 이 단언이 이 파일의 요점이다. "가드가 막는다" 가 아니라
    //   **"막지 않으면 나간다"** 를 고정한다. 이것이 참이어야 가드가 의미를 갖는다.
    const ledger = ledgerOf();
    await recoverYoutube({
      window: measureDowntime(undefined, Date.parse(AT)),
      videos: Array.from({ length: 15 }, (_, i) => ({
        videoId: `SEED${String(i).padStart(2, '0')}`,
        channelId: 'UC1',
        publishedAt: `2026-09-01T00:${String(i).padStart(2, '0')}:00Z`,
      })),
      ledger,
      announce: () => Promise.resolve(),
      at: AT,
    });

    // 15건 전부 `announced_at IS NULL` 이라 대기열에 들어온다.
    const pending = ledger.pendingRetries(100);
    expect(pending).toHaveLength(15);
    // → 조립부가 이 15건을 거르지 않으면 **최초 기동이 과거 영상 도배가 된다** (AC-26 위반).
    expect(pending.every((r) => r.detectedVia === 'seed')).toBe(true);
  });

  it('정상 발송 대기 행은 시딩 신호를 갖지 않는다 — 가드가 정상 건을 막지 않는다', () => {
    const ledger = ledgerOf();
    ledger.claim('youtube_upload', 'REALVID', AT, 'websub');
    const row = ledger.get('youtube_upload', 'REALVID');
    expect(row?.detectedVia).toBe('websub');
    expect(row?.seeded).toBe(false);
  });
});

describe('★ 신선도 경계 — 임계 그 자체가 이미 stale 이다', () => {
  /**
   * 계획 §9.2 가 **"149:59 통과 / 150:00 unknown"** 으로 못 박았다.
   * `>` 로 쓰면 정확히 150:00 인 스냅샷이 통과해 낡은 값으로 판정이 확정된다.
   *
   * ★ 1분 차이가 사소해 보이지만, 이 경계는 **오탐이 아니라 오판 쪽으로 실패한다** —
   *   통과시키면 낡은 캐시가 신규 멤버를 "미팔로우"로 거부한다(§3-a 3위).
   */
  const STALE_MIN = 150;

  async function verdictAtAge(ageMs: number): Promise<string> {
    const now = Date.parse(AT);
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            channelId: SIS,
            isFollower: true,
            everSynced: true,
            cachedAt: new Date(now - ageMs).toISOString(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const checker = createFollowerChecker({
      budget: createHttpBudget({ fetchImpl }),
      baseUrl: 'http://127.0.0.1:8080',
      token: 'x'.repeat(48),
      channelId: SIS,
      staleAfterMin: STALE_MIN,
      clock: { ...systemClock, now: () => now, date: () => new Date(now) },
    });
    const r = await checker.check('v'.repeat(32), now);
    checker.dispose();
    return r.verdict;
  }

  it('149:59 는 통과한다 (isFollower:true → yes)', async () => {
    expect(await verdictAtAge((STALE_MIN * 60 - 1) * 1_000)).toBe('yes');
  });

  it('★ 정확히 150:00 은 보류다 — 경계 포함', async () => {
    expect(await verdictAtAge(STALE_MIN * 60 * 1_000)).toBe('unknown');
  });

  it('150:01 도 당연히 보류다', async () => {
    expect(await verdictAtAge((STALE_MIN * 60 + 1) * 1_000)).toBe('unknown');
  });

  it('★ 경계 위에서 isFollower 값이 판정을 바꾸지 못한다 — 게이트가 먼저다', async () => {
    // isFollower:true 인데도 unknown 이다. 이것이 게이트가 "먼저" 라는 뜻이다.
    expect(await verdictAtAge(STALE_MIN * 60 * 1_000)).toBe('unknown');
  });
});

describe("★ 시딩 가드의 '이중 방어' 가 실제로 이중인지 — 각 절반이 단독으로 문을 닫는가", () => {
  /**
   * 조립부의 가드는 `detectedVia === 'seed'` **또는** `seeded === true` 를 본다.
   * 어느 한쪽이 바뀌어도 닫혀 있게 하려는 의도인데, **정상 시딩 행은 두 신호를 다 갖는다.**
   * 그래서 한쪽만 떼어내도 다른 쪽이 계속 막아 주고, **테스트는 아무 차이를 못 본다** —
   * 리뷰의 변이 스윕에서 두 절반이 각각 0건을 잡은 이유가 이것이다.
   *
   * ★ 이중 방어가 실제로 이중이려면 **신호가 하나만 있는 행**에서 각 절반이 단독으로
   *   문을 닫아야 한다. 그런 행을 일부러 만들어 확인한다. 이 행들은 정상 경로가
   *   만들지 않지만, 스키마가 허용하므로 **마이그레이션이나 상류 변경으로 생길 수 있다.**
   */
  const AT2 = '2026-09-06T19:00:00.000Z';

  it("detected_via='seed' 인데 seeded=0 인 행도 발송되지 않는다 (앞쪽 절반)", async () => {
    const { app, fake } = await boot(() => undefined, {
      seed: (db) => {
        db.prepare(
          `INSERT INTO announcement_ledger(kind, event_key, detected_via, claimed_at, seeded)
           VALUES('youtube_upload','HALFA','seed',?,0)`,
        ).run(AT2);
      },
    });

    // ★ 반공허 가드: 그 행이 실제로 회수 대상에 들어와 있어야 이 테스트가 의미를 갖는다.
    expect(app.ledger.pendingRetries(100).some((r) => r.eventKey === 'HALFA')).toBe(true);

    await app.outbox.runOnce();
    await flush();
    expect(fake.sent.filter((m) => JSON.stringify(m).includes('HALFA'))).toHaveLength(0);
  });

  it("seeded=1 인데 detected_via='websub' 인 행도 발송되지 않는다 (뒤쪽 절반)", async () => {
    const { app, fake } = await boot(() => undefined, {
      seed: (db) => {
        db.prepare(
          `INSERT INTO announcement_ledger(kind, event_key, detected_via, claimed_at, seeded)
           VALUES('youtube_upload','HALFB','websub',?,1)`,
        ).run(AT2);
      },
    });

    expect(app.ledger.pendingRetries(100).some((r) => r.eventKey === 'HALFB')).toBe(true);

    await app.outbox.runOnce();
    await flush();
    expect(fake.sent.filter((m) => JSON.stringify(m).includes('HALFB'))).toHaveLength(0);
  });

  it('★ 두 신호가 **모두 없는** 정상 대기 행은 발송된다 — 가드가 정상 건을 막지 않는다', async () => {
    // ★ 이것이 위 두 테스트를 의미 있게 만든다. 가드가 전부를 막는다면
    //   "발송 0건" 은 가드가 아니라 아웃박스 고장으로도 참이 된다.
    const { app, fake } = await boot(() => undefined, {
      seed: (db) => {
        db.prepare(
          `INSERT INTO announcement_ledger(kind, event_key, detected_via, claimed_at, seeded)
           VALUES('youtube_upload','REALV','websub',?,0)`,
        ).run(AT2);
      },
    });

    await app.outbox.runOnce();
    await flush();
    expect(fake.sent.length).toBeGreaterThan(0);
  });
});

describe('★ 저장소 밖으로 새어 나간 파생 상수 — systemd 유닛 ↔ TS 상수', () => {
  /**
   * ★★ §2-b 는 *"값을 바꿀 때는 이 표만 고친다"* 를 규칙으로 세웠고, 계획은
   *   7분/8분이 16곳에 갈린 원인이 **값이 아니라 정의 복제**였다고 진단했다.
   *
   *   그 복제가 **저장소 밖으로 한 번 더** 나가 있다: `TimeoutStopSec` 은 systemd
   *   유닛 파일에 적혀 있고, TypeScript 는 그것을 읽지 않는다. `superRefine` ⑤ 가
   *   `startup.bindRetrySec >= SYSTEMD_TIMEOUT_STOP_SEC` 를 강제하지만, **비교 대상인
   *   30 자체가 유닛과 어긋나면** 그 강제는 틀린 기준을 지키는 것이 된다.
   *
   * ★ 왜 이 값이 같아야 하는가 (§5.4): 이전 인스턴스가 정상 종료에 쓸 수 있는 최대
   *   시간이 곧 새 인스턴스가 포트를 기다려야 할 최대 시간이다. 유닛에서 이 값을
   *   늘리면 봇은 여전히 짧게 기다리다 **exit 78** 로 죽는다 — 정상 배포가 실패로 보인다.
   */
  it('유닛의 TimeoutStopSec 이 SYSTEMD_TIMEOUT_STOP_SEC 과 같다', () => {
    const unit = readFileSync('deploy/systemd/cisnesdiscord.service', 'utf8');
    const m = /^TimeoutStopSec=(\d+)$/m.exec(unit);
    // ★ 반공허 가드: 지시자 자체가 사라지면 "같다" 가 아니라 여기서 걸려야 한다.
    expect(m, 'TimeoutStopSec 지시자가 유닛에 없다').not.toBeNull();
    expect(Number(m?.[1])).toBe(SYSTEMD_TIMEOUT_STOP_SEC);
  });

  it('유닛의 RestartPreventExitStatus 가 우리가 실제로 쓰는 두 종료 코드를 덮는다', () => {
    // ★ §5.4 가 exit 78 을 **재사용**하기로 한 이유가 이것이다 — 새 코드를 만들면
    //   이 목록을 함께 고쳐야 하고, 그 한 줄을 빠뜨리는 순간 무한 재시작이 되살아난다.
    const unit = readFileSync('deploy/systemd/cisnesdiscord.service', 'utf8');
    const m = /^RestartPreventExitStatus=(.+)$/m.exec(unit);
    expect(m).not.toBeNull();
    const codes = (m?.[1] ?? '').trim().split(/\s+/).map(Number);
    expect(codes).toContain(BIND_ERROR_EXIT_CODE);
    expect(codes).toContain(LOCK_ERROR_EXIT_CODE);
  });
});
