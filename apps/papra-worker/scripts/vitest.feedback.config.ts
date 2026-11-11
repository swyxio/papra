import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['scripts/feedback.probe.mjs'], testTimeout: 30000 },
});
