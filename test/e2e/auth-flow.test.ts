import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createFollowerChecker, type FollowerChecker } from '../../src/chzzk/follower-check.js';
import { createViewerTokenClient, type ViewerTokenClient } from '../../src/chzzk/oauth/viewer-token.js';
import { createAuthGuard, type AuthGuard } from '../../src/discord/commands/guard.js';
import { createLinkCommand } from '../../src/discord/commands/link.js';
import { createStatusCommand } from '../../src/discord/commands/status.js';
import { createUnlinkCommand } from '../../src/discord/commands/unlink.js';
import type { SlashCommand } from '../../src/discord/commands/types.js';
import { DiscordSendError } from '../../src/discord/client.js';
import type { GateGateway } from '../../src/discord/gate.js';
import { ManualClock } from '../../src/runtime/clock.js';
import { createHttpBudget } from '../../src/runtime/http-budget.js';
import { openDb, type Db } from '../../src/store/db.js';
import { migrate } from '../../src/store/migrate.js';
import { createLinkRepo, OPS_EVENT_DUPLICATE_CHANNEL, type LinkRepo } from '../../src/store/repos/link-repo.js';
import { createVerificationSessionRepo } from '../../src/store/repos/verification-session-repo.js';
import {
  createOAuthCallbackRoute,
  createOAuthStartRoute,
} from '../../src/web/routes/oauth-callback.js';
import type { Route, RouteRequest, RouteResponse } from '../../src/web/server.js';
import { createVerificationSessionStore, type VerificationSessionStore } from '../../src/web/session.js';

/**
 * ★★ S4 인증 왕복 e2e — `/인증` → `/oauth/start` → 콜백 → 팔로워 판정 → 연동·역할.
 *
 * 여기서 판정하는 것은 **조각이 아니라 이음매**다:
 *   · A 의 state 로 B 가 콜백을 열면 거부되고 **아무것도 바뀌지 않는다** (AC-3)
 *   · 중복 채널 → 거부 + 기존 행 무변화 + 운영 기록 1건 (AC-7·8)
 *   · `setNickname` 실패 → **인증 성공** + 실패 로그 1건 (AC-11)
 *   · `/인증` 5회 → 역할 1개, 오류 0 (AC-12)
 *   · 비팔로워 5명 연속 → 상류 호출 **정확히 5회** (증폭 계수 1)
 *   · 같은 유저 30초 내 4회 → 상류 호출 **1회**
 *   · ★ 인증 후 **DB 전체 grep 에 access token 0건** (AC-10)
 */

const GUILD = '1111111111';
const ROLE = '2222222222';
const OUR_CHANNEL = 'c3355ea2b3bea6c646789510796379d6';
const CHZZK_BASE = 'https://openapi.test';
const CHZZKBOT_BASE = 'http://127.0.0.1:8080';
const PUBLIC_BASE = 'https://cisnes.example.com';

/** ★ 이 값이 DB 어디에도 나타나면 안 된다 (AC-10) */
const ACCESS_TOKEN = 'viewer-access-token-0123456789abcdef';
const REFRESH_TOKEN = 'viewer-refresh-token-0123456789abcdef';

/** 픽스처와 같은 스냅샷 시각 */
const CACHED_AT = '2026-09-06T18:55:00.000Z';
/** 스냅샷 **이전**에 클릭한다 — 그래야 판정표 5(재조회 없음)로 간다 */
const CLICK_AT = Date.parse('2026-09-06T18:54:00.000Z');
const CALLBACK_AT = Date.parse('2026-09-06T18:56:00.000Z');

interface Viewer {
  channelId: string;
  channelName: string;
  isFollower: boolean;
}

interface Env {
  clock: ManualClock;
  db: Db;
  links: LinkRepo;
  sessions: VerificationSessionStore;
  guard: AuthGuard;
  followers: FollowerChecker;
  viewerToken: ViewerTokenClient;
  linkCmd: SlashCommand;
  unlinkCmd: SlashCommand;
  statusCmd: SlashCommand;
  startRoute: Route;
  callbackRoute: Route;
  /** code → 그 코드로 돌아올 시청자 */
  viewers: Map<string, Viewer>;
  counts: { token: number; usersMe: number; revoke: number; follower: number };
  roleGrants: string[];
  nickCalls: (string | null)[];
  logs: { message: string; extra?: Record<string, unknown> }[];
  failNickname: (on: boolean) => void;
  /** 상류 응답에서 cachedAt 을 바꾼다 */
  setCachedAt: (iso: string) => void;
  setEverSynced: (v: boolean) => void;
}

function req(url: string, cookie?: string): RouteRequest {
  return {
    method: 'GET',
    url: new URL(url, 'http://localhost'),
    headers: cookie === undefined ? {} : { cookie },
    body: Buffer.alloc(0),
  };
}

