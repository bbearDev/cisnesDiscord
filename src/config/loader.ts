// 출처: chzzkbot src/config/loader.ts (구조 그대로 — 시크릿 분리와 금지 키 검사를 더했다)
import { readFileSync } from 'node:fs';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import type { ZodError } from 'zod';

import {
  ConfigSchema,
  SecretsSchema,
  REQUIRED_PLACEHOLDER,
  isForbiddenConfigKey,
  type AppConfig,
  type FileConfig,
  type Secrets,
} from './schema.js';

/**
 * 설정 로더 — fail-fast (계획 §S2).
 *
 *   "파일 부재 · YAML 파싱 실패 · zod 검증 실패(cross-field 포함) · REQUIRED 미치환 ·
 *    config.yaml 에 시크릿 기재 중 하나라도 걸리면 stderr 에 파일 경로·필드 경로·
 *    기대값을 출력하고 **exit 78(EX_CONFIG)** 로 종료한다."
 *
 * 로드(순수)와 종료(부수효과)를 분리한다. `loadConfig` 는 던지기만 하므로 테스트가
 * 잡을 수 있고, `exitOnConfigError` 가 출력·대기·종료를 맡는다.
 *
 * 이 모듈은 L0(config) 이라 runtime(L1) 을 import 할 수 없다.
 * 디스코드 경보는 composition-root 가 notifier 를 주입해 해결한다.
 */

export const CONFIG_ERROR_EXIT_CODE = 78; // EX_CONFIG (sysexits.h)
export const CONFIG_ERROR_GRACE_MS = 30_000;

export type ConfigErrorKind = 'missing' | 'yaml' | 'validation' | 'forbidden-secret' | 'env';

export class ConfigError extends Error {
  readonly kind: ConfigErrorKind;
  readonly path: string;
  /** 필드 경로 → 사람이 읽는 설명 */
  readonly issues: { field: string; message: string }[];

  constructor(
    kind: ConfigErrorKind,
    path: string,
    message: string,
    issues: { field: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'ConfigError';
    this.kind = kind;
    this.path = path;
    this.issues = issues;
  }

  /** stderr 로 내보낼 사람이 읽는 형태. 파일 경로·필드 경로·기대값이 모두 들어간다. */
  format(): string {
    const bar = '════════════════════════════════════════════════════════════════';
    const lines = [
      '',
      bar,
      ' 설정 오류 — 봇을 기동할 수 없습니다',
      bar,
      '',
      `  대상: ${this.path}`,
      `  원인: ${this.message}`,
    ];
    if (this.issues.length > 0) {
      lines.push('', '  문제가 있는 항목:');
      for (const i of this.issues) {
        lines.push(`    · ${i.field}`, `      ${i.message}`);
      }
    }
    lines.push(
      '',
      '  config/config.example.yaml 과 .env.example 을 참고해 값을 고친 뒤 다시 기동하십시오.',
      bar,
      '',
    );
    return lines.join('\n');
  }
}

export interface LoadOptions {
  /** `config/config.yaml` */
  configPath: string;
  /** 시크릿 출처. 기본은 `process.env` */
  env?: NodeJS.ProcessEnv;
}

/** 설정 파일과 환경변수를 읽고 검증한다. 실패하면 ConfigError 를 던진다 (종료하지 않는다). */
export function loadConfig(opts: LoadOptions): AppConfig {
  const file = loadFileConfig(opts.configPath);
  const secrets = loadSecrets(opts.env ?? process.env);
  return { file, secrets };
}

export function loadFileConfig(path: string): FileConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new ConfigError(
      'missing',
      path,
      code === 'ENOENT'
        ? '설정 파일이 없습니다.'
        : `설정 파일을 읽을 수 없습니다 (${code ?? 'unknown'}).`,
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e: unknown) {
    const detail =
      e instanceof YAMLParseError
        ? `${e.message} (${String(e.linePos?.[0]?.line ?? '?')}행)`
        : e instanceof Error
          ? e.message
          : String(e);
    throw new ConfigError('yaml', path, `YAML 파싱에 실패했습니다: ${detail}`);
  }

  if (raw === null || raw === undefined) {
    throw new ConfigError('yaml', path, '설정 파일이 비어 있습니다.');
  }

  // ★ 시크릿 기재 검사를 **스키마보다 먼저** 한다.
  //   zod 는 모르는 키를 조용히 버리므로, 스키마에 맡기면 `liveApiToken:` 을 적어 둔
  //   파일이 아무 경고 없이 통과한다 — 그리고 그 파일이 커밋된다.
  const forbidden = findForbiddenKeys(raw);
  if (forbidden.length > 0) {
    throw new ConfigError(
      'forbidden-secret',
      path,
      '설정 파일에 시크릿으로 보이는 키가 있습니다. 시크릿은 .env 에만 둡니다.',
      forbidden.map((f) => ({
        field: f,
        message:
          'config.yaml 은 읽기 전용 볼륨·백업·저장소에 섞이기 쉽습니다. ' +
          '이 값을 .env 로 옮기고 여기서 지우십시오 (계획 §S2 ★).',
      })),
    );
  }

