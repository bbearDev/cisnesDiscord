import { defineConfig } from 'vitest/config';

/**
 * 계획 §9 — 4계층 테스트.
 *   unit / integration / e2e / observability
 *
 * chzzkbot 은 5계층(+concurrency)이지만 여기서는 SQLite 를 여러 워커에서
 * 경합시키는 계층이 없다 — 단일 프로세스 · 단일 인스턴스 락(AC-35, §5.4 D1)이
 * 토폴로지 불변식이라 경합 자체를 만들지 않는 것이 설계다.
 *
 * ★ 커버리지 임계를 US-008 에서 켰다 — 라인 90 / 분기 85 (계획 §9).
 *   chzzkbot vitest.config.ts:31 이 *"임계를 켜지 않으면 커버리지가 조용히
 *   내려가도 아무도 모른다"* 고 적은 그대로다. 그쪽도 실측(91.02 / 88.42) 위에
 *   세웠고, 우리도 전 계층이 들어온 뒤 실측(91.69 / 87.16) 위에 세운다.
 *
 *   ⚠️ 분기 87.16 은 임계 85 와 여유가 2.16 뿐이다. 여유가 얇은 것은
 *   **main.ts(조립부)가 분기를 많이 갖는데 그 대부분이 배선 실패 경로**여서다.
 *   임계를 실측에 맞춰 올리지 않는 이유: 올리면 조립부에 방어 코드를 한 줄
 *   더할 때마다 임계가 깨져, 방어를 넣지 않을 이유가 생긴다.
 */
export default defineConfig({
  test: {
    include: [
      'test/unit/**/*.test.ts',
      'test/integration/**/*.test.ts',
      'test/e2e/**/*.test.ts',
      'test/observability/**/*.test.ts',
    ],
    exclude: ['node_modules/**', 'dist/**'],
    environment: 'node',
    passWithNoTests: true,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        // 타입 선언만 있는 파일 — 실행 코드가 없어 커버리지가 의미 없다
        'src/types/**',
      ],
      // ★ 켰다 (US-008). 실측 라인 91.69% / 분기 87.16% 위에 세운 값이다.
      thresholds: { lines: 90, branches: 85 },
    },
  },
});