/** 응답의 `Set-Cookie` 에서 nonce 를 꺼내 브라우저 쿠키 헤더로 만든다 */
function cookieFrom(res: RouteResponse): string {
  const raw = res.headers?.['Set-Cookie'];
  const value = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
  const first = value.split(';')[0] ?? '';
  return first;
}

function makeEnv(): Env {
  const clock = new ManualClock(CLICK_AT);
  const db = openDb({ path: ':memory:' });
  migrate(db);

  const links = createLinkRepo(db);
  const sessions = createVerificationSessionStore({
    repo: createVerificationSessionRepo(db),
    clock,
    sessionTtlMin: 10,
    maxPending: 512,
  });
  const guard = createAuthGuard({ clock, cooldownSec: 30, maxConcurrentFlows: 8 });

  const viewers = new Map<string, Viewer>();
  const counts = { token: 0, usersMe: 0, revoke: 0, follower: 0 };
  let cachedAt = CACHED_AT;
  let everSynced = true;
  /** 발급된 access token → 시청자 */
  const issued = new Map<string, Viewer>();

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const fetchImpl = ((url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    const u = new URL(url);

    if (u.href === `${CHZZK_BASE}/auth/v1/token`) {
      counts.token += 1;
      const code = (JSON.parse(init?.body ?? '{}') as { code?: string }).code ?? '';
      const viewer = viewers.get(code);
      if (viewer === undefined) return Promise.resolve(json(400, { code: 400, message: 'bad code' }));
      const token = `${ACCESS_TOKEN}#${code}`;
      issued.set(token, viewer);
      return Promise.resolve(
        json(200, {
          code: 200,
          message: null,
          content: { accessToken: token, refreshToken: REFRESH_TOKEN, expiresIn: 3600 },
        }),
      );
    }

    if (u.href === `${CHZZK_BASE}/open/v1/users/me`) {
      counts.usersMe += 1;
      const bearer = (init?.headers?.['Authorization'] ?? '').replace('Bearer ', '');
      const viewer = issued.get(bearer);
      if (viewer === undefined) return Promise.resolve(json(401, { code: 401 }));
      return Promise.resolve(
        json(200, {
          code: 200,
          content: { channelId: viewer.channelId, channelName: viewer.channelName },
        }),
      );
    }

    if (u.href === `${CHZZK_BASE}/auth/v1/token/revoke`) {
      counts.revoke += 1;
      return Promise.resolve(json(200, { code: 200 }));
    }

    if (u.pathname.startsWith('/api/followers/')) {
      counts.follower += 1;
      const parts = u.pathname.split('/');
      const channelId = parts[3] ?? '';
      const viewerChannelId = parts[4] ?? '';
      const viewer = [...viewers.values()].find((v) => v.channelId === viewerChannelId);
      return Promise.resolve(
        json(200, {
          channelId,
          viewerChannelId,
          isFollower: viewer?.isFollower ?? false,
          everSynced,
          cachedAt,
        }),
      );
    }

    return Promise.resolve(json(404, { code: 404 }));
  }) as unknown as typeof fetch;

  // ★ http-budget 의 시계를 ManualClock 에 맞춘다. 아니면 왕복 예산이
  //   실제 시각과 어긋나 매번 budget 초과가 된다.
  const budget = createHttpBudget({ fetchImpl, now: () => clock.now() });

  const viewerToken = createViewerTokenClient({
    budget,
    clientId: 'cisnes-client',
    clientSecret: 'cisnes-secret',
    baseUrl: CHZZK_BASE,
    // AD-1 — 보호 목록. 우리 감지 채널은 revoke 하지 않는다
    protectedChannelIds: [OUR_CHANNEL],
  });

  const followers = createFollowerChecker({
    budget,
    baseUrl: CHZZKBOT_BASE,
    token: 'a'.repeat(32),
    channelId: OUR_CHANNEL,
    staleAfterMin: 150,
    clock,
  });

  const roleGrants: string[] = [];
  const nickCalls: (string | null)[] = [];
  const held = new Set<string>();
  let nicknameFails = false;

  const gateway: GateGateway = {
    addRole(guildId, userId, roleId): Promise<void> {
      roleGrants.push(`${guildId}:${userId}:${roleId}`);
      held.add(`${guildId}:${userId}:${roleId}`);
      return Promise.resolve();
    },
    setNickname(_g, _u, nickname): Promise<void> {
      if (nicknameFails) {
        return Promise.reject(new DiscordSendError('forbidden', '봇보다 높은 역할입니다', 403));
      }
      nickCalls.push(nickname);
      return Promise.resolve();
    },
    hasRole: (g, u, r) => (held.has(`${g}:${u}:${r}`) ? true : undefined),
  };

  const logs: { message: string; extra?: Record<string, unknown> }[] = [];
  const onLog = (message: string, extra?: Record<string, unknown>): void => {
    logs.push(extra === undefined ? { message } : { message, extra });
  };

  const linkCmd = createLinkCommand({
    sessions,
    links,
    guard,
    clock,
    publicBaseUrl: PUBLIC_BASE,
    onLog,
  });
  const unlinkCmd = createUnlinkCommand({ links, clock, onLog });
  const statusCmd = createStatusCommand({ links });

  const startRoute = createOAuthStartRoute({
    sessions,
    clientId: 'cisnes-client',
    redirectUri: `${PUBLIC_BASE}/oauth/callback`,
    sessionTtlMin: 10,
    publicBaseUrl: PUBLIC_BASE,
    onLog,
  });

  const callbackRoute = createOAuthCallbackRoute({
    sessions,
    viewerToken,
    followers,
    links,
    gateway,
    clock,
    resolveGuild: () => ({ guildId: GUILD, verifiedRoleId: ROLE }),
    onLog,
  });

  return {
    clock,
    db,
    links,
    sessions,
    guard,
    followers,
    viewerToken,
    linkCmd,
    unlinkCmd,
    statusCmd,
    startRoute,
    callbackRoute,
    viewers,
    counts,
    roleGrants,
    nickCalls,
    logs,
    failNickname: (on) => {
      nicknameFails = on;
    },
    setCachedAt: (iso) => {
      cachedAt = iso;
    },
    setEverSynced: (v) => {
      everSynced = v;
    },
  };
}

