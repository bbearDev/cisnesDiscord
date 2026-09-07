#!/usr/bin/env node
// 출처: chzzkbot scripts/secrets-scan.mjs — 규칙에 디스코드 봇 토큰과 chzzkbot 토큰류를 더했다.
/**
 * 비밀값 스캔 (AC-32).
 *
 * ★ **픽스처를 반드시 포함한다.**
 *   chzzkbot 에서 2026-08-28 에 실제로 사고가 났다 — 이름은 `*.masked.json` 인데
 *   요청 헤더에 `Authorization: Bearer <원문>` 을 담고 있었고, 결국 픽스처 40여 개를
 *   통째로 지워야 했다. **"마스킹했다"는 이름은 보증이 아니다. 스캔이 보증이다.**
 *
 * ★ 스캔 자체를 검증한다.
 *   일부러 심은 표본을 못 잡으면 스캔이 죽어 있어도 통과한다.
 *   `--self-test` 로 그 사실을 확인한다.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * 훑을 곳. 픽스처와 로그가 핵심이고, 루트의 기록 파일도 대상이다.
 *
 * ★ `deploy` 와 `logs` 를 포함한다. systemd 유닛과 프록시 설정은 **토큰을 참조하는
 *   자리**이고(`WATCHDOG_ENV_FILE`, `Environment=`), 예시를 실값으로 채워 넣는 실수가
 *   가장 나기 쉬운 파일이다. 대상에서 빠지면 그 실수를 아무도 못 잡는다.
 */
