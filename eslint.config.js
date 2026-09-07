// @ts-check
// 출처: chzzkbot eslint.config.js — 레이어 목록만 이 저장소의 것으로 교체했다.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

/**
 * 선형 레이어 경계 — 계획 §7 의 산출물 배치를 기계로 강제한다.
 *
 *   L0  config     (누구에게도 의존하지 않음)
 *   L1  runtime    → L0
 *   L2  store      → L0, L1
 *   L3  chzzk      → L0..L2      (live-api-client · live-event-schema)
 *   L4  live       → L0..L3      (stuck-watch · webhook-silence-watch)
 *   L5  youtube    → L0..L4      (websub · rss)
 *   L6  recovery   → L0..L5      (downtime)
 *   L7  discord    → L0..L6      (client · announcer · commands)
 *   L8  web        → L0..L7      (node:http 단일 서버 · 라우트)
 *       main / composition-root → 전부 (레이어 디렉터리 밖이라 규칙 대상 아님)
 *
 * ★ 규칙이 실제로 막는 것.
 *   `runtime/alerts` 는 디바운스 상태를 `alert_state`(store, L2)에 두지만
 *   L1 이라 store 를 import 할 수 없다. 그래서 상태 저장소를 **인터페이스로
 *   주입받는다** — composition-root 가 DB 구현을 꽂고 테스트는 메모리 구현을 꽂는다.
 *   같은 이유로 `runtime/outbox.ts`(S3)도 원장 저장소를 주입받는다.
 *   레이어 규칙이 없으면 이 배선이 "잠깐 import 하면 되는데" 로 조용히 무너진다.
 *
 * ★ `config`(L0)가 맨 아래인 이유. 설정 로더는 기동 1단계라 로거도 알림도
 *   아직 없다. 그래서 `loadConfig` 는 던지기만 하고, 출력·대기·종료(exit 78)는
 *   호출부가 맡는다 (`src/config/loader.ts` 머리말).
 */
const LAYERS = /** @type {const} */ ([
  'config', // L0
  'runtime', // L1
  'store', // L2
  'chzzk', // L3
  'live', // L4
  'youtube', // L5
  'recovery', // L6
  'discord', // L7
  'web', // L8
]);

/** 각 레이어에 대해 자기보다 상위 레이어를 target→from 금지 존으로 펼친다. */
const layerZones = LAYERS.flatMap((layer, i) =>
  LAYERS.slice(i + 1).map((higher) => ({
    target: `./src/${layer}`,
    from: `./src/${higher}`,
    message: `레이어 위반: ${layer}(L${i}) 는 상위 레이어 ${higher}(L${LAYERS.indexOf(higher)}) 를 import 할 수 없습니다. composition-root 에서 주입하십시오.`,
  })),
);

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.config.js', 'scripts/**/*.mjs'],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { import: importPlugin },
    settings: {
      'import/resolver': {
        typescript: true,
        node: true,
      },
    },
    rules: {
      // ── 레이어 경계 (기계 강제) ──────────────────────────────────
      'import/no-restricted-paths': ['error', { zones: layerZones }],

      // ── 일반 ─────────────────────────────────────────────────────
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'no-console': ['error', { allow: ['error'] }],
    },
  },

  // 스크립트·테스트는 콘솔 출력과 느슨한 타입을 허용한다.
  {
    files: ['scripts/**/*.ts', 'test/**/*.ts', '**/*.test.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
];