/** `/인증` → 반환된 URL 에서 state 를 뽑는다 */
async function runLink(env: Env, userId: string): Promise<{ content: string; state: string }> {
  const reply = await env.linkCmd.execute({ guildId: GUILD, userId });
  // ★ 링크는 `<...>` 로 감싸 나간다 — 디스코드 크롤러가 /oauth/start 를 가져가
  //   nonce 를 회전시키는 것을 막기 위해서다. `>` 를 state 에 딸려 보내지 않는다.
  const match = /\/oauth\/start\?s=([^\s>]+)/.exec(reply.content);
  return { content: reply.content, state: match?.[1] ?? '' };
}

/** `/oauth/start` — 브라우저가 받는 쿠키를 돌려준다 */
async function runStart(env: Env, state: string): Promise<{ res: RouteResponse; cookie: string }> {
  const res = await env.startRoute.handle(req(`/oauth/start?s=${state}`));
  return { res, cookie: cookieFrom(res) };
}

async function runCallback(
  env: Env,
  state: string,
  code: string,
  cookie: string,
): Promise<RouteResponse> {
  return env.callbackRoute.handle(req(`/oauth/callback?state=${state}&code=${code}`, cookie));
}

/** 한 사람이 처음부터 끝까지 */
async function fullFlow(
  env: Env,
  userId: string,
  viewer: Viewer,
  code = `code-${userId}`,
): Promise<RouteResponse> {
  env.viewers.set(code, viewer);
  const { state } = await runLink(env, userId);
  const { cookie } = await runStart(env, state);
  env.clock.advance(CALLBACK_AT - env.clock.now());
  return runCallback(env, state, code, cookie);
}

let env: Env;

beforeEach(() => {
  env = makeEnv();
});

afterEach(() => {
  env.followers.dispose();
  env.db.close();
});

describe('행복 경로', () => {
  it('팔로워면 연동되고 역할과 닉네임이 붙는다', async () => {
    const res = await fullFlow(env, 'userA', {
      channelId: 'aaaa1111bbbb2222cccc3333dddd4444',
      channelName: '시청자A',
      isFollower: true,
    });

    expect(res.status).toBe(200);
    expect(res.body).toContain('인증이 완료됐습니다');
    expect(env.links.get(GUILD, 'userA')?.chzzkChannelName).toBe('시청자A');
    expect(env.roleGrants).toEqual([`${GUILD}:userA:${ROLE}`]);
    expect(env.nickCalls).toEqual(['시청자A']);
    // 상류 호출은 교환 1 + users/me 1 + 팔로워 1
    expect(env.counts).toMatchObject({ token: 1, usersMe: 1, follower: 1 });
  });

  it('★ AC-10 — 인증 후 DB 전체를 훑어도 access token 이 없다', async () => {
    await fullFlow(env, 'userA', {
      channelId: 'aaaa1111bbbb2222cccc3333dddd4444',
      channelName: '시청자A',
      isFollower: true,
    });
    await env.viewerToken.settled();

    const tables = env.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const dump: string[] = [];
    for (const t of tables) {
      const rows = env.db.prepare(`SELECT * FROM "${t.name}"`).all();
      dump.push(JSON.stringify(rows));
    }
    const all = dump.join('\n');

    expect(all).not.toContain(ACCESS_TOKEN);
    expect(all).not.toContain(REFRESH_TOKEN);
    expect(all).not.toMatch(/accessToken|refreshToken|Bearer/);
    // 그래도 인증은 실제로 일어났다 (빈 DB 를 훑고 통과한 것이 아니다)
    expect(all).toContain('시청자A');
  });

  it('★ AD-1 — 보호 채널은 revoke 를 건너뛴다. 일반 시청자는 revoke 한다', async () => {
    await fullFlow(env, 'userA', {
      channelId: 'aaaa1111bbbb2222cccc3333dddd4444',
      channelName: '시청자A',
      isFollower: true,
    });
    await env.viewerToken.settled();
    expect(env.counts.revoke).toBe(1);
    expect(env.viewerToken.revokeSkipped).toBe(0);

    // 스트리머 본인(= 보호 채널)이 인증하면 revoke 하지 않는다
    await fullFlow(
      env,
      'streamer',
      { channelId: OUR_CHANNEL, channelName: '시스네', isFollower: true },
      'code-streamer',
    );
    await env.viewerToken.settled();
    expect(env.counts.revoke).toBe(1); // 늘지 않았다
    expect(env.viewerToken.revokeSkipped).toBe(1);
  });
});

