import { describe, it, expect } from 'vitest';

import {
  BLACKLIST_COMMAND,
  BLACKLIST_COMMAND_NAME,
  BLACKLIST_EMBED_MAX,
  BLACKLIST_REASON_MAX_LENGTH,
  BLACKLIST_REASON_OPTION_NAME,
  EMBED_DESCRIPTION_MAX,
  blacklistEmbed,
  createBlacklistCommand,
} from '../../src/discord/commands/blacklist.js';
import { OPTION_TYPE_STRING, OPTION_TYPE_SUB_COMMAND, OPTION_TYPE_USER } from '../../src/discord/commands/types.js';
import { DiscordSendError } from '../../src/discord/client.js';
import { ManualClock } from '../../src/runtime/clock.js';
import type { BlacklistEntry, BlacklistRepo } from '../../src/store/repos/blacklist-repo.js';
import type { AccountLink } from '../../src/store/repos/link-repo.js';

/**
 * `/블랙리스트` (운영자 전용) — 조각 단위. 이음매(버튼·콜백·재조회가 실제로 막히는가)는
 * `test/e2e/auth-flow.test.ts` 가 본다.
 *
 * ★★ 이 파일이 지키는 문장:
 *   ① **운영자만** 실행한다 — 세 하위 명령 전부
 *   ② `추가` 는 **DB 먼저, REST 나중** — 역할 회수가 실패·무응답이어도 차단·연동 삭제는 끝나 있다
 *   ③ 회수 REST 는 시그널로 끊긴다 — "응답 없음" 을 만들지 않는다
 *   ④ 모르는 하위 명령은 조용히 첫 갈래로 가지 않는다
 *   ⑤ 어떤 경우에도 던지지 않는다
 *   ⑥ 목록 임베드 설명은 어떤 입력에도 4096자를 넘지 않는다 — 넘으면 디스코드가 400 을 내고
 *      운영자는 목록을 아예 못 본다
 */

const NOW = Date.parse('2026-09-22T03:00:00.000Z');
const OP = { guildId: 'g1', userId: 'op', isOperator: true } as const;

const LINK: AccountLink = {
  discordUserId: 'u1',
  guildId: 'g1',
  chzzkChannelId: 'aaaa1111bbbb2222cccc3333dddd4444',
  chzzkChannelName: '시청자',
  linkedAt: '2026-09-20T00:00:00.000Z',
};

/** 저장소 가짜 — `add` 가 연동 행을 복사·삭제하는 계약까지 흉내 낸다 (`blacklist-repo.ts` 머리말 ★★) */
function fakeBlacklist(
  seed: BlacklistEntry[] = [],
  links: AccountLink[] = [],
): BlacklistRepo & { rows: BlacklistEntry[]; unlinked: string[] } {
  const rows = [...seed];
  const unlinked: string[] = [];
  const find = (g: string, u: string) => rows.find((r) => r.guildId === g && r.discordUserId === u);
  return {
    rows,
    unlinked,
    add: (input) => {
      const existing = find(input.guildId, input.discordUserId);
      if (existing !== undefined) return { ok: false, reason: 'already-blacklisted', existing };
      const i = links.findIndex((l) => l.guildId === input.guildId && l.discordUserId === input.discordUserId);
      const link = i < 0 ? undefined : links.splice(i, 1)[0];
      if (link !== undefined) unlinked.push(link.discordUserId);
      const entry: BlacklistEntry = {
        ...input,
        chzzkChannelId: link?.chzzkChannelId,
        chzzkChannelName: link?.chzzkChannelName,
      };
      rows.push(entry);
      return { ok: true, entry, unlinked: link };
    },
    remove: (g, u) => {
      const i = rows.findIndex((r) => r.guildId === g && r.discordUserId === u);
      return i < 0 ? undefined : rows.splice(i, 1)[0];
    },
    get: find,
    findBlocking: (g, u) => find(g, u),
    list: (g) => rows.filter((r) => r.guildId === g),
    count: (g) => rows.filter((r) => r.guildId === g).length,
  };
}

type RevokeMode = 'ok' | 'forbidden' | 'gone' | 'hang';

