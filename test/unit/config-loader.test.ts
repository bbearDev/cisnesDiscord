import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadConfig,
  loadFileConfig,
  loadSecrets,
  exitOnConfigError,
  ConfigError,
  CONFIG_ERROR_EXIT_CODE,
} from '../../src/config/loader.js';
import {
  CHZZKBOT_RETRY_WINDOW_MIN,
  FOLLOWER_UPSTREAM_WORST_AGE_MIN,
  UPSTREAM_FOLLOWER_CACHE_MIN,
  UPSTREAM_SWEEP_INTERVAL_MIN,
  isForbiddenConfigKey,
} from '../../src/config/schema.js';

/**
 * 설정 로더 (계획 §S2).
 *
 *   "파일 부재 · YAML 파싱 실패 · zod 검증 실패(cross-field 포함) · REQUIRED 미치환 ·
 *    config.yaml 에 시크릿 기재 중 하나라도 걸리면 **exit 78** 로 종료한다."
 */

let dir: string;

const VALID_YAML = `
web:
  port: 8081
  bindAddress: 127.0.0.1
  publicBaseUrl: https://cisnes.example.com
`;

/**
 * 로더 검증용 가짜 시크릿. 값은 전부 지어낸 것이고, 각 줄의 표식은
 * `secrets:scan` 에 "일부러 심은 표본" 임을 밝힌다 — 표식 없이 조용히 예외
 * 처리하면 진짜 유출도 같은 방식으로 숨을 수 있다.
 */
const VALID_ENV = {
  // secrets-scan: 의도적 표본
  DISCORD_BOT_TOKEN: 'ZmFrZUJvdFRva2VuSWRQYXJ0MDA.ZmFrZTA.ZmFrZUhtYWNQYXJ0MDAwMDAwMDAwMDAw',
  // secrets-scan: 의도적 표본
  LIVE_EVENT_WEBHOOK_TOKEN: 'fake-webhook-token-0000000000000000000000000000',
  // secrets-scan: 의도적 표본
  LIVE_API_TOKEN: 'a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3',
  CHZZK_CLIENT_ID: 'fake-cisnes-client-id',
  CHZZK_CLIENT_SECRET: 'fake-cisnes-client-secret',
} satisfies NodeJS.ProcessEnv;

function writeConfig(yaml: string): string {
  const p = join(dir, 'config.yaml');
  writeFileSync(p, yaml, 'utf-8');
  return p;
}

/**
 * ConfigError 를 잡아 돌려준다.
 *
 * ★ `toThrow(/…/)` 로 판정하지 않는 이유: 그 매처는 `error.message` 만 본다.
 *   이 로더는 사람이 읽는 요약을 message 에 두고 **필드 경로·기대값을 issues 에**
 *   싣는다 — 운영자가 실제로 고쳐야 하는 정보가 거기 있다. 판정도 거기서 한다.
 */
function capture(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (e: unknown) {
    if (e instanceof ConfigError) return e;
    throw e;
  }
  throw new Error('ConfigError 가 나지 않았습니다');
}

