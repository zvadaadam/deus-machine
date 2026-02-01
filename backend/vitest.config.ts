import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    root: __dirname,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
    testTimeout: 10000,
    setupFiles: ['./src/test/setup.ts'],
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
});