  // ★ REQUIRED 잔존 검사 — 두 번째 그물.
  //   개별 필드의 `requiredString` 이 첫 번째 그물이지만, 기본값이 있는 필드나
  //   스키마가 아직 모르는 필드에 남은 자리 표시는 그것만으로는 안 잡힌다.
  //   자리 표시가 하나라도 남아 있으면 그 설정은 "채워 넣지 않은 것"이다.
  const placeholders = findPlaceholders(raw);
  if (placeholders.length > 0) {
    throw new ConfigError(
      'validation',
      path,
      `자리 표시 "${REQUIRED_PLACEHOLDER}" 가 그대로 남아 있습니다.`,
      placeholders.map((f) => ({
        field: f,
        message: `실제 값으로 바꾸십시오. 자리 표시가 남은 채로는 기동하지 않습니다.`,
      })),
    );
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      'validation',
      path,
      '설정값이 스키마를 만족하지 않습니다.',
      formatZodIssues(parsed.error),
    );
  }

  return parsed.data;
}

export function loadSecrets(env: NodeJS.ProcessEnv): Secrets {
  // 빈 문자열은 "미설정"과 같게 다룬다. `.env` 에서 `X=` 로 지운 값이
  // `''` 로 들어와 min(1) 이 아니라 optional 판정을 받는 것을 막는다.
  const picked: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string' && v !== '') picked[k] = v;
  }

  const parsed = SecretsSchema.safeParse(picked);
  if (!parsed.success) {
    throw new ConfigError(
      'env',
      '.env (환경변수)',
      '시크릿 환경변수가 준비되지 않았습니다.',
      formatZodIssues(parsed.error),
    );
  }
  return parsed.data;
}

/** 중첩 객체를 훑어 금지된 키 이름의 경로를 모은다. */
function findForbiddenKeys(raw: unknown, prefix = ''): string[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((v, i) => findForbiddenKeys(v, `${prefix}[${String(i)}]`));
  }
  if (raw === null || typeof raw !== 'object') return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    const field = prefix === '' ? k : `${prefix}.${k}`;
    if (isForbiddenConfigKey(k)) out.push(field);
    out.push(...findForbiddenKeys(v, field));
  }
  return out;
}

/** 중첩 객체를 훑어 `REQUIRED` 가 남은 경로를 모은다. */
function findPlaceholders(raw: unknown, prefix = '(최상위)'): string[] {
  if (typeof raw === 'string') return raw === REQUIRED_PLACEHOLDER ? [prefix] : [];
  if (Array.isArray(raw)) {
    return raw.flatMap((v, i) => findPlaceholders(v, `${prefix}[${String(i)}]`));
  }
  if (raw === null || typeof raw !== 'object') return [];
  return Object.entries(raw).flatMap(([k, v]) =>
    findPlaceholders(v, prefix === '(최상위)' ? k : `${prefix}.${k}`),
  );
}

function formatZodIssues(error: ZodError): { field: string; message: string }[] {
  return error.issues.map((i) => {
    const path = i.path.join('.');
    return { field: path === '' ? '(최상위)' : path, message: i.message };
  });
}

export interface ExitOptions {
  /**
   * 디스코드 등 외부 알림. L0 는 L1 을 import 할 수 없으므로 주입받는다.
   * 실패해도 종료 경로를 막지 않는다 (계획 Principle 2).
   */
  notify?: (message: string) => Promise<void>;
  /** 테스트에서 30초를 기다리지 않기 위해 낮춘다. */
  graceMs?: number;
  /** 테스트 주입용. 기본은 process.exit */
  exit?: (code: number) => never;
}

/**
 * 설정 오류로 종료한다 — **exit 78**.
 *
 * 30초를 기다리는 이유: systemd 의 `Restart=` 는 종료 즉시 재기동한다. 설정이 틀린
 * 상태에서 이러면 초당 수 회 재기동하는 고속 루프가 되어 로그를 뒤덮고 경보
 * 디바운스를 무의미하게 만든다. 대기가 그 루프의 속도를 사람이 대응 가능한
 * 수준으로 낮춘다. (유닛 쪽은 `RestartPreventExitStatus=70 78` 로도 함께 막는다 — §S8)
 */
export async function exitOnConfigError(err: ConfigError, opts: ExitOptions = {}): Promise<never> {
  const graceMs = opts.graceMs ?? CONFIG_ERROR_GRACE_MS;
  const exit = opts.exit ?? ((code: number) => process.exit(code));

  process.stderr.write(err.format());

  if (opts.notify) {
    try {
      await opts.notify(
        `설정 오류로 기동에 실패했습니다.\n대상: ${err.path}\n원인: ${err.message}` +
          (err.issues.length > 0 ? `\n항목: ${err.issues.map((i) => i.field).join(', ')}` : ''),
      );
    } catch {
      // 경보 실패가 종료를 막지 않는다 (Principle 2).
    }
  }

  if (graceMs > 0) {
    process.stderr.write(
      `재기동 폭주를 막기 위해 ${String(Math.round(graceMs / 1000))}초 후 종료합니다…\n`,
    );
    await new Promise((r) => setTimeout(r, graceMs));
  }

  return exit(CONFIG_ERROR_EXIT_CODE);
}
