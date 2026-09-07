import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createMemoryAlertState, createOpsAlertService } from '../../src/runtime/alerts/ops-alert-service.js';
import type { Notifier } from '../../src/runtime/alerts/discord-webhook.js';
import { SYSTEM_SCOPE } from '../../src/runtime/alerts/types.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { openDb, type Db } from '../../src/store/db.js';
import { migrate } from '../../src/store/migrate.js';
import { createVerificationSessionRepo } from '../../src/store/repos/verification-session-repo.js';
import { AUTH_PENDING_MAX_ALERT, createVerificationSessionStore } from '../../src/web/session.js';

/**
 * ★★ §5.6.2 — `MAX_PENDING` 도달이 **실제로 운영 채널에 도달하는지** 판정한다.
 *
 * rev.2 는 상한을 넘기면 *"가장 오래된 것부터 폐기"* 만 했다. 그 설계의 문제는
 * 폐기가 아니라 **침묵**이다 — 누가 `/인증` 을 512번 눌러 대기열을 채워도
 * 지표에도 로그에도 아무 흔적이 없다. **관측되지 않는 공격은 없는 것과 같다.**
 *
 * 그래서 이 테스트는 세 이음매를 한꺼번에 본다:
 *   ① 저장소가 상한 도달을 알린다
 *   ② 그 알림이 `auth_pending_max` 경보로 나간다
 *   ③ ★ 그 종류가 `alert_state` 의 CHECK 목록에 실재한다
 *      (없으면 INSERT 가 실패하는데, 하필 **경보를 보내려던 순간**이라 조용히 사라진다)
 */

const START = Date.parse('2026-09-07T00:00:00.000Z');

let db: Db;

beforeEach(() => {
  db = openDb({ path: ':memory:' });
  migrate(db);
});

afterEach(() => {
  db.close();
});

it('★ 상한 도달 → auth_pending_max 경보가 실제로 발송된다', async () => {
  const sent: string[] = [];
  const notifier: Notifier = {
    send: (message) => {
      sent.push(message);
      return Promise.resolve('sent');
    },
  };
  const clock = new ManualClock(START);
  const alerts = createOpsAlertService({
    notifier,
    state: createMemoryAlertState(),
    clock,
    scope: SYSTEM_SCOPE,
    minIntervalMin: 30,
  });

  const raised: Promise<unknown>[] = [];
  const sessions = createVerificationSessionStore({
    repo: createVerificationSessionRepo(db),
    clock,
    sessionTtlMin: 10,
    maxPending: 2,
    onPendingMax: (info) => {
      raised.push(
        alerts.raise(
          AUTH_PENDING_MAX_ALERT,
          `인증 대기열이 상한에 도달했습니다 (${String(info.pending)}/${String(info.maxPending)}). ` +
            `가장 오래된 ${String(info.dropped)}건을 폐기했습니다.`,
        ),
      );
    },
  });

  sessions.issue('u1');
  clock.advance(1_000);
  sessions.issue('u2');
  expect(sent).toHaveLength(0);

  clock.advance(1_000);
  sessions.issue('u3');
  await Promise.all(raised);

  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain('인증 대기열이 상한에 도달했습니다 (2/2)');
  expect(sent[0]).toContain('1건을 폐기');
});

describe('★ 경보 종류가 DB CHECK 목록에 실재한다', () => {
  it("alert_state 가 'auth_pending_max' 를 받아들인다", () => {
    expect(() => {
      db.prepare(
        'INSERT INTO alert_state (scope, alert_kind, last_sent_at) VALUES (?, ?, ?)',
      ).run(SYSTEM_SCOPE, AUTH_PENDING_MAX_ALERT, '2026-09-07T00:00:00.000Z');
    }).not.toThrow();
  });

  it('목록에 없는 종류는 거부된다 — 이 CHECK 가 실제로 살아 있다는 증거', () => {
    expect(() => {
      db.prepare('INSERT INTO alert_state (scope, alert_kind) VALUES (?, ?)').run(
        SYSTEM_SCOPE,
        'auth_pending_maxx',
      );
    }).toThrow(/CHECK/i);
  });
});
