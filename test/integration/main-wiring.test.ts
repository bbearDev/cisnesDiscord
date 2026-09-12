import { createServer, type Server } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
  bootstrap,
  cacheRoleLookup,
  createGateGateway,
  LOCK_ERROR_EXIT_CODE,
  type RoleCacheSource,
} from '../../src/main.js';
import { createFakeChzzkbot } from '../e2e/harness/fake-chzzkbot.js';
import { createFakeDiscord } from '../e2e/harness/fake-discord.js';
import { GATE_CHANNEL_COMMAND_NAME } from '../../src/discord/commands/gate-channel.js';
import {
  AUTH_PANEL_BUTTON_LINK,
  AUTH_PANEL_BUTTON_STATUS,
  AUTH_PANEL_STATE_KEY,
} from '../../src/discord/panel.js';
import { CHZZKBOT_WEBHOOK_PATH } from '../../src/web/routes/chzzkbot-webhook.js';
import {
  OAUTH_CALLBACK_PATH,
  OAUTH_START_PATH,
} from '../../src/web/routes/oauth-callback.js';
import { WEBSUB_PATH } from '../../src/web/routes/websub.js';
import { BIND_ERROR_EXIT_CODE } from '../../src/web/server.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { createAnnouncementLedgerRepo } from '../../src/store/repos/announcement-ledger-repo.js';
import { createLiveSessionRepo } from '../../src/store/repos/live-session-repo.js';
import { topicUrl } from '../../src/youtube/websub-client.js';
import {
  AIGOM,
  API_TOKEN,
  ATOM_FEED,
  ENV,
  GATE_CHANNEL,
  GUILD,
  LIVE_CHANNEL,
  SIS,
  VERIFIED_ROLE,
  YT_CHANNEL,
  boot,
  cleanups,
  flush,
  freePort,
  seedDb,
  writeConfig,
} from '../helpers/app-harness.js';

/**
 * ★★ US-007 — composition-root 배선 (계획 §S8).
 *
 * 이 계층이 확인하는 것은 **모듈의 동작이 아니라 배선의 존재**다.
 * 각 모듈은 이미 자기 계층에서 검증됐고, 여기서 깨지는 것은 언제나
 * *"만들어는 놨는데 꽂지 않았다"* 다 — 그리고 그 결함은 **침묵한다.**
 * 라우트가 등록되지 않으면 404 가 나고, 복구가 ops 를 안 쓰면 기록이 0 건인데,
 * 둘 다 겉으로는 "조용히 잘 도는 것" 과 구분되지 않는다.
 *
 * ★ 실제 소켓을 연다. 라우트 표에 있다는 것과 그 주소로 요청이 닿는다는 것은
 *   다른 사실이고, 우리가 필요한 것은 뒤쪽이다.
 * ★ 시간은 주입한다(`ManualClock`) — 주기 폴러가 스스로 돌면 "복구가 센 값" 과
 *   "폴러가 센 값" 을 가를 수 없다. 같은 이유로 `bootstrap()` 은 복구까지만 하고
 *   폴러는 `app.start()` 가 켠다.
 */


// ══════════════════════════════════════════════════════════════════
//  ① 라우트 — 표에 있는 것과 그 주소로 닿는 것은 다른 사실이다
// ══════════════════════════════════════════════════════════════════

