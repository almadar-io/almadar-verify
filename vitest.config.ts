import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    globals: true,
    setupFiles: ['./src/test-support/kernel-evaluator.setup.ts'],
  },
  resolve: {
    alias: {
      html2canvas: path.resolve(__dirname, 'src/ljuba/__tests__/__mocks__/html2canvas.ts'),
    },
  },
});