function make(opts: { links?: AccountLink[]; seed?: BlacklistEntry[]; revoke?: RevokeMode; roleId?: string | undefined } = {}) {
  const clock = new ManualClock(NOW);
  const blacklist = fakeBlacklist(opts.seed, opts.links ?? [{ ...LINK }]);
  const revoked: string[] = [];
  const logs: { message: string; extra?: Record<string, unknown> }[] = [];
  const mode = opts.revoke ?? 'ok';
  const cmd = createBlacklistCommand({
    blacklist,
    gateway: {
      removeRole: (g, u, r, o) => {
        if (mode === 'forbidden') {
          return Promise.reject(new DiscordSendError('forbidden', 'Missing Permissions', 403));
        }
        if (mode === 'gone') {
          return Promise.reject(new DiscordSendError('unknown', 'Unknown Member', 404));
        }
        if (mode === 'hang') {
          return new Promise<void>((_, reject) => {
            o?.signal?.addEventListener('abort', () => {
              reject(new DiscordSendError('timeout', 'The operation was aborted'));
            }, { once: true });
          });
        }
        revoked.push(`${g}:${u}:${r}`);
        return Promise.resolve();
      },
    },
    resolveVerifiedRoleId: () => ('roleId' in opts ? opts.roleId : 'role-1'),
    clock,
    revokeTimeoutMs: 20,
    onLog: (message, extra) => {
      logs.push(extra === undefined ? { message } : { message, extra });
    },
  });
  return { cmd, clock, blacklist, revoked, logs };
}

describe('정의', () => {
  it('운영자에게만 보이고 DM 에서는 안 쓰며, 하위 명령 셋이다', () => {
    expect(BLACKLIST_COMMAND.name).toBe(BLACKLIST_COMMAND_NAME);
    expect(BLACKLIST_COMMAND.dm_permission).toBe(false);
    expect(BLACKLIST_COMMAND.default_member_permissions).toBe('32');
    const subs = BLACKLIST_COMMAND.options ?? [];
    expect(subs.map((o) => [o.type, o.name])).toEqual([
      [OPTION_TYPE_SUB_COMMAND, '추가'],
      [OPTION_TYPE_SUB_COMMAND, '해제'],
      [OPTION_TYPE_SUB_COMMAND, '목록'],
    ]);
    // 하위 명령에는 `required` 를 싣지 않는다 — 디스코드가 거부한다
    for (const s of subs) expect('required' in s).toBe(false);
  });

  it('★ 대상 옵션 이름이 다른 운영자 명령과 같다 — 조립부가 한 이름으로 뽑는다. 사유는 선택·길이 상한', () => {
    const add = BLACKLIST_COMMAND.options?.[0];
    const remove = BLACKLIST_COMMAND.options?.[1];
    expect(add?.options?.[0]).toMatchObject({ type: OPTION_TYPE_USER, name: '대상', required: true });
    expect(remove?.options?.[0]).toMatchObject({ type: OPTION_TYPE_USER, name: '대상', required: true });
    expect(add?.options?.[1]).toMatchObject({
      type: OPTION_TYPE_STRING,
      name: BLACKLIST_REASON_OPTION_NAME,
      required: false,
    });
    expect(add?.options?.[1]?.max_length).toBeGreaterThan(0);
    expect(BLACKLIST_COMMAND.options?.[2]?.options).toBeUndefined();
  });

  it('defer 다 — `추가` 가 REST 를 부른다', () => {
    expect(make().cmd.defer).toBe(true);
  });
});

describe('① 권한', () => {
  it('운영자가 아니면 세 하위 명령 모두 거부하고 아무것도 바꾸지 않는다', async () => {
    const h = make();
    for (const subcommand of ['추가', '해제', '목록']) {
      const r = await h.cmd.execute({ guildId: 'g1', userId: 'u2', isOperator: false, subcommand, targetUserId: 'u1' });
      expect(r.ephemeral).toBe(true);
      expect(r.content).toContain('운영자만');
    }
    expect(h.blacklist.rows).toHaveLength(0);
    expect(h.blacklist.unlinked).toHaveLength(0);
    expect(h.revoked).toHaveLength(0);
  });
});