describe('★★ AC-3 — A 의 state 로 B 가 콜백을 열면 거부되고 아무것도 바뀌지 않는다', () => {
  it('B 의 쿠키는 A 의 nonce 와 다르다 → 400, 교환조차 하지 않는다', async () => {
    env.viewers.set('code-A', {
      channelId: 'aaaa1111bbbb2222cccc3333dddd4444',
      channelName: '시청자A',
      isFollower: true,
    });
    const a = await runLink(env, 'userA');
    await runStart(env, a.state);

    const b = await runLink(env, 'userB');
    const bStart = await runStart(env, b.state);

    env.clock.advance(60_000);
    const res = await runCallback(env, a.state, 'code-A', bStart.cookie);

    expect(res.status).toBe(400);
    // ★★ state 검증이 교환보다 먼저다 — 공격자의 code 가 소모되지 않았다
    expect(env.counts.token).toBe(0);
    expect(env.counts.usersMe).toBe(0);
    expect(env.counts.follower).toBe(0);
    // 무변화
    expect(env.links.get(GUILD, 'userA')).toBeUndefined();
    expect(env.links.get(GUILD, 'userB')).toBeUndefined();
    expect(env.roleGrants).toEqual([]);
  });

  it('★★ 두 사람이 동시에 진행 중일 때, A 의 콜백 결과는 A 에게만 간다 (AC-3 귀속)', async () => {
    // ★ AC-3 의 본질은 대조가 아니라 **귀속**이다. `session.ts` 가 적어 둔 그대로 —
    //   콜백에는 디스코드 신원이 실리지 않으므로, 브라우저를 연 사람이 누구든
    //   결과는 **state 를 발급받은 사람**에게 간다. 그 성질은 대기열에 다른 사람이
    //   있을 때만 실제로 시험된다(혼자면 잘못 귀속돼도 같은 사람이라 티가 안 난다).
    env.viewers.set('code-A', {
      channelId: 'aaaa1111bbbb2222cccc3333dddd4444',
      channelName: '시청자A',
      isFollower: true,
    });
    env.viewers.set('code-B', {
      channelId: 'bbbb2222cccc3333dddd4444eeee5555',
      channelName: '시청자B',
      isFollower: true,
    });

    // 둘 다 진행 중이다 — B 의 state 도 살아 있다
    const a = await runLink(env, 'userA');
    const aStart = await runStart(env, a.state);
    const b = await runLink(env, 'userB');
    await runStart(env, b.state);

    // A 가 자기 state·자기 쿠키로 완주한다
    const res = await runCallback(env, a.state, 'code-A', aStart.cookie);
    expect(res.status).toBeLessThan(400);

    // ★ 결과가 A 에게만 간다
    expect(env.links.get(GUILD, 'userA')?.chzzkChannelName).toBe('시청자A');
    expect(env.roleGrants).toEqual([`${GUILD}:userA:${ROLE}`]);
    // ★★ 대기 중이던 B 는 아무것도 받지 않았다 — 이 줄이 이 테스트의 요점이다.
    expect(env.links.get(GUILD, 'userB')).toBeUndefined();

    // 그리고 B 가 자기 것으로 완주하면 B 는 B 것을 받고 A 는 그대로다
    const bStart2 = await runStart(env, b.state);
    const res2 = await runCallback(env, b.state, 'code-B', bStart2.cookie);
    expect(res2.status).toBeLessThan(400);
    expect(env.links.get(GUILD, 'userB')?.chzzkChannelName).toBe('시청자B');
    expect(env.links.get(GUILD, 'userA')?.chzzkChannelName).toBe('시청자A');
  });

  it('쿠키 없이 콜백을 열면 거부된다', async () => {
    const a = await runLink(env, 'userA');
    await runStart(env, a.state);
    env.clock.advance(60_000);
    const res = await env.callbackRoute.handle(req(`/oauth/callback?state=${a.state}&code=x`));
    expect(res.status).toBe(400);
    expect(env.counts.token).toBe(0);
  });

  it('★★ TTL 을 넘긴 state 는 콜백에서 거부된다 — 교환도 하지 않는다 (AC-3 만료)', async () => {
    // ★ AC-3 은 귀속만이 아니라 **만료**도 명시한다 ("state 는 발급 유저에 귀속되고
    //   만료 시간이 있으며"). 만료가 안 걸리면 오래된 인증 링크가 영원히 유효해진다 —
    //   유출된 URL 이 시간이 지나도 계속 계정을 연다는 뜻이다.
    //
    // ★ 유닛 계층에도 TTL 테스트가 있지만 그쪽은 `consume()` 를 직접 부른다.
    //   여기서는 **실제 콜백 라우트**로 들어와 라우트가 그 판정을 실제로 존중하는지 본다.
    env.viewers.set('code-A', {
      channelId: 'aaaa1111bbbb2222cccc3333dddd4444',
      channelName: '시청자A',
      isFollower: true,
    });
    const a = await runLink(env, 'userA');
    const aStart = await runStart(env, a.state);

    // 발급 후 TTL(기본 10분)을 넘긴다
    env.clock.advance(11 * 60_000);
    const res = await runCallback(env, a.state, 'code-A', aStart.cookie);

    expect(res.status).toBeGreaterThanOrEqual(400);
    // ★★ 만료 판정이 **교환보다 먼저**다 — 공격자의 code 가 소모되지 않는다
    expect(env.counts.token).toBe(0);
    expect(env.counts.usersMe).toBe(0);
    expect(env.counts.follower).toBe(0);
    // 아무것도 바뀌지 않았다
    expect(env.links.get(GUILD, 'userA')).toBeUndefined();
    expect(env.roleGrants).toEqual([]);
  });

  it('★ 같은 state 로 두 번 오면 두 번째는 거부된다 (1회 소모)', async () => {
    const viewer = {
      channelId: 'aaaa1111bbbb2222cccc3333dddd4444',
      channelName: '시청자A',
      isFollower: true,
    };
    env.viewers.set('code-A', viewer);
    const a = await runLink(env, 'userA');
    const start = await runStart(env, a.state);
    env.clock.advance(CALLBACK_AT - env.clock.now());

    const first = await runCallback(env, a.state, 'code-A', start.cookie);
    expect(first.status).toBe(200);
    const second = await runCallback(env, a.state, 'code-A', start.cookie);
    expect(second.status).toBe(400);
    // 두 번째는 상류를 부르지 않았다
    expect(env.counts.token).toBe(1);
    expect(env.roleGrants).toHaveLength(1);
  });

  it('모르는 state 로 /oauth/start 를 열어도 nonce 를 심어주지 않는다', async () => {
    const res = await env.startRoute.handle(req('/oauth/start?s=made-up'));
    expect(res.status).toBe(400);
    expect(res.headers?.['Set-Cookie']).toBeUndefined();
  });
});

