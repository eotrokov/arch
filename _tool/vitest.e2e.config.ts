import { defineConfig } from 'vitest/config';

// Смоук-тест просмотрщика в headless Chrome: `npm run test:e2e`.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
