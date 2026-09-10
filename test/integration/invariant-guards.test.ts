import { readFileSync, readdirSync } from 'node:fs';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createAnnouncementLedgerRepo } from '../../src/store/repos/announcement-ledger-repo.js';
import { createHttpBudget } from '../../src/runtime/http-budget.js';
import { createFollowerChecker } from '../../src/chzzk/follower-check.js';
import { systemClock } from '../../src/runtime/clock.js';
import { measureDowntime, recoverYoutube } from '../../src/recovery/downtime.js';
import { isSuppressed } from '../../src/store/repos/announcement-ledger-repo.js';
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

  it('★★ 시드 행은 아웃박스 회수 창에 **들어오지 않는다** — 들어오면 진짜 건이 굶는다', async () => {
    /**
     * ★★ 예전에는 이 자리가 *"들어간다"* 를 고정했다. 발송 지점 가드가 막아 주니
     *   회수 대상에 들어와도 된다고 봤던 것인데, **그것이 사고를 냈다.**
     *
     *   시드 행은 영원히 `announced_at IS NULL` 이고 기동 시딩이라 가장 오래됐다.
     *   `claimed_at ASC LIMIT 20` 정렬의 영구 상위권이라, 개수가 창을 넘는 순간
     *   창이 통째로 시드로 채워진다. 2026-09-08 방송 공지 1건과 업로드 1건이
     *   그렇게 이틀을 갇혔다 — 원장에 행이 남아 있는데 아무도 집어가지 않았다.
     *
     * ★ 발송 지점 가드는 **그대로 둔다.** 여기가 벨트고 그쪽이 멜빵이다.
     */
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

    // 15건 전부 `announced_at IS NULL` 이지만 **회수 창에는 하나도 안 들어온다.**
    expect(ledger.pendingRetries(100)).toHaveLength(0);

    // ★ 그런데 행 자체는 미발송으로 남아 있다 — 지운 것이 아니다.
    //   (지우면 폴백이 재선점해 과거 영상을 다시 공지한다)
    for (let i = 0; i < 15; i++) {
      const id = `SEED${String(i).padStart(2, '0')}`;
      expect(ledger.get('youtube_upload', id)?.announcedAt).toBeUndefined();
    }

    // ★ 반공허: 시드 표식이 없는 행은 같은 창에 그대로 들어온다.
    ledger.claim('youtube_upload', 'REALONE', AT, 'websub');
    expect(ledger.pendingRetries(100).map((r) => r.eventKey)).toEqual(['REALONE']);
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
  /**
   * ★★ **방금 감지한 것처럼** 둔다. 낡은 시각을 쓰면 신선도 억제(§AC-30 과 같은 임계)가
   *   먼저 걸려 *"발송 0건"* 이 시딩 가드가 아니라 **다른 이유로** 참이 된다 —
   *   그러면 이 파일 전체가 반공허해진다.
   */
  const AT2 = new Date().toISOString();

  it("detected_via='seed' 인데 seeded=0 인 행도 발송되지 않는다 (앞쪽 절반)", async () => {
    const { app, fake } = await boot(() => undefined, {
      seed: (db) => {
        db.prepare(
          `INSERT INTO announcement_ledger(kind, event_key, detected_via, claimed_at, seeded)
           VALUES('youtube_upload','HALFA','seed',?,0)`,
        ).run(AT2);
      },
    });

    // ★ 반공허 가드: 그 행이 **미발송으로 존재**해야 이 테스트가 의미를 갖는다.
    //   `pendingRetries` 로 보지 않는다 — 회수 창은 이제 시드 표식을 SQL 에서 거르므로
    //   창의 크기·정렬이라는 무관한 변수에 이 단언이 묶인다.
    expect(app.ledger.get('youtube_upload', 'HALFA')?.announcedAt).toBeUndefined();

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

    expect(app.ledger.get('youtube_upload', 'HALFB')?.announcedAt).toBeUndefined();

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


describe('★ 빌드 산출물 — 마이그레이션 .sql 이 dist 까지 따라간다', () => {
  /**
   * ★★ 실배포에서 실제로 밟은 함정이다 (2026-09-08).
   *
   *   `migrate.ts` 는 **자기 파일 기준**으로 `migrations` 디렉터리를 찾는다:
   *       join(dirname(fileURLToPath(import.meta.url)), 'migrations')
   *   경로 해석 자체는 옳다 — `dist/store/migrate.js` 옆의 `dist/store/migrations` 를 본다.
   *   그런데 **`tsc` 는 `.ts` 만 컴파일하고 `.sql` 은 복사하지 않는다.** 그래서
   *   `npm run build` 만으로는 그 디렉터리가 생기지 않고, 기동이 exit 70 으로 죽는다:
   *       ENOENT: no such file or directory, scandir '.../dist/store/migrations'
   *
   * ★ 이 테스트들이 왜 못 잡았나: 모든 테스트가 `src/store/migrations/001_init.sql` 을
   *   **직접 읽는다.** vitest 는 `src` 를 그대로 돌리므로 dist 레이아웃을 한 번도 지나지
   *   않는다. 그래서 "스키마는 맞는데 배포하면 안 뜨는" 구간이 통째로 사각이었다.
   *
   * → 그래서 여기서 **빌드 스크립트 자체**를 본다. 산출물이 아니라 산출 규칙을 거는 것이
   *   테스트가 빌드를 돌리지 않고도 회귀를 막는 유일한 자리다.
   */
  it('build 스크립트가 마이그레이션 .sql 을 dist 로 복사한다', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const build = pkg.scripts?.build ?? '';
    expect(build, 'build 스크립트가 없다').not.toBe('');
    // ★ 반공허 가드 — 컴파일 단계가 사라져도 여기서 걸린다
    expect(build).toContain('tsc');
    expect(build, 'tsc 는 .sql 을 복사하지 않는다 — 복사 단계가 빠졌다').toContain(
      'dist/store/migrations',
    );
  });

  it('★ src 에 있는 .sql 이 하나라도 있다 — 복사할 것이 없으면 위 검사가 공짜로 통과한다', () => {
    const files = readdirSync('src/store/migrations').filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain('001_init.sql');
  });
});

describe('★★ 늦어서 내용이 틀려진 공지는 보내지 않고 종결한다', () => {
  /**
   * ★★ 이 블록이 지키는 문장: **원장에 행이 남아 있다고 언제까지나 보내도 되는 것은 아니다.**
   *
   *   §3-a 는 *"늦게 보내기(1위) > 안 보내기(2위)"* 라고 했지만, 그것은 **내용이 여전히
   *   참일 때** 성립한다. 이미 끝난 방송의 "지금 시작되었습니다" 는 늦은 공지가 아니라
   *   **틀린 공지**(3위)다. 그래서 라이브만 규칙이 다르다.
   */
  const fresh = (): string => new Date().toISOString();
  const daysAgo = (n: number): string => new Date(Date.now() - n * 24 * 3600 * 1_000).toISOString();

  it('★★ 이미 끝난 방송의 시작 공지는 나가지 않고 종결된다', async () => {
    const { app, fake } = await boot(() => undefined, {
      seed: (db) => {
        db.prepare(
          `INSERT INTO announcement_ledger(kind, event_key, detected_via, claimed_at, seeded)
           VALUES('live_start','ENDEDHASH','webhook',?,0)`,
        ).run(fresh());
        db.prepare(
          `INSERT INTO live_sessions(live_hash, open_date, opened_at, live_title, status,
                                     first_seen_at, closed_at)
           VALUES('ENDEDHASH','2026-09-08 22:00:13','2026-09-08T13:00:13.000Z',
                  '[82일] 누워서 침 뱉어본사람?','ended',?,?)`,
        ).run(daysAgo(2), daysAgo(2));
      },
    });

    // ★ 반공허는 아래 `isSuppressed` 가 맡는다 — 굶어서 안 나간 것이라면 그 값이
    //   false 다(행이 손대지 않은 채 남는다). 기동 자체가 아웃박스를 한 바퀴 돌리므로
    //   여기서 `pendingRetries` 를 미리 보면 이미 종결된 뒤라 항상 비어 있다.
    await app.outbox.runOnce();
    await flush();

    expect(fake.sent.filter((m) => JSON.stringify(m).includes('ENDEDHASH'))).toHaveLength(0);
    const row = app.ledger.get('live_start', 'ENDEDHASH');
    expect(isSuppressed(row!), '보내지도 종결하지도 않았다').toBe(true);
    expect(row?.lastError).toContain('방송이 이미 끝나');
    // ★ 종결됐으니 다음 틱에 다시 집히지 않는다 — 이것이 창을 비운다.
    expect(app.ledger.pendingRetries(100).some((r) => r.eventKey === 'ENDEDHASH')).toBe(false);
  });

  it('★ 진행 중인 방송은 그대로 나간다 — 규칙이 정상 건을 막지 않는다', async () => {
    const { app, fake } = await boot(() => undefined, {
      seed: (db) => {
        db.prepare(
          `INSERT INTO announcement_ledger(kind, event_key, detected_via, claimed_at, seeded)
           VALUES('live_start','LIVEHASH','webhook',?,0)`,
        ).run(fresh());
        db.prepare(
          `INSERT INTO live_sessions(live_hash, open_date, opened_at, status, first_seen_at)
           VALUES('LIVEHASH','2026-09-10 22:00:13','2026-09-10T13:00:13.000Z','live',?)`,
        ).run(fresh());
      },
    });

    await app.outbox.runOnce();
    await flush();
    expect(fake.sent.length).toBeGreaterThan(0);
    expect(isSuppressed(app.ledger.get('live_start', 'LIVEHASH')!)).toBe(false);
  });

  it('★★ 이틀 지난 업로드 공지도 나가지 않고 종결된다', async () => {
    const { app, fake } = await boot(() => undefined, {
      seed: (db) => {
        db.prepare(
          `INSERT INTO announcement_ledger(kind, event_key, detected_via, claimed_at, seeded)
           VALUES('youtube_upload','STALEVID','rss',?,0)`,
        ).run(daysAgo(2));
      },
    });

    await app.outbox.runOnce();
    await flush();

    expect(fake.sent.filter((m) => JSON.stringify(m).includes('STALEVID'))).toHaveLength(0);
    const row = app.ledger.get('youtube_upload', 'STALEVID');
    expect(isSuppressed(row!)).toBe(true);
    expect(row?.lastError).toContain('시간을 넘겨');
  });
});