describe('★★ AC-7 / AC-8 — 중복 채널', () => {
  it('거부 + 기존 행 무변화 + 운영 기록 1건', async () => {
    const shared = {
      channelId: 'aaaa1111bbbb2222cccc3333dddd4444',
      channelName: '시청자A',
      isFollower: true,
    };
    await fullFlow(env, 'userA', shared, 'code-A');
    const before = env.links.get(GUILD, 'userA');

    const res = await fullFlow(env, 'userB', shared, 'code-B');

    expect(res.status).toBe(409);
    expect(res.body).toContain('이미 이 서버의 다른 계정에 연동');
    expect(env.links.get(GUILD, 'userA')).toEqual(before);
    expect(env.links.get(GUILD, 'userB')).toBeUndefined();
    expect(env.links.opsEvents(OPS_EVENT_DUPLICATE_CHANNEL)).toHaveLength(1);
    // B 에게는 역할이 가지 않았다
    expect(env.roleGrants).toEqual([`${GUILD}:userA:${ROLE}`]);
  });
});

describe('★★ AC-11 — setNickname 실패해도 인증은 성공한다', () => {
  it('역할은 붙고, 실패는 로그 1건으로 남는다', async () => {
    env.failNickname(true);
    const res = await fullFlow(env, 'userA', {
      channelId: 'aaaa1111bbbb2222cccc3333dddd4444',
      channelName: '시청자A',
      isFollower: true,
    });

    expect(res.status).toBe(200);
    expect(env.links.get(GUILD, 'userA')).toBeDefined();
    expect(env.roleGrants).toHaveLength(1);
    expect(env.nickCalls).toHaveLength(0);

    const failures = env.logs.filter((l) => l.message === '게이트 부분 실패');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.extra).toMatchObject({ part: 'nickname', kind: 'forbidden' });
    // 사용자에게도 정직하게 말한다
    expect(res.body).toContain('인증 자체는 정상 완료');
  });
});