describe('추가', () => {
  it('★★ ② DB 먼저 — 차단 행 + 연동 삭제 + 역할 회수 1회. 치지직 채널은 연동 행에서 복사', async () => {
    const h = make();
    const r = await h.cmd.execute({ ...OP, subcommand: '추가', targetUserId: 'u1', reason: '  도배  ' });

    expect(r.ephemeral).toBe(true);
    expect(r.content).toContain('블랙리스트에 추가했습니다');
    expect(r.content).toContain('시청자');
    expect(r.content).toContain('회수했습니다');
    expect(r.content).toContain('사유: 도배');
    expect(h.blacklist.rows).toEqual([
      {
        guildId: 'g1',
        discordUserId: 'u1',
        chzzkChannelId: LINK.chzzkChannelId,
        chzzkChannelName: '시청자',
        reason: '도배',
        addedBy: 'op',
        addedAt: '2026-09-22T03:00:00.000Z',
      },
    ]);
    expect(h.blacklist.unlinked).toEqual(['u1']);
    expect(h.revoked).toEqual(['g1:u1:role-1']);
  });

  it('연동이 없던 사람 — 디스코드 계정만 차단되고 그 사실을 말한다', async () => {
    const h = make({ links: [] });
    const r = await h.cmd.execute({ ...OP, subcommand: '추가', targetUserId: 'u9' });

    expect(r.content).toContain('연동돼 있지 않았습니다');
    expect(r.content).toContain('사유: (없음)');
    expect(h.blacklist.rows[0]).toMatchObject({ discordUserId: 'u9', chzzkChannelId: undefined, reason: undefined });
    expect(h.revoked).toEqual(['g1:u9:role-1']);
  });

  it('★ ② 역할 회수가 403 이어도 차단·연동 삭제는 끝나 있고 "직접 제거" 를 말한다', async () => {
    const h = make({ revoke: 'forbidden' });
    const r = await h.cmd.execute({ ...OP, subcommand: '추가', targetUserId: 'u1' });

    expect(r.content).toContain('회수하지 못했습니다');
    expect(r.content).toContain('권한이 없습니다');
    expect(r.content).toContain('직접 제거');
    expect(h.blacklist.rows).toHaveLength(1);
    expect(h.blacklist.unlinked).toEqual(['u1']);
    expect(h.logs.some((l) => l.message === '블랙리스트 역할 회수 실패' && l.extra?.['kind'] === 'forbidden')).toBe(true);
  });

  it('★ ③ 회수 REST 가 응답을 안 주면 시그널로 끊고 실패로 접는다 — 던지지 않는다', async () => {
    const h = make({ revoke: 'hang' });
    const r = await h.cmd.execute({ ...OP, subcommand: '추가', targetUserId: 'u1' });

    expect(r.content).toContain('회수하지 못했습니다');
    expect(h.blacklist.rows).toHaveLength(1);
    expect(h.logs.some((l) => l.message === '블랙리스트 역할 회수 실패' && l.extra?.['kind'] === 'timeout')).toBe(true);
  });

  it('대상이 서버를 떠났으면(404) 실패가 아니라 "뗄 역할이 없다" 다 — 차단은 끝나 있다', async () => {
    const h = make({ revoke: 'gone' });
    const r = await h.cmd.execute({ ...OP, subcommand: '추가', targetUserId: 'u1' });
    expect(r.content).toContain('서버에 없는 멤버');
    expect(r.content).not.toContain('직접 제거');
    expect(h.blacklist.rows).toHaveLength(1);
    expect(h.logs.some((l) => l.message === '블랙리스트 역할 회수 실패')).toBe(false);
  });

  it('인증 역할이 설정돼 있지 않으면 REST 를 부르지 않고 그 사실을 말한다', async () => {
    const h = make({ roleId: undefined });
    const r = await h.cmd.execute({ ...OP, subcommand: '추가', targetUserId: 'u1' });
    expect(r.content).toContain('회수할 역할이 없습니다');
    expect(h.revoked).toHaveLength(0);
    expect(h.blacklist.rows).toHaveLength(1);
  });

  it('이미 차단된 사람 — 안내만, 연동·역할 무변화', async () => {
    const h = make({
      seed: [{ guildId: 'g1', discordUserId: 'u1', addedBy: 'op0', addedAt: '2026-09-01T00:00:00.000Z' }],
    });
    const r = await h.cmd.execute({ ...OP, subcommand: '추가', targetUserId: 'u1', reason: '새 사유' });

    expect(r.content).toContain('이미 블랙리스트에 있습니다');
    expect(r.content).toContain('2026-09-01 09:00 KST');
    expect(h.blacklist.rows[0]?.reason).toBeUndefined();
    expect(h.blacklist.unlinked).toHaveLength(0);
    expect(h.revoked).toHaveLength(0);
  });

  it('자기 자신은 차단할 수 없다', async () => {
    const h = make();
    const r = await h.cmd.execute({ ...OP, subcommand: '추가', targetUserId: 'op' });
    expect(r.content).toContain('자기 자신');
    expect(h.blacklist.rows).toHaveLength(0);
  });

  it('대상이 없으면 안내만', async () => {
    const h = make();
    const r = await h.cmd.execute({ ...OP, subcommand: '추가' });
    expect(r.content).toContain('`대상` 옵션');
    expect(h.blacklist.rows).toHaveLength(0);
  });
});

describe('해제', () => {
  it('행을 지우고 "되살리지 않는다" 를 말한다', async () => {
    const h = make({
      seed: [{ guildId: 'g1', discordUserId: 'u1', addedBy: 'op0', addedAt: '2026-09-01T00:00:00.000Z' }],
    });
    const r = await h.cmd.execute({ ...OP, subcommand: '해제', targetUserId: 'u1' });
    expect(r.content).toContain('해제했습니다');
    expect(r.content).toContain('되살리지 않습니다');
    expect(h.blacklist.rows).toHaveLength(0);
    expect(h.revoked).toHaveLength(0);
  });

  it('없는 사람이면 안내만', async () => {
    const h = make();
    const r = await h.cmd.execute({ ...OP, subcommand: '해제', targetUserId: 'u1' });
    expect(r.content).toContain('블랙리스트에 없습니다');
  });
});