const TARGETS = ['src', 'test', 'scripts', 'docs', 'config', 'data', 'deploy', 'logs', '.'];
/** 루트를 훑을 때 하위 디렉터리로 다시 내려가지 않게 한다 */
const ROOT_ONLY = new Set(['.']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.omc']);
/** 이 확장자만 본다 — 바이너리를 열지 않는다 */
const EXTS = [
  '.ts',
  '.mjs',
  '.js',
  '.json',
  '.jsonl',
  '.md',
  '.txt',
  '.yaml',
  '.yml',
  '.log',
  '.sql',
  '.sh',
  // ★ 배포 산출물. 확장자가 없으면 walk() 가 통째로 건너뛴다.
  '.conf',
  '.service',
  '.timer',
  '.example',
];

const RULES = [
  { name: 'Bearer 토큰', re: /Bearer\s+[A-Za-z0-9._~+/-]{20,}/g },
  // ★ 디스코드 봇 토큰 — `<id>.<ts>.<hmac>`. 점이 있어 "40자 이상 토큰류" 에 안 걸린다.
  { name: '디스코드 봇 토큰', re: /\b[A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g },
  { name: '디스코드 웹훅', re: /discord(app)?\.com\/api\/webhooks\/\d+\/[\w-]{20,}/gi },
  // 값이 따옴표로 감싸인 리터럴일 때만 잡는다.
  // `'x-chzzkbot-token': env.X` 같은 **참조**는 비밀이 아니다 — 그걸 잡으면
  // 정상적인 코드가 영원히 스캔을 통과하지 못한다.
  {
    name: 'chzzkbot 토큰 리터럴',
    re: /(x-chzzkbot-token|LIVE_API_TOKEN|LIVE_EVENT_WEBHOOK_TOKEN)['"]?\s*[:=]\s*['"][A-Za-z0-9._-]{20,}['"]/gi,
  },
  // ★ 따옴표 없는 형태. `.env` 한 줄과 systemd `Environment=` 는 따옴표를 쓰지 않으므로
  //   위 규칙이 통째로 비껴간다. 실배포 실측값이 hex 48자(openssl rand -hex 24)이고
  //   계약 최소 요건이 16자이므로 hex 32자 이상을 잡는다.
  //   ★ LIVE_API_TOKEN 은 계약 §2 경고대로 chzzkbot 에 등록된 **모든 채널**을 연다 —
  //     디스코드 봇 토큰과 같은 등급이다.
  {
    name: 'chzzkbot 토큰 (따옴표 없음)',
    re: /(x-chzzkbot-token|LIVE_API_TOKEN|LIVE_EVENT_WEBHOOK_TOKEN)\s*[:=]\s*[A-Fa-f0-9]{32,}/gi,
  },
  // 디스코드 봇 토큰도 따옴표 없이 `.env` 에 들어간다.
  {
    name: '디스코드 봇 토큰 (따옴표 없음)',
    re: /DISCORD_BOT_TOKEN\s*[:=]\s*[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/gi,
  },
  { name: '치지직 Client-Secret 리터럴', re: /Client-?Secret['"]?\s*[:=]\s*['"][A-Za-z0-9._-]{20,}['"]/gi },
  { name: 'accessToken/refreshToken 원문', re: /"(access|refresh)Token"\s*:\s*"[A-Za-z0-9._-]{30,}"/gi },
  { name: '40자 이상 토큰류 문자열', re: /['"][A-Za-z0-9_-]{40,}['"]/g },
];

/**
 * 의도적으로 심은 표본임을 밝히는 표식.
 *
 * 마스킹·redaction 을 검증하는 테스트는 **가짜 비밀값을 심어야** 한다.
 * 그걸 스캔이 잡으면 영원히 통과하지 못하므로, 같은 줄이나 바로 윗줄에
 * 이 표식을 달아 의도를 드러낸다. 표식 없이 조용히 예외 처리하면
 * 진짜 유출도 같은 방식으로 숨을 수 있다.
 */
const INTENTIONAL_MARK = 'secrets-scan: 의도적 표본';

/** 오탐을 만드는 알려진 예외 — 근거를 함께 적는다 */
const ALLOW = [
  // 마스킹 표기 자체는 비밀이 아니다
  /\[len=\d+\]/,
  /MASKED/,
  /XXXXXXXX/,
  // 스캔 규칙 자체가 패턴 문자열을 담는다
  /scripts\/secrets-scan\.mjs$/,
  // package-lock 의 integrity 해시
  /package-lock\.json$/,
];

function walk(dir, rootOnly = false) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // 없는 디렉터리는 건너뛴다
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!rootOnly) out.push(...walk(p));
    } else if (EXTS.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

function scanText(text, path) {
  const hits = [];
  const lines = text.split('\n');
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      const line = text.slice(0, m.index ?? 0).split('\n').length;
      const excerpt = (m[0] ?? '').slice(0, 24);
      const lineText = lines[line - 1] ?? '';
      const prevText = lines[line - 2] ?? '';
      if (ALLOW.some((a) => a.test(lineText))) continue;
      if (lineText.includes(INTENTIONAL_MARK) || prevText.includes(INTENTIONAL_MARK)) continue;
      hits.push({ path, line, rule: rule.name, excerpt });
    }
  }
  return hits;
}

// ── 자기 검증 ────────────────────────────────────────────────────
if (process.argv.includes('--self-test')) {
  const sample = [
    // 완전히 지어낸 값이어야 한다 — 실제 토큰 앞부분을 복사하면 그 자체가 유출이다
    'Authorization: Bearer FAKE0000sample1111token2222forselftest3333',
    '"refreshToken": "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF"',
    'https://discord.com/api/webhooks/123456789/AbCdEfGhIjKlMnOpQrStUvWxYz012345',
    'FAKEfakeFAKEfakeFAKEfake.FAKEfk.FAKEfakeFAKEfakeFAKEfakeFAKE',
  ].join('\n');

  const hits = scanText(sample, '<self-test>');
  if (hits.length < 4) {
    process.stderr.write(
      `자기 검증 실패: 심어둔 표본 4건 중 ${String(hits.length)}건만 잡았습니다.\n`,
    );
    process.stderr.write('스캔 규칙이 죽어 있으면 통과해도 아무것도 보장하지 못합니다.\n');
    process.exit(1);
  }
  process.stdout.write(`자기 검증 통과 — 표본을 모두 잡았습니다 (${String(hits.length)}건).\n`);
  process.exit(0);
}

// ── 실제 스캔 ────────────────────────────────────────────────────
/**
 * ★ `.gitignore` 를 존중한다.
 *   이 스캔의 목적은 **저장소에 비밀값이 커밋되지 않게** 하는 것이다.
 *   `data/` 아래 런타임 파일에는 진짜 토큰이 들어갈 수 있지만 커밋되지 않으므로
 *   대상이 아니다. 반대로 추적되는 파일에 있으면 그건 실제 유출이다.
 */
function filterTracked(paths) {
  if (paths.length === 0) return paths;
  try {
    const out = execFileSync('git', ['check-ignore', '--stdin'], {
      input: paths.join('\n'),
      encoding: 'utf8',
      // ★ git 저장소가 아니면 "fatal: not a git repository" 가 stderr 로 샌다.
      //   깨끗한 실행이 고장난 것처럼 보이므로 삼킨다 — 아래 catch 가 전부 스캔으로 넘긴다.
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const ignored = new Set(out.split('\n').filter(Boolean));
    return paths.filter((p) => !ignored.has(p));
  } catch (e) {
    // check-ignore 는 무시된 파일이 하나도 없으면 종료 코드 1 을 낸다
    if (e && typeof e === 'object' && 'status' in e && e.status === 1) {
      const out = typeof e.stdout === 'string' ? e.stdout : '';
      const ignored = new Set(out.split('\n').filter(Boolean));
      return paths.filter((p) => !ignored.has(p));
    }
    // git 이 없으면 전부 스캔한다 — 덜 잡는 것보다 더 잡는 편이 낫다
    return paths;
  }
}

const files = filterTracked([...new Set(TARGETS.flatMap((t) => walk(t, ROOT_ONLY.has(t))))]);
const findings = [];

for (const file of files) {
  if (ALLOW.some((a) => a.test(file))) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  findings.push(...scanText(text, relative(process.cwd(), file)));
}

process.stdout.write(`비밀값 스캔: 추적 대상 파일 ${String(files.length)}개 (.gitignore 제외)\n`);

if (findings.length > 0) {
  process.stdout.write(`\n★ 비밀값으로 보이는 문자열 ${String(findings.length)}건:\n`);
  for (const f of findings) {
    process.stdout.write(`  ${f.path}:${String(f.line)}  [${f.rule}]  ${f.excerpt}…\n`);
  }
  process.stdout.write(
    '\n원문을 지우거나 마스킹하십시오. 이름에 masked 를 붙이는 것으로는 부족합니다.\n',
  );
  process.exit(1);
}

process.stdout.write('비밀값이 발견되지 않았습니다.\n');