describe('라우트 등록 (§5.4 인입 표)', () => {
  it('★ 계획이 정한 다섯 인입이 전부 라우트 표에 있다', async () => {
    const { app } = await boot();
    const table = app.routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(table).toEqual(
      [
        `GET /healthz`,
        `POST ${CHZZKBOT_WEBHOOK_PATH}`,
        `GET ${OAUTH_START_PATH}`,
        `GET ${OAUTH_CALLBACK_PATH}`,
        `GET ${WEBSUB_PATH}`,
        `POST ${WEBSUB_PATH}`,
      ].sort(),
    );
  });

  it('★★ 실제로 연 포트로 여섯 인입이 전부 닿는다 (404 가 아니다)', async () => {
    // 유튜브 채널을 하나 두고 아웃바운드만 가짜로 돌린다 — `/websub` 검증 GET 은
    // 설정에 있는 채널이어야 200 을 주므로, 이 배선까지 함께 확인된다.
    const fetchImpl: typeof fetch = (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('youtube.com')) {
        return Promise.resolve(new Response(ATOM_FEED, { status: 200 }));
      }
      if (url.includes('pubsubhubbub')) return Promise.resolve(new Response('', { status: 202 }));
      return globalThis.fetch(input, init);
    };
    const { app, fake } = await boot(
      (u) => {
        u.loadLiveFixture('chzzkbot/api-live-2channels-idle.json');
      },
      { fetchImpl, youtube: true },
    );
    const base = app.baseUrl;

    // GET /healthz — 스키마 버전이 실려야 DB 배선까지 확인된다
    const health = await fetch(`${base}/healthz`);
    const healthBody = (await health.json()) as { schemaVersion: number | null };
    expect([200, 503]).toContain(health.status);
    expect(healthBody.schemaVersion).toBe(1);

    // POST /hooks/chzzkbot/live — 토큰 없이 → 401 (라우트가 없으면 404 다)
    const webhook = await fetch(`${base}${CHZZKBOT_WEBHOOK_PATH}`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(webhook.status).toBe(401);

    // GET /oauth/start — 모르는 state → 400
    expect((await fetch(`${base}${OAUTH_START_PATH}?s=nope`)).status).toBe(400);

    // GET /oauth/callback — state 없이 → 400 (★ 교환 이전에 거절된다)
    expect((await fetch(`${base}${OAUTH_CALLBACK_PATH}`)).status).toBe(400);

    // GET /websub — 허브의 검증. ★ channel 은 `?channel=UC…` 로 온다
    const verify = new URL(`${base}${WEBSUB_PATH}`);
    verify.searchParams.set('channel', YT_CHANNEL);
    verify.searchParams.set('hub.mode', 'subscribe');
    verify.searchParams.set('hub.topic', topicUrl(YT_CHANNEL));
    verify.searchParams.set('hub.challenge', 'echo-me');
    verify.searchParams.set('hub.lease_seconds', '432000');
    const verified = await fetch(verify);
    expect(verified.status).toBe(200);
    // 챌린지를 **그대로** 돌려준다. 감싸면 허브가 거절한다.
    expect(await verified.text()).toBe('echo-me');

    // POST /websub — 모르는 채널이어도 계약대로 202 (라우트가 없으면 404 다)
    const push = await fetch(`${base}${WEBSUB_PATH}`, { method: 'POST', body: '<feed/>' });
    expect(push.status).toBe(202);

    // 여기까지 공지는 한 건도 나가지 않았다 (첫 기동 시딩 · 방송 없음).
    expect(fake.sent).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  ② 기동 복구 (§S7 · US-006 의 마지막 배선)
// ══════════════════════════════════════════════════════════════════

describe('기동 복구 — 라이브', () => {
  it('live:false (평상시) → 공지 0건 · 원장 0행', async () => {
    const { app, fake } = await boot((u) => {
      u.loadLiveFixture('chzzkbot/api-live-2channels-idle.json');
    });
    expect(fake.sent).toHaveLength(0);
    expect(app.ledger.get('live_start', 'df09256e')).toBeUndefined();
    // ★ ended 는 **성공한 관측**이다. unknown 스트릭이 오르면 안 된다.
    expect(app.stuckWatch.value('live-api-unknown', SIS, 0)).toBe(0);
  });

  it("★★ announce → 공지 정확히 1건 · detected_via='recovery'", async () => {
    const { app, fake } = await boot((u) => {
      u.loadLiveFixture('chzzkbot/api-live-announce.json');
    });

    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.channelId).toBe(LIVE_CHANNEL);

    const row = app.ledger.get('live_start', 'df09256e');
    expect(row?.detectedVia).toBe('recovery');
    // ★ 발송까지 끝났으면 원장에 messageId 가 남는다 — 아웃박스가 다시 집지 않는다.
    expect(row?.messageId).toBe(fake.sent[0]?.messageId);
    expect(row?.announcedAt).toBeDefined();
    // ★★ B-1 — 라이브 경로에는 `seeded` 를 세우지 않는다.
    expect(row?.seeded).toBe(false);
    expect(app.ledger.pendingRetries()).toHaveLength(0);
  });

  it('★ 폴러가 다시 돌아도 두 번째 공지는 없다 (원장이 막는다)', async () => {
    const { app, fake } = await boot((u) => {
      u.loadLiveFixture('chzzkbot/api-live-announce.json');
    });
    expect(fake.sent).toHaveLength(1);

    const tick = await app.livePoller.poll();
    expect(tick.announced).toBe(false);
    expect(fake.sent).toHaveLength(1);
  });

  it('★★ 조회 실패(500) → 공지 0건 + ops_events 1건 + unknown 스트릭 1회차', async () => {
    const { app, fake, clock } = await boot((u) => {
      u.loadLiveFixture('chzzkbot/api-live-announce.json');
      u.setStatus(500);
    });

    // (0) 공지는 없다 — 모른다를 announce 로도 ended 로도 접지 않는다.
    expect(fake.sent).toHaveLength(0);

    // (a) 운영 기록 1건. 없으면 "기동할 때마다 조용히 실패" 를 아무도 못 읽는다.
    expect(app.ops.count('recovery_live_unknown')).toBe(1);
    expect(app.ops.count()).toBe(1);
    expect(app.ops.list('recovery_live_unknown')[0]?.detail).toContain('transport');

    // (b) unknown 연속 카운터의 **1회차**. 지속되면 AC-P2 가 사람을 부른다.
    expect(app.stuckWatch.value('live-api-unknown', SIS, clock.now())).toBe(1);
  });

  it('★ 조회 실패가 이어지면 임계(5회)에서 AC-P2 경보가 난다 — 복구가 1회차를 세기 때문이다', async () => {
    const { app, clock, alertEvents } = await boot((u) => {
      u.loadLiveFixture('chzzkbot/api-live-announce.json');
      u.setStatus(503);
    });
    expect(app.stuckWatch.value('live-api-unknown', SIS, clock.now())).toBe(1);

    // 복구가 1회차를 셌으므로 폴 4회로 임계 5에 닿는다.
    for (let i = 0; i < 4; i++) await app.livePoller.poll();
    await flush();

    expect(app.stuckWatch.value('live-api-unknown', SIS, clock.now())).toBe(5);
    expect(alertEvents.filter((e) => e.kind === 'live_api_unknown')).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════
//  ③ AD-1 보호 목록
// ══════════════════════════════════════════════════════════════════

describe('AD-1 보호 목록', () => {
  it('★ [live.channelId] ∪ chzzkbot 서빙 채널 — 기동 조회에서 즉시 채워진다', async () => {
    const { app } = await boot((u) => {
      u.loadLiveFixture('chzzkbot/api-live-announce.json');
    });
    // 아이곰은 우리 대상이 아니지만 chzzkbot 이 서빙 중이다 —
    // 그 채널의 토큰을 revoke 하면 상류 팔로워 검증이 통째로 멈춘다.
    expect([...app.protectedChannelIds].sort()).toEqual([AIGOM, SIS].sort());
  });

  it('조회가 실패하면 우리 채널만 남는다 (모르는 것을 목록에 넣지 않는다)', async () => {
    const { app } = await boot((u) => {
      u.setStatus(500);
    });
    expect([...app.protectedChannelIds]).toEqual([SIS]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  ④ 인증 배선
// ══════════════════════════════════════════════════════════════════

describe('인증 (§S4)', () => {
  it('★★ onPendingMax 가 실제로 경보 서비스까지 닿는다 (§5.6.2)', async () => {
    const { app, alertEvents, sent } = await boot(
      (u) => {
        u.loadLiveFixture('chzzkbot/api-live-2channels-idle.json');
      },
      { maxPending: 1 },
    );

    app.sessions.issue('user-1');
    // 두 번째 발급이 상한(1)에 닿는다 — 폐기하되 **알린다.**
    app.sessions.issue('user-2');
    await flush();

    // ★ 종류는 `web/session.ts` 가 export 한 상수여야 한다. 문자열을 직접 적으면
    //   alert_state CHECK 와 어긋난 값이 들어가고, 그 실패가 하필 경보 순간에 난다.
    const raised = alertEvents.filter((e) => e.kind === 'auth_pending_max');
    expect(raised).toHaveLength(1);
    // 스코프는 guild_config 의 길드다 — 시스템 버킷에 섞이면 안 된다.
    expect(raised[0]?.scope).toBe(GUILD);
    expect(raised[0]?.outcome).toBe('sent');
    expect(sent.join('\n')).toContain('인증 대기가 상한에 도달');
    // 게이트 지표도 함께 오른다.
    expect(app.authGuard.rejected['pending-max']).toBe(1);
    // ★ 그리고 실제로 DB 에 남는다 (재기동을 넘어 디바운스가 살아남는 근거).
    expect(
      app.alertState.list().some((r) => r.alertKind === 'auth_pending_max' && r.scope === GUILD),
    ).toBe(true);
  });

  it('★ 인증 버튼이 조립돼 있고 답장의 Link 버튼이 우리 /oauth/start 를 가리킨다', async () => {
    const { app } = await boot((u) => {
      u.loadLiveFixture('chzzkbot/api-live-2channels-idle.json');
    });
    const reply = await app.dispatchButton(AUTH_PANEL_BUTTON_LINK, { guildId: GUILD, userId: 'user-9' });
    expect(reply.ephemeral).toBe(true);
    // ★ 본문에는 URL 이 없다 — 크롤러가 가져갈 것이 없다.
    expect(reply.content).not.toContain(OAUTH_START_PATH);
    const button = reply.components?.[0]?.components[0];
    expect(button !== undefined && 'url' in button ? button.url : undefined).toContain(
      `https://cisnes.example${OAUTH_START_PATH}?s=`,
    );
  });

  it('[내 연동 상태] 버튼은 본인 조회다', async () => {
    const { app } = await boot((u) => {
      u.loadLiveFixture('chzzkbot/api-live-2channels-idle.json');
    });
    const reply = await app.dispatchButton(AUTH_PANEL_BUTTON_STATUS, { guildId: GUILD, userId: 'user-9' });
    expect(reply.ephemeral).toBe(true);
    expect(reply.content).toContain('아직 연동돼 있지 않습니다');
  });

  it('모르는 custom_id 에도 답한다 — 옛 패널의 버튼', async () => {
    const { app } = await boot((u) => {
      u.loadLiveFixture('chzzkbot/api-live-2channels-idle.json');
    });
    const reply = await app.dispatchButton('cisnes:auth:old', { guildId: GUILD, userId: 'user-9' });
    expect(reply.content).toContain('더 이상 쓰이지 않습니다');
  });

  it('★★ 슬래시로 등록되는 것은 운영자용 셋뿐이다 — `인증` 은 없다', async () => {
    const { app } = await boot((u) => {
      u.loadLiveFixture('chzzkbot/api-live-2channels-idle.json');
    });
    expect([...app.commands.keys()].sort()).toEqual(['연동상태', '연동해제', GATE_CHANNEL_COMMAND_NAME].sort());
    expect([...app.buttons.keys()].sort()).toEqual([AUTH_PANEL_BUTTON_LINK, AUTH_PANEL_BUTTON_STATUS].sort());
    // 운영자용 셋 전부 Manage Guild 로 노출이 막힌다
    for (const c of app.commands.values()) {
      expect(c.definition.default_member_permissions, c.definition.name).toBe('32');
    }
    // 응답 전에 REST 를 부를 수 있는 것만 defer 다 — `/인증채널`(패널 게시) · `인증` 버튼(역할 재부여)
    expect(app.commands.get(GATE_CHANNEL_COMMAND_NAME)?.defer).toBe(true);
    expect(app.commands.get('연동해제')?.defer).toBeUndefined();
    expect(app.buttons.get(AUTH_PANEL_BUTTON_LINK)?.defer).toBe(true);
    expect(app.buttons.get(AUTH_PANEL_BUTTON_STATUS)?.defer).toBeUndefined();
  });

  it('★ guild_config 가 없으면 인증을 진행하지 않는다 — 아무 길드나 고르지 않는다', async () => {
    // 길드 설정을 심지 않은 DB 로 띄운다.
    const upstream = createFakeChzzkbot({ token: API_TOKEN });
    await upstream.start();
    cleanups.push(() => upstream.close());
    upstream.loadLiveFixture('chzzkbot/api-live-2channels-idle.json');

    const dir = mkdtempSync(join(tmpdir(), 'cisnes-main-'));
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
      return Promise.resolve();
    });
    const fixture = writeConfig({ dir, port: await freePort(), upstreamBaseUrl: upstream.baseUrl });
    seedDb(fixture.dbPath, false);

    const clock = new ManualClock(Date.now());
    const app = await bootstrap({
      configPath: fixture.configPath,
      env: ENV,
      clock,
      logger: pino({ level: 'silent' }),
      gateway: createFakeDiscord({ now: () => clock.now() }),
      configErrorGraceMs: 0,
    });
    cleanups.push(() => app.stop('test'));

    const issued = app.sessions.issue('user-1');
    const res = await fetch(
      `${app.baseUrl}${OAUTH_CALLBACK_PATH}?state=${issued.state}&code=whatever`,
    );
    // state 검증에서 이미 멈춘다(쿠키가 없다) — 어느 쪽이든 교환까지 가지 않는다.
    expect(res.status).toBe(400);
    expect(app.guildConfig.single()).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════
//  ⑤ 역할 캐시 조회 (AC-12 c)
// ══════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════
//  ④-b 인증 패널 — 게이트 채널의 임베드 + 버튼
// ══════════════════════════════════════════════════════════════════

describe('인증 패널 배선', () => {
  it('★★ start() 가 게이트 채널에 패널을 1회 게시하고 위치를 runtime_state 에 남긴다', async () => {
    const { app, fake } = await boot((u) => {
      u.loadLiveFixture('chzzkbot/api-live-2channels-idle.json');
    });
    expect(fake.sent).toHaveLength(0);
    await app.start();

    const panel = fake.sent.find((m) => m.channelId === GATE_CHANNEL);
    expect(panel, '게이트 채널에 게시된 메시지가 없다').toBeDefined();
    const ids = panel?.payload.components?.[0]?.components.map((c) => ('custom_id' in c ? c.custom_id : '')) ?? [];
    expect(ids).toEqual([AUTH_PANEL_BUTTON_LINK, AUTH_PANEL_BUTTON_STATUS]);
    expect(panel?.payload.embeds?.[0]?.title).toBe('치지직 팔로워 인증');

    expect(app.authPanel.current()).toEqual({ channelId: GATE_CHANNEL, messageId: panel?.messageId });
    expect(JSON.parse(app.runtimeState.get(AUTH_PANEL_STATE_KEY) ?? '{}')).toMatchObject({
      channelId: GATE_CHANNEL,
    });
  });

  it('★ 재기동 — 패널이 있으면 PATCH 1회, POST 0회 (둘이 되지 않는다)', async () => {
    const { app, fake } = await boot((u) => {
      u.loadLiveFixture('chzzkbot/api-live-2channels-idle.json');
    });
    await app.start();
    const first = app.authPanel.current();
    expect(first).toBeDefined();
    const sentBefore = fake.sent.length;

    // 같은 DB 로 다시 "기동" 한 것과 같다 — keeper 가 저장된 위치를 읽어 PATCH 한다.
    const again = await app.authPanel.ensure(GATE_CHANNEL);
    expect(again.outcome).toBe('updated');
    expect(fake.sent).toHaveLength(sentBefore);
    expect(fake.edited).toHaveLength(1);
    expect(fake.edited[0]?.messageId).toBe(first?.messageId);
  });

  it('★ 누가 패널을 지웠으면(404) 새로 게시하고 위치를 갱신한다', async () => {
    const { app, fake } = await boot((u) => {
      u.loadLiveFixture('chzzkbot/api-live-2channels-idle.json');
    });
    await app.start();
    const first = app.authPanel.current();
    fake.forgetMessage(first?.messageId ?? '');
    const sentBefore = fake.sent.length;

    const again = await app.authPanel.ensure(GATE_CHANNEL);
    expect(again.outcome).toBe('posted');
    expect(fake.sent).toHaveLength(sentBefore + 1);
    expect(app.authPanel.current()?.messageId).not.toBe(first?.messageId);
  });

  it('★ /인증채널 — 운영자가 채널을 바꾸면 저장하고 그 자리에서 게시한다', async () => {
    const { app, fake } = await boot((u) => {
      u.loadLiveFixture('chzzkbot/api-live-2channels-idle.json');
    });
    await app.start();
    const NEW_CHANNEL = '666666666666666666';

    // 운영자가 아니면 거부
    const denied = await app.dispatchCommand(GATE_CHANNEL_COMMAND_NAME, {
      guildId: GUILD,
      userId: 'member',
      isOperator: false,
      targetChannelId: NEW_CHANNEL,
    });
    expect(denied.content).toContain('운영자만');

    const reply = await app.dispatchCommand(GATE_CHANNEL_COMMAND_NAME, {
      guildId: GUILD,
      userId: 'ops',
      isOperator: true,
      targetChannelId: NEW_CHANNEL,
    });
    expect(reply.content).toContain(`<#${NEW_CHANNEL}> 에 게시했습니다`);
    // 옛 패널은 지우지 않았다는 사실을 말한다
    expect(reply.content).toContain(`<#${GATE_CHANNEL}>`);

    expect(app.guildConfig.single()?.gateChannelId).toBe(NEW_CHANNEL);
    // 다른 컬럼은 그대로다 (COALESCE)
    expect(app.guildConfig.single()?.verifiedRoleId).toBe(VERIFIED_ROLE);
    expect(fake.sent.filter((m) => m.channelId === NEW_CHANNEL)).toHaveLength(1);
    expect(app.authPanel.current()?.channelId).toBe(NEW_CHANNEL);
  });

  it('게이트 채널이 없으면 게시하지 않는다 — 기동은 된다', async () => {
    const { app, fake } = await boot((u) => {
      u.loadLiveFixture('chzzkbot/api-live-2channels-idle.json');
    });
    // 하니스가 심은 gate_channel_id 를 비운다 (upsert 는 COALESCE 라 NULL 로 못 만든다)
    app.db.prepare('UPDATE guild_config SET gate_channel_id = NULL').run();
    await app.start();
    expect(fake.sent.filter((m) => m.channelId === GATE_CHANNEL)).toHaveLength(0);
    expect(app.authPanel.current()).toBeUndefined();
  });
});

describe('hasRole — 캐시 미스는 false 가 아니다', () => {
  const source: RoleCacheSource = {
    guilds: {
      cache: {
        get: (id) =>
          id === GUILD
            ? {
                members: {
                  cache: {
                    get: (userId) =>
                      userId === 'cached'
                        ? { roles: { cache: { has: (roleId) => roleId === VERIFIED_ROLE } } }
                        : undefined,
                  },
                },
              }
            : undefined,
      },
    },
  };

  it('캐시에 있고 역할을 갖고 있으면 true — REST 를 부르지 않는다', () => {
    expect(cacheRoleLookup(source)(GUILD, 'cached', VERIFIED_ROLE)).toBe(true);
  });

  it('캐시에 있고 역할이 없으면 false', () => {
    expect(cacheRoleLookup(source)(GUILD, 'cached', '999')).toBe(false);
  });

  it('★★ 멤버가 캐시에 없으면 undefined 다 (false 로 접지 않는다)', () => {
    // false 로 접으면 "캐시에 없다" 가 "역할이 없다" 로 읽혀 매번 REST 를 부른다.
    const got = cacheRoleLookup(source)(GUILD, 'not-cached', VERIFIED_ROLE);
    expect(got).toBeUndefined();
    expect(got).not.toBe(false);
  });

  it('★ 길드가 캐시에 없어도 undefined 다', () => {
    expect(cacheRoleLookup(source)('999', 'cached', VERIFIED_ROLE)).toBeUndefined();
  });

  it('조회를 꽂지 않으면 hasRole 자체를 두지 않는다 (있는 척하며 false 를 주지 않는다)', () => {
    const bare = createGateGateway(createFakeDiscord());
    expect(Object.hasOwn(bare, 'hasRole')).toBe(false);
    const wired = createGateGateway(createFakeDiscord(), cacheRoleLookup(source));
    expect(typeof wired.hasRole).toBe('function');
  });
});

// ══════════════════════════════════════════════════════════════════
//  ⑥ 기동 순서 — EADDRINUSE → exit 78
// ══════════════════════════════════════════════════════════════════

class InjectedExit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit(${String(code)})`);
    this.name = 'InjectedExit';
    this.code = code;
  }
}

describe('기동 순서 — ① 포트 바인드가 먼저다 (§5.4 rev.3)', () => {
  it('★★ 포트가 계속 점유돼 있으면 exit 78 로 끝낸다 (락도 DB 도 만들지 않는다)', async () => {
    const upstream = createFakeChzzkbot({ token: API_TOKEN });
    await upstream.start();
    cleanups.push(() => upstream.close());

    // 범인이 포트를 붙들고 있다.
    const blocker: Server = createServer();
    const port = await freePort();
    await new Promise<void>((resolve) => {
      blocker.listen(port, '127.0.0.1', () => {
        resolve();
      });
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          blocker.close(() => {
            resolve();
          });
        }),
    );

    const dir = mkdtempSync(join(tmpdir(), 'cisnes-main-'));
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
      return Promise.resolve();
    });
    const fixture = writeConfig({ dir, port, upstreamBaseUrl: upstream.baseUrl });

    // 시간을 주입한다 — 30초를 실제로 기다리면 아무도 이 테스트를 안 돌린다.
    let current = 0;
    const slept: number[] = [];

    const err = await bootstrap({
      configPath: fixture.configPath,
      env: ENV,
      logger: pino({ level: 'silent' }),
      gateway: createFakeDiscord(),
      configErrorGraceMs: 0,
      // ★ 테스트 러너를 죽이지 않고 종료 경로만 확인한다.
      exit: (code: number): never => {
        throw new InjectedExit(code);
      },
      bindRetry: {
        now: () => current,
        sleep: (ms: number): Promise<void> => {
          slept.push(ms);
          current += ms;
          return Promise.resolve();
        },
      },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InjectedExit);
    expect((err as InjectedExit).code).toBe(BIND_ERROR_EXIT_CODE);
    expect(BIND_ERROR_EXIT_CODE).toBe(78);
    // 백오프 1s → 2s → 4s → 8s 를 실제로 탔다.
    expect(slept.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);

    // ★★ ①이 ②·③보다 먼저이므로 **락 파일도 DB 파일도 생기지 않았다.**
    //   순서가 뒤집혀 있었다면 여기서 락을 인수한 채 죽어 다음 기동이 막힌다.
    expect(existsSync(join(dir, 'cisnes.lock'))).toBe(false);
    expect(existsSync(fixture.dbPath)).toBe(false);
  });

  it('종료 코드 상수를 새로 만들지 않았다 (RestartPreventExitStatus=78 70)', () => {
    // 새 코드를 만들면 유닛의 목록을 함께 고쳐야 하고, 그 한 줄을 빠뜨리는 순간
    // 무한 재시작 플래핑이 되살아난다.
    expect(BIND_ERROR_EXIT_CODE).toBe(78);
    expect(LOCK_ERROR_EXIT_CODE).toBe(70);
  });
});

// ══════════════════════════════════════════════════════════════════
//  ⑦ 아웃박스 → 발송기 · ★ seeded 행은 절대 보내지 않는다 (AC-26)
// ══════════════════════════════════════════════════════════════════

describe('아웃박스 (§S3 FM5)', () => {
  it('★★ 미발송 원장 행을 발송기로 회수하고, 시딩 행은 건드리지 않는다', async () => {
    const { app, fake } = await boot(
      (u) => {
        u.loadLiveFixture('chzzkbot/api-live-2channels-idle.json');
      },
      {
        seed: (db) => {
          const ledger = createAnnouncementLedgerRepo(db);
          // 앞 기동이 선점만 하고 죽었다 — 이 행이 회수 대상이다.
          ledger.claim('live_start', 'aaaa1111', '2026-09-06T18:00:00.000Z', 'webhook');
          createLiveSessionRepo(db).record(
            {
              liveHash: 'aaaa1111',
              openDate: '2026-09-07 03:00:00',
              openedAt: '2026-09-06T18:00:00.000Z',
              liveTitle: '지난 방송',
              status: 'live',
            },
            '2026-09-06T18:00:00.000Z',
          );
          // ★★ AC-26 시딩 행. `announced_at` 이 NULL 이라 **회수 대상에 그대로 걸린다** —
          //   보내면 최초 기동 시딩이 과거 영상 도배로 바뀐다.
          ledger.claim('youtube_upload', 'seeded-1', '2026-09-06T18:00:00.000Z', 'seed', {
            seeded: true,
          });
        },
      },
    );

    await vi.waitFor(() => {
      expect(fake.sent).toHaveLength(1);
    });

    // ★ 세션 행이 남아 있으면 제목·시작 시각까지 그대로 되살린다.
    const embed = fake.sent[0]?.payload.embeds?.[0];
    expect(embed?.title).toBe('지난 방송');
    expect(embed?.timestamp).toBe('2026-09-06T18:00:00.000Z');
    expect(app.ledger.get('live_start', 'aaaa1111')?.announcedAt).toBeDefined();

    // ★★ 시딩 행은 한 번도 나가지 않는다.
    await app.outbox.runOnce();
    expect(fake.sent).toHaveLength(1);
    expect(app.ledger.get('youtube_upload', 'seeded-1')?.announcedAt).toBeUndefined();
    expect(app.ledger.get('youtube_upload', 'seeded-1')?.seeded).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  ⑧ 팔로워 게이트 배선 · 아웃바운드 지표 (§5.6.1 · §5.2)
// ══════════════════════════════════════════════════════════════════

/** 상류 팔로워 조회만 가로채고 나머지는 진짜로 보낸다 */
function followerFetch(body: unknown): typeof fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/followers/')) {
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return globalThis.fetch(input, init);
  };
}

describe('팔로워 게이트 배선 (§5.2)', () => {
  it('★★ stale 은 세기만 하고 경보하지 않는다 (armed:false — S1-J 실측 전)', async () => {
    // 상류 스냅샷이 3시간 전이다 → staleAfterMin(150분)을 넘었다.
    const { app, clock, alertEvents } = await boot(
      (u) => {
        u.loadLiveFixture('chzzkbot/api-live-2channels-idle.json');
      },
      {
        fetchImpl: followerFetch({
          channelId: SIS,
          viewerChannelId: 'viewer-1',
          isFollower: true,
          everSynced: true,
          cachedAt: new Date(Date.now() - 180 * 60_000).toISOString(),
        }),
      },
    );

    const lookup = await app.followers.check('viewer-1', clock.now());
    // ★ 신선도 게이트가 `isFollower` 보다 항상 먼저다 — true 여도 보류다.
    expect(lookup.verdict).toBe('unknown');
    expect(lookup.reason).toBe('stale');

    // ★ 스트릭은 오른다 (지표는 남는다).
    expect(app.stuckWatch.value('follower-stale', SIS, clock.now())).toBe(1);
    // ★★ 그러나 경보는 나가지 않는다. 검증 안 된 임계로 경보하면
    //    `stale` 이 지정한 유일한 관측 축이 오탐에 덮인다.
    for (let i = 0; i < 10; i++) {
      expect(app.stuckWatch.observe('follower-stale', SIS, true, clock.now())).toBeUndefined();
    }
    expect(app.stuckWatch.value('follower-stale', SIS, clock.now())).toBe(11);
    expect(alertEvents.filter((e) => e.kind === 'follower_stale')).toHaveLength(0);
  });

  it('★ 신선한 스냅샷이면 스트릭이 리셋된다 (중간에 1회라도 성공하면 리셋)', async () => {
    const { app, clock } = await boot(
      (u) => {
        u.loadLiveFixture('chzzkbot/api-live-2channels-idle.json');
      },
      {
        fetchImpl: followerFetch({
          channelId: SIS,
          viewerChannelId: 'viewer-1',
          isFollower: true,
          everSynced: true,
          cachedAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      },
    );

    app.stuckWatch.observe('follower-stale', SIS, true, clock.now());
    expect(app.stuckWatch.value('follower-stale', SIS, clock.now())).toBe(1);

    const lookup = await app.followers.check('viewer-1', clock.now());
    expect(lookup.verdict).toBe('yes');
    expect(app.stuckWatch.value('follower-stale', SIS, clock.now())).toBe(0);

    // ★ `follower_lookup_ms` 배선 — onLatency 가 지표까지 닿는다.
    expect(app.metrics.lastLatencyMs['follower-lookup']).toBeTypeOf('number');
    expect(app.metrics.latencyCount['follower-lookup']).toBe(1);
  });

  it('★ 회당 타임아웃이 outbound_timeout_total{call} 로 올라간다 (§5.6.1)', async () => {
    // 응답을 영영 주지 않는다 — `AbortSignal` 만이 이 프라미스를 끝낸다.
    const hang: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes('/api/followers/')) return globalThis.fetch(input, init);
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            reject(new DOMException('aborted', 'AbortError'));
          },
          { once: true },
        );
      });
    };
    const { app, clock } = await boot(
      (u) => {
        u.loadLiveFixture('chzzkbot/api-live-2channels-idle.json');
      },
      { fetchImpl: hang },
    );

    // 작업 예산을 짧게 준다 — 회당 타임아웃(3초)과 남은 예산 중 **짧은 쪽**이 쓰인다.
    const lookup = await app.followers.check('viewer-1', clock.now(), {
      deadlineAt: clock.now() + 50,
    });
    // ★ 타임아웃은 `no` 가 아니라 `unknown` 이다.
    expect(lookup.verdict).toBe('unknown');
    expect(lookup.reason).toBe('timeout');
    expect(app.metrics.timeouts['follower-lookup']).toBe(1);
  });
});