describe('★★ AC-12 — 멱등', () => {
  it('/인증 5회 → 역할 1개, 오류 0, state 1개', async () => {
    env.viewers.set('code-A', {
      channelId: 'aaaa1111bbbb2222cccc3333dddd4444',
      channelName: '시청자A',
      isFollower: true,
    });

    const states: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await runLink(env, 'userA');
      states.push(r.state);
    }
    // ★ 진행 중인 흐름이 있으면 같은 URL 을 재제시한다 — 새 state 를 만들지 않는다
    expect(new Set(states).size).toBe(1);
    expect(env.sessions.pendingCount()).toBe(1);

    const start = await runStart(env, states[0] ?? '');
    env.clock.advance(CALLBACK_AT - env.clock.now());
    await runCallback(env, states[0] ?? '', 'code-A', start.cookie);

    expect(env.roleGrants).toHaveLength(1);

    // 이미 연동된 뒤 다시 눌러도 안내만 나온다
    const after = await env.linkCmd.execute({ guildId: GUILD, userId: 'userA' });
    expect(after.content).toContain('이미 치지직 채널');
    expect(after.content).not.toContain('/oauth/start');
    expect(env.roleGrants).toHaveLength(1);
  });

  it('★ 같은 유저가 30초 안에 4번 → 상류 호출 1회', async () => {
    env.viewers.set('code-A', {
      channelId: 'aaaa1111bbbb2222cccc3333dddd4444',
      channelName: '시청자A',
      isFollower: true,
    });
    const first = await runLink(env, 'userA');
    for (let i = 0; i < 3; i++) {
      env.clock.advance(5_000);
      const again = await runLink(env, 'userA');
      expect(again.state).toBe(first.state);
    }

    const start = await runStart(env, first.state);
    env.clock.advance(CALLBACK_AT - env.clock.now());
    await runCallback(env, first.state, 'code-A', start.cookie);

    expect(env.counts.follower).toBe(1);
    expect(env.followers.metrics.lookups).toBe(1);
  });

  it('★ 역할을 이미 갖고 있으면 REST 를 다시 부르지 않는다 (cache.has 선확인)', async () => {
    const viewer = {
      channelId: 'aaaa1111bbbb2222cccc3333dddd4444',
      channelName: '시청자A',
      isFollower: true,
    };
    await fullFlow(env, 'userA', viewer, 'code-A');
    expect(env.roleGrants).toHaveLength(1);

    // 연동을 지우고 같은 사람이 다시 인증한다 — 역할은 이미 있다
    env.links.unlink(GUILD, 'userA');
    env.clock.advance(60_000);
    await fullFlow(env, 'userA', viewer, 'code-A2');

    expect(env.links.get(GUILD, 'userA')).toBeDefined();
    expect(env.roleGrants).toHaveLength(1); // ★ 늘지 않았다
  });
});

describe('★★ 증폭 계수 1 — 인증 1건당 상류 조회 1회', () => {
  it('비팔로워 5명 연속 거부 → 상류 팔로워 조회 정확히 5회', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await fullFlow(
        env,
        `user${String(i)}`,
        {
          channelId: `viewer${String(i)}`.padEnd(32, '0'),
          channelName: `시청자${String(i)}`,
          isFollower: false,
        },
        `code-${String(i)}`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toContain('아직 팔로워로 확인되지 않았습니다');
      env.clock.advance(60_000);
    }

    expect(env.counts.follower).toBe(5);
    expect(env.followers.metrics.lookups).toBe(5);
    expect(env.followers.metrics.rechecks).toBe(0);
    expect(env.roleGrants).toHaveLength(0);
    expect(env.links.count(GUILD)).toBe(0);
  });

  it('★ R-4 — 거부 안내에 스냅샷 시각과 다음 재시도 시각이 둘 다 있다', async () => {
    const res = await fullFlow(env, 'userA', {
      channelId: 'aaaa1111bbbb2222cccc3333dddd4444',
      channelName: '시청자A',
      isFollower: false,
    });
    expect(res.body).toContain('팔로워 목록 스냅샷 기준');
    expect(res.body).toContain('다시 시도 가능한 시각');
    expect(res.body).toContain('최대 10분 뒤');
    // 스냅샷 시각이 실제 cachedAt(2026-09-06 18:55 UTC = 09-07 03:55 KST)이다
    expect(res.body).toContain('2026-09-07 03:55 KST');
  });
});

