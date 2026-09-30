import { defineConfig } from 'vitest/config';

export default defineConfig({
  setupFiles: ['./src/test/setup-localstorage.ts'],
  test: {
    environment: 'node',
  },
});
