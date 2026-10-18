import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    globals: true,
    setupFiles: ['./src/test-support/kernel-evaluator.setup.ts'],
  },
});