describe('★★ unknown 은 절대 no 가 되지 않는다', () => {
  it('everSynced:false → 보류 안내. 역할도 거부도 아니다', async () => {
    env.setEverSynced(false);
    const res = await fullFlow(env, 'userA', {
      channelId: 'aaaa1111bbbb2222cccc3333dddd4444',
      channelName: '시청자A',
      isFollower: true,
    });

    expect(res.status).toBe(200);
    expect(res.body).toContain('확인하지 못했습니다');
    expect(res.body).not.toContain('팔로우한 뒤 다시');
    expect(env.roleGrants).toHaveLength(0);
    expect(env.links.count(GUILD)).toBe(0);
    expect(env.followers.metrics.unknownByReason['not-synced']).toBe(1);

    // ★ DB 에도 unknown 으로 남는다 — 0(미팔로우)이 아니다
    const row = env.db
      .prepare('SELECT result, is_follower FROM verification_sessions')
      .get() as { result: string; is_follower: number | null };
    expect(row.result).toBe('unknown');
    expect(row.is_follower).toBeNull();
  });

  it('★ 낡은 스냅샷 + isFollower:true → 보류. 역할을 주지 않는다', async () => {
    // 클릭 시각 18:54 기준 **234분 전** — `staleAfterMin`(150) 을 훌쩍 넘는다.
    env.setCachedAt('2026-09-06T15:00:00.000Z');
    const res = await fullFlow(env, 'userA', {
      channelId: 'aaaa1111bbbb2222cccc3333dddd4444',
      channelName: '시청자A',
      isFollower: true,
    });

    expect(res.body).toContain('최신이 아닙니다');
    expect(env.roleGrants).toHaveLength(0);
    expect(env.followers.metrics.unknownByReason.stale).toBe(1);
  });
});

