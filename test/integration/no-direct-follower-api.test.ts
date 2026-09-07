import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

/**
 * ★★ 정적 검사 — **치지직 팔로워 API 를 직접 부르는 경로가 이 저장소에 없다** (계획 §5.2 rev.6).
 *
 * rev.6 이 팔로워 판정을 chzzkbot 에 위임하면서 **우리 쪽 구현이 통째로 삭제**됐다:
 * `follower-budget.ts` · counter-gated 프로브 · 조회 예산 계층 R · `pageConcurrency` ·
 * `maxPages` · 스트리머 토큰 보관·갱신 루프.
 *
 * 그 삭제는 **되돌리기 쉽다.** `GET /open/v1/channels/followers` 를 한 줄 부르는 순간
 *   ① 스트리머 토큰이 필요해지고 → 두 프로세스가 같은 refresh token 을 들게 되어
 *      **토큰 패밀리가 폐기**된다(상류 `refresh-flow.ts:222-225`. 복구에는 스트리머의
 *      브라우저 재인가가 필요하다)
 *   ② `유저 정보 조회` 를 넘는 Scope 신청(S0-3)이 되살아난다
 *   ③ 지운 예산 계층이 없으므로 페이징이 무방비로 상류를 두드린다
 *
 * 계획이 제안 2 에서 적은 그대로다 — *"테스트는 이미 생긴 경로를 잡지만 린트는
 * 생기는 순간 잡는다."* 린트 플러그인을 새로 만드는 대신 **소스 전수 검사**로
 * 같은 일을 한다. 실패 메시지가 왜 안 되는지를 그 자리에서 말한다.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..', 'src');

/** 여기 걸리면 위 머리말의 연쇄가 시작된 것이다 */
const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  {
    pattern: /channels\/followers/,
    why: '치지직 공식 팔로워 목록 API 직접 호출. 판정은 chzzkbot 단건 조회에 위임한다 (§5.2 R1).',
  },
  {
    pattern: /channels\/subscribers/,
    why: '구독자 API 는 이 제품의 범위가 아니다. 같은 스트리머 토큰을 요구한다.',
  },
  {
    pattern: /FOLLOWERS_(PATH|MAX_SIZE)/,
    why: '상류 channel-api.ts 의 페이징 상수. 우리는 페이징하지 않는다 (rev.6 삭제분).',
  },
  {
    pattern: /userNickname=/,
    why: '비공식 API. 봇 계정 로그인 쿠키를 요구한다 — 위협 모델상 감당할 수 없다 (rev.2 판정 유지).',
  },
];

/** 상류에 팔로워를 묻는 **유일한** 경로 */
const ALLOWED_LOOKUP = 'src/chzzk/follower-check.ts';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('★★ 팔로워 조회 경로는 하나뿐이다', () => {
  const files = sourceFiles(SRC);

  it('src/ 전수에 금지 경로가 없다', () => {
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf-8');
      for (const rule of FORBIDDEN) {
        // 이 검사 자신의 설명 주석에 걸리지 않도록 파일 단위로만 본다.
        if (rule.pattern.test(text)) {
          hits.push(`${relative(join(HERE, '..', '..'), file)} — ${rule.why}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('chzzkbot 단건 조회를 만드는 파일은 follower-check.ts 하나다', () => {
    const builders = files
      .filter((f) => /\/api\/followers\//.test(readFileSync(f, 'utf-8')))
      .map((f) => relative(join(HERE, '..', '..'), f).replace(/\\/g, '/'));
    expect(builders).toEqual([ALLOWED_LOOKUP]);
  });

  it('★ AC-10 — store 레이어 어디에도 치지직 토큰 어휘가 없다', () => {
    // 토큰을 보관할 수 있는 유일한 자리가 store 다. 여기 이름이 나타나는 순간
    // "잠깐 저장해 두자" 가 시작된 것이다 — 그 지점에서 잡는다.
    const offenders = sourceFiles(join(SRC, 'store'))
      .filter((f) => /accessToken|refreshToken|access_token|refresh_token/.test(readFileSync(f, 'utf-8')))
      .map((f) => relative(join(HERE, '..', '..'), f));
    expect(offenders).toEqual([]);

    const schema = readFileSync(join(SRC, 'store', 'migrations', '001_init.sql'), 'utf-8');
    expect(schema).not.toMatch(/access_token|refresh_token/);
  });

  it('follower-check 는 목록이 아니라 단건이다 — page/size 파라미터가 없다', () => {
    const text = readFileSync(join(SRC, 'chzzk', 'follower-check.ts'), 'utf-8');
    expect(text).not.toMatch(/searchParams/);
    expect(text).not.toMatch(/\bpage\b\s*[:=]/);
  });
});