/** issues 의 필드 경로와 설명을 한 덩어리로. */
function issueText(err: ConfigError): string {
  return err.issues.map((i) => `${i.field}: ${i.message}`).join('\n');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cisnes-config-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('정상 경로', () => {
  it('최소 설정이 파싱되고 §2-b 기본값이 채워진다', () => {
    const cfg = loadConfig({ configPath: writeConfig(VALID_YAML), env: VALID_ENV });

    expect(cfg.file.web.port).toBe(8081);
    expect(cfg.file.web.bindAddress).toBe('127.0.0.1');
    expect(cfg.file.chzzkbot.baseUrl).toBe('http://127.0.0.1:8080');
    // 계획 §8 / S0-14 확정값. 단수 필드다.
    expect(cfg.file.live.channelId).toBe('c3355ea2b3bea6c646789510796379d6');
    expect(cfg.file.live.webhookSilenceGraceMin).toBe(10);
    expect(cfg.file.live.apiPollIntervalMin).toBe(3);
    expect(cfg.file.live.confirmedStuckMin).toBe(5);
    expect(cfg.file.live.pollFailThresholdCount).toBe(5);
    expect(cfg.file.follower.staleAfterMin).toBe(150);
    expect(cfg.file.http.maxConcurrent).toBe(8);
    expect(cfg.file.auth.maxConcurrentFlows).toBe(8);
    expect(cfg.file.auth.commandCooldownSec).toBe(30);
    expect(cfg.file.recovery.downtimeThresholdHours).toBe(6);
  });

  it('저장소의 config.example.yaml 은 REQUIRED 때문에 그대로는 기동하지 않는다', () => {
    // 예시 파일이 그대로 통과하면 자리 표시 검사가 죽어 있는 것이다.
    expect(() => loadFileConfig('config/config.example.yaml')).toThrow(ConfigError);
  });

  it('시크릿은 .env 에서 읽는다', () => {
    const cfg = loadConfig({ configPath: writeConfig(VALID_YAML), env: VALID_ENV });
    expect(cfg.secrets.LIVE_API_TOKEN).toBe(VALID_ENV.LIVE_API_TOKEN);
    // 선택 항목은 없어도 된다 — 미설정은 "경보를 안 보낸다" 일 뿐이다.
    expect(cfg.secrets.DISCORD_OPS_WEBHOOK_URL).toBeUndefined();
  });
});

describe('REQUIRED 잔존 → 기동 거부', () => {
  it('★ 자리 표시가 남아 있으면 던지고, 그 경로가 exit 78 이다', () => {
    const path = writeConfig(`
web:
  publicBaseUrl: REQUIRED
`);
    let err: ConfigError | undefined;
    try {
      loadFileConfig(path);
    } catch (e: unknown) {
      err = e as ConfigError;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect(err?.issues.map((i) => i.field)).toContain('web.publicBaseUrl');
    expect(CONFIG_ERROR_EXIT_CODE).toBe(78);
  });

  it('★ 스키마가 모르는 필드에 남은 자리 표시도 잡는다 (두 번째 그물)', () => {
    // zod 는 모르는 키를 조용히 버리므로 개별 필드 검증만으로는 안 잡힌다.
    const path = writeConfig(`${VALID_YAML}
future:
  someNewField: REQUIRED
`);
    expect(() => loadFileConfig(path)).toThrow(/REQUIRED/);
  });

  it('exitOnConfigError 가 78 로 끝낸다', async () => {
    const codes: number[] = [];
    const notified: string[] = [];
    const err = new ConfigError('validation', 'x.yaml', '테스트', [{ field: 'a', message: 'b' }]);

    await exitOnConfigError(err, {
      graceMs: 0,
      notify: (m) => {
        notified.push(m);
        return Promise.resolve();
      },
      exit: (c: number) => {
        codes.push(c);
        return undefined as never;
      },
    });

    expect(codes).toEqual([78]);
    expect(notified[0]).toContain('x.yaml');
  });

  it('경보 실패가 종료 경로를 막지 않는다 (Principle 2)', async () => {
    const codes: number[] = [];
    await exitOnConfigError(new ConfigError('yaml', 'x.yaml', '테스트'), {
      graceMs: 0,
      notify: () => Promise.reject(new Error('웹훅 죽음')),
      exit: (c: number) => {
        codes.push(c);
        return undefined as never;
      },
    });
    expect(codes).toEqual([78]);
  });
});

describe('config.yaml 에 시크릿 금지', () => {
  it('★ LIVE_API_TOKEN 을 적으면 기동을 거부한다', () => {
    const path = writeConfig(`${VALID_YAML}
chzzkbot:
  baseUrl: http://127.0.0.1:8080
  liveApiToken: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
`);
    let err: ConfigError | undefined;
    try {
      loadFileConfig(path);
    } catch (e: unknown) {
      err = e as ConfigError;
    }
    expect(err?.kind).toBe('forbidden-secret');
    expect(err?.issues.map((i) => i.field)).toContain('chzzkbot.liveApiToken');
  });

  it('★ LIVE_EVENT_WEBHOOK_TOKEN 도 마찬가지다', () => {
    const path = writeConfig(`${VALID_YAML}
LIVE_EVENT_WEBHOOK_TOKEN: something
`);
    expect(() => loadFileConfig(path)).toThrow(ConfigError);
  });

  it('★ webhookSilenceGraceMin 은 정상 키다 — 키 이름 그물이 이걸 잡으면 안 된다', () => {
    // redact.ts 의 /webhook/ 그물을 그대로 쓰면 이 정상 키가 걸려
    // 설정 파일이 영영 통과하지 못한다.
    expect(isForbiddenConfigKey('webhookSilenceGraceMin')).toBe(false);
    expect(isForbiddenConfigKey('liveApiToken')).toBe(true);
    expect(isForbiddenConfigKey('DISCORD_BOT_TOKEN')).toBe(true);
    expect(isForbiddenConfigKey('clientSecret')).toBe(true);
    expect(isForbiddenConfigKey('bindAddress')).toBe(false);
  });
});

describe('cross-field 불변식 — §2-b 파생 관계를 기계가 지킨다', () => {
  it('★ apiPollIntervalMin 이 재시도 창(7분) 이상이면 거부', () => {
    const path = writeConfig(`${VALID_YAML}
live:
  apiPollIntervalMin: ${String(CHZZKBOT_RETRY_WINDOW_MIN)}
`);
    const err = capture(() => loadFileConfig(path));
    expect(err.issues.map((i) => i.field)).toContain('live.apiPollIntervalMin');
    expect(issueText(err)).toContain('감지 공백');
  });

  it('★ webhookSilenceGraceMin 이 재시도 창 이하면 거부 — 정상 재시도가 오경보를 낸다', () => {
    const path = writeConfig(`${VALID_YAML}
live:
  webhookSilenceGraceMin: ${String(CHZZKBOT_RETRY_WINDOW_MIN)}
`);
    const err = capture(() => loadFileConfig(path));
    expect(err.issues.map((i) => i.field)).toContain('live.webhookSilenceGraceMin');
  });

  it('★ staleAfterMin 이 상류 캐시 최악 나이 이하면 거부 (120분이 그 사례였다)', () => {
    const path = writeConfig(`${VALID_YAML}
follower:
  staleAfterMin: 120
`);
    const err = capture(() => loadFileConfig(path));
    expect(err.issues.map((i) => i.field)).toContain('follower.staleAfterMin');
    // ★★ 리터럴 130 을 고정하지 않는다. 그러면 **상류 값이 바뀌어도 초록불**이다 —
    //   `followerCacheMin` 이 20 이 되면 이름 붙은 상수만 고치고 130 은 남아,
    //   superRefine ③ 이 낡은 바닥으로 `staleAfterMin` 을 승인한다. 건강한 채널이
    //   다시 신선도 게이트를 밟는 그 회귀(rev.8 이 120→150 으로 벗어난 것)가 돌아온다.
    //   그래서 **유도 관계**를 건다.
    expect(FOLLOWER_UPSTREAM_WORST_AGE_MIN).toBe(
      2 * UPSTREAM_SWEEP_INTERVAL_MIN + UPSTREAM_FOLLOWER_CACHE_MIN,
    );
  });

  it('★ 우리 포트가 chzzkbot 포트와 같으면 거부 (EADDRINUSE 예방)', () => {
    const path = writeConfig(`
web:
  port: 8080
  publicBaseUrl: https://cisnes.example.com
chzzkbot:
  baseUrl: http://127.0.0.1:8080
`);
    const err = capture(() => loadFileConfig(path));
    expect(err.issues.map((i) => i.field)).toContain('web.port');
    expect(issueText(err)).toContain('EADDRINUSE');
  });
});

describe('파일·YAML 오류', () => {
  it('파일이 없으면 missing', () => {
    let err: ConfigError | undefined;
    try {
      loadFileConfig(join(dir, '없는파일.yaml'));
    } catch (e: unknown) {
      err = e as ConfigError;
    }
    expect(err?.kind).toBe('missing');
    expect(err?.format()).toContain('설정 오류');
  });

  it('YAML 파싱 실패는 yaml', () => {
    const path = writeConfig('web: [불균형\n  - 괄호');
    let err: ConfigError | undefined;
    try {
      loadFileConfig(path);
    } catch (e: unknown) {
      err = e as ConfigError;
    }
    expect(err?.kind).toBe('yaml');
  });

  it('빈 파일도 거부한다', () => {
    expect(() => loadFileConfig(writeConfig('\n'))).toThrow(ConfigError);
  });
});

describe('시크릿 환경변수', () => {
  it('필수 시크릿이 없으면 env 오류', () => {
    let err: ConfigError | undefined;
    try {
      loadSecrets({ DISCORD_BOT_TOKEN: 'x' });
    } catch (e: unknown) {
      err = e as ConfigError;
    }
    expect(err?.kind).toBe('env');
    expect(err?.issues.map((i) => i.field)).toContain('LIVE_API_TOKEN');
  });

  it('★ REQUIRED 가 그대로면 거부한다', () => {
    const err = capture(() => loadSecrets({ ...VALID_ENV, LIVE_API_TOKEN: 'REQUIRED' }));
    expect(err.kind).toBe('env');
    expect(issueText(err)).toContain('LIVE_API_TOKEN');
    expect(issueText(err)).toContain('REQUIRED');
  });

  it('빈 문자열은 미설정과 같게 다룬다', () => {
    expect(() => loadSecrets({ ...VALID_ENV, CHZZK_CLIENT_SECRET: '' })).toThrow(ConfigError);
  });

  it('선택 항목인 운영 웹훅 URL 은 형식을 검사한다', () => {
    expect(() => loadSecrets({ ...VALID_ENV, DISCORD_OPS_WEBHOOK_URL: 'URL아님' })).toThrow(
      ConfigError,
    );
  });
});