describe('목록', () => {
  it('비어 있으면 임베드 없이 안내', async () => {
    const h = make();
    const r = await h.cmd.execute({ ...OP, subcommand: '목록' });
    expect(r.content).toContain('비어 있습니다');
    expect(r.embeds).toBeUndefined();
  });

  it('임베드 하나 — 번호 · 멘션 · 치지직 채널 · 사유 · 등록자 · KST 시각', async () => {
    const h = make({
      seed: [
        {
          guildId: 'g1',
          discordUserId: 'u1',
          chzzkChannelName: '시청자',
          reason: '도배',
          addedBy: 'op0',
          addedAt: '2026-09-01T00:00:00.000Z',
        },
        { guildId: 'g1', discordUserId: 'u2', addedBy: 'op0', addedAt: '2026-09-02T00:00:00.000Z' },
        // 다른 길드 — 보이면 안 된다
        { guildId: 'g2', discordUserId: 'u3', addedBy: 'op0', addedAt: '2026-09-03T00:00:00.000Z' },
      ],
    });
    const r = await h.cmd.execute({ ...OP, subcommand: '목록' });

    expect(r.ephemeral).toBe(true);
    expect(r.embeds).toHaveLength(1);
    const e = r.embeds?.[0];
    expect(e?.title).toBe('블랙리스트 — 2명');
    expect(e?.description).toContain('**1.** <@u1> · 치지직 **시청자** · 사유: 도배');
    expect(e?.description).toContain('등록: <@op0> · 2026-09-01 09:00 KST');
    expect(e?.description).toContain('**2.** <@u2> · 사유 없음');
    expect(e?.description).not.toContain('u3');
    expect(e?.footer).toBeUndefined();
  });

  it('인원 상한을 넘으면 최근 순으로 자르고 푸터에 남은 수를 적는다', () => {
    const entries: BlacklistEntry[] = Array.from({ length: BLACKLIST_EMBED_MAX + 3 }, (_, i) => ({
      guildId: 'g1',
      discordUserId: `u${String(i)}`,
      addedBy: 'op',
      addedAt: '2026-09-01T00:00:00.000Z',
    }));
    const e = blacklistEmbed(entries);
    expect(e.title).toContain(`${String(BLACKLIST_EMBED_MAX + 3)}명`);
    expect(e.description?.split('\n').filter((l) => l.startsWith('**')).length).toBe(BLACKLIST_EMBED_MAX);
    expect(e.footer?.text).toContain('외 3명');
  });

  it('★★ ⑥ 글자 예산 — 사유 100자 · 긴 채널명 · 18자리 id 로 상한 인원을 채워도 4096자를 넘지 않는다', () => {
    const entries: BlacklistEntry[] = Array.from({ length: BLACKLIST_EMBED_MAX + 5 }, (_, i) => ({
      guildId: 'g1',
      discordUserId: `1${String(i).padStart(17, '0')}`,
      chzzkChannelName: '가'.repeat(30),
      reason: '나'.repeat(BLACKLIST_REASON_MAX_LENGTH),
      addedBy: '200000000000000000',
      addedAt: '2026-09-01T00:00:00.000Z',
    }));
    const e = blacklistEmbed(entries);
    const shown = e.description?.split('\n').filter((l) => l.startsWith('**')).length ?? 0;

    expect(e.description?.length ?? 0).toBeLessThanOrEqual(EMBED_DESCRIPTION_MAX);
    // 글자 예산이 인원 상한보다 먼저 걸렸다 — 그래도 몇 명이 안 보이는지는 정확히 말한다
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(BLACKLIST_EMBED_MAX);
    expect(e.footer?.text).toContain(`외 ${String(entries.length - shown)}명`);
    // 잘린 자리에 반 토막 줄이 없다 — 마지막 줄도 "└ 등록:" 으로 끝난다
    expect(e.description?.split('\n').at(-1)).toMatch(/^└ 등록: /);
  });
});

describe('④ 모르는 하위 명령', () => {
  it('첫 갈래로 가지 않고 안내한다', async () => {
    const h = make();
    for (const subcommand of [undefined, '삭제']) {
      const r = await h.cmd.execute({ ...OP, subcommand, targetUserId: 'u1' });
      expect(r.content).toContain('알 수 없는 하위 명령');
    }
    expect(h.blacklist.rows).toHaveLength(0);
    expect(h.revoked).toHaveLength(0);
  });
});