describe('★★ AD-2 — 재조회는 정확히 1회, 그리고 성공하면 역할이 붙는다', () => {
  it('cachedAt 이 클릭보다 앞선 no → 1회 재조회 → yes 면 연동·역할', async () => {
    // 클릭을 스냅샷보다 **뒤로** 만든다 → 판정표 4
    const clickAfter = Date.parse('2026-09-06T18:56:00.000Z');
    env.clock.advance(clickAfter - env.clock.now());

    const viewer = {
      channelId: 'aaaa1111bbbb2222cccc3333dddd4444',
      channelName: '시청자A',
      isFollower: false,
    };
    env.viewers.set('code-A', viewer);
    const a = await runLink(env, 'userA');
    const start = await runStart(env, a.state);
    const res = await runCallback(env, a.state, 'code-A', start.cookie);

    expect(res.body).toContain('자동으로 한 번 더');
    expect(env.counts.follower).toBe(1);

    // 재조회 시점에는 상류가 팔로우를 반영했다
    viewer.isFollower = true;
    env.setCachedAt('2026-09-06T19:05:00.000Z');
    env.clock.advance(30 * 60_000);
    await new Promise((r) => setTimeout(r, 0));

    expect(env.followers.metrics.rechecks).toBe(1);
    expect(env.counts.follower).toBe(2); // 최초 1 + 재조회 1
    expect(env.links.get(GUILD, 'userA')).toBeDefined();
    expect(env.roleGrants).toEqual([`${GUILD}:userA:${ROLE}`]);

    // ★ 더 기다려도 두 번째 재조회는 없다
    env.clock.advance(60 * 60_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(env.followers.metrics.rechecks).toBe(1);
    expect(env.counts.follower).toBe(2);
  });
});

describe('운영 명령', () => {
  it('명령 정의 — /연동해제 는 Manage Guild 로 노출 자체가 막힌다 (두 겹 중 첫 겹)', () => {
    expect(env.linkCmd.definition).toMatchObject({ name: '인증', dm_permission: false });
    expect(env.statusCmd.definition.name).toBe('연동상태');
    expect(env.unlinkCmd.definition.name).toBe('연동해제');
    // Manage Guild = 1 << 5 = 32
    expect(env.unlinkCmd.definition.default_member_permissions).toBe('32');
    expect(env.linkCmd.definition.default_member_permissions).toBeUndefined();
  });

  it('/연동해제 는 운영자만 쓸 수 있고 행을 지운다', async () => {
    await fullFlow(env, 'userA', {
      channelId: 'aaaa1111bbbb2222cccc3333dddd4444',
      channelName: '시청자A',
      isFollower: true,
    });

    const denied = await env.unlinkCmd.execute({
      guildId: GUILD,
      userId: 'userB',
      targetUserId: 'userA',
    });
    expect(denied.content).toContain('운영자만');
    expect(env.links.get(GUILD, 'userA')).toBeDefined();

    const ok = await env.unlinkCmd.execute({
      guildId: GUILD,
      userId: 'admin',
      isOperator: true,
      targetUserId: 'userA',
    });
    expect(ok.content).toContain('연동을 해제했습니다');
    expect(env.links.get(GUILD, 'userA')).toBeUndefined();
  });

  it('/연동상태 — 본인은 자기 것, 남의 것은 운영자만', async () => {
    await fullFlow(env, 'userA', {
      channelId: 'aaaa1111bbbb2222cccc3333dddd4444',
      channelName: '시청자A',
      isFollower: true,
    });

    const mine = await env.statusCmd.execute({ guildId: GUILD, userId: 'userA' });
    expect(mine.content).toContain('시청자A');
    expect(mine.ephemeral).toBe(true);

    const peek = await env.statusCmd.execute({
      guildId: GUILD,
      userId: 'userB',
      targetUserId: 'userA',
    });
    expect(peek.content).toContain('운영자만');
    expect(peek.content).not.toContain('시청자A');

    const asAdmin = await env.statusCmd.execute({
      guildId: GUILD,
      userId: 'admin',
      isOperator: true,
      targetUserId: 'userA',
    });
    expect(asAdmin.content).toContain('시청자A');
  });
});

describe('실패 격리', () => {
  it('토큰 교환이 실패하면 안내만 하고 아무것도 바꾸지 않는다', async () => {
    const a = await runLink(env, 'userA');
    const start = await runStart(env, a.state);
    env.clock.advance(60_000);
    // viewers 에 없는 code → 400
    const res = await runCallback(env, a.state, 'unknown-code', start.cookie);

    expect(res.status).toBe(502);
    expect(env.counts.usersMe).toBe(0);
    expect(env.counts.follower).toBe(0);
    expect(env.links.count(GUILD)).toBe(0);
    expect(env.roleGrants).toHaveLength(0);
  });

  it('길드 설정이 없으면 진행하지 않는다 (아무 역할이나 주지 않는다)', async () => {
    const noGuild = createOAuthCallbackRoute({
      sessions: env.sessions,
      viewerToken: env.viewerToken,
      followers: env.followers,
      links: env.links,
      gateway: { addRole: () => Promise.resolve(), setNickname: () => Promise.resolve() },
      clock: env.clock,
      resolveGuild: () => undefined,
    });
    env.viewers.set('code-A', {
      channelId: 'aaaa1111bbbb2222cccc3333dddd4444',
      channelName: '시청자A',
      isFollower: true,
    });
    const a = await runLink(env, 'userA');
    const start = await runStart(env, a.state);
    env.clock.advance(60_000);
    const res = await noGuild.handle(
      req(`/oauth/callback?state=${a.state}&code=code-A`, start.cookie),
    );

    expect(res.status).toBe(500);
    expect(env.counts.token).toBe(0);
    expect(env.links.count(GUILD)).toBe(0);
  });

  it('치지직이 ?error= 로 돌려보내면 교환하지 않는다', async () => {
    const res = await env.callbackRoute.handle(req('/oauth/callback?error=access_denied'));
    expect(res.status).toBe(400);
    expect(env.counts.token).toBe(0);
  });
  /**
   * ★★ 디스코드 크롤러가 인증 링크를 가져가지 못하게 한다 (실배포 관측, 2026-09-08).
   *
   *   `/oauth/start` 는 방문할 때마다 `attachNonce` 로 nonce 를 **회전**시키고
   *   새 쿠키를 응답에 싣는다(`session.ts`). 그런데 디스코드는 메시지의 링크를
   *   미리보기용으로 **직접 가져간다** — 벙커웹 로그에 남은 실제 요청:
   *
   *     35.237.4.214 "GET /oauth/start?s=71Usw…" "Mozilla/5.0 (compatible; Discordbot/2.0; …)"
   *
   *   그 크롤러가 **사용자 클릭 3초 뒤에** 도착했다. 사용자가 치지직 동의 화면에
   *   머무는 사이에 도착하면 서버 해시가 크롤러의 nonce 로 덮이고, 사용자의 쿠키는
   *   어긋나 **콜백이 state 검증에서 거부**된다.
   *
   * ★ `<...>` 는 디스코드가 미리보기를 만들지 않게 하는 표준 표기다. UA 를 보고
   *   거르는 방식과 달리 **크롤러가 애초에 오지 않으므로** 문자열 판별에 기대지 않는다.
   */
  it('★ 인증 링크는 <> 로 감싸 나간다 — 디스코드 크롤러가 가져가지 못하게', async () => {
    const reply = await env.linkCmd.execute({ guildId: GUILD, userId: 'crawler-guard' });
    const m = /(.?)https?:\/\/[^\s]*\/oauth\/start\?s=[^\s>]+(.?)/.exec(reply.content);
    expect(m, '인증 링크가 응답에 없다').not.toBeNull();
    expect(m?.[1], '링크 앞이 < 가 아니다').toBe('<');
    expect(m?.[2], '링크 뒤가 > 가 아니다').toBe('>');
  });

});
