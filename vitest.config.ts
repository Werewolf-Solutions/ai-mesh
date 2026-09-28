import { defineConfig } from 'vitest/config';

/**
 * unit:        pure logic, no processes.
 * integration: spawns real node processes with the DETERMINISTIC FAKE runtime
 *              for fault injection (requires `pnpm build`).
 * real:        spawns nodes with the real llama.cpp runtime and verified model
 *              (requires ./mesh runtime install && ./mesh model download).
 */
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.test.ts', 'packages/*/test/**/*.test.ts'], testTimeout: 10_000 } },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'real',
          include: ['tests/real/**/*.test.ts'],
          testTimeout: 180_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
