import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['scripts/download-resume.probe.mjs'], testTimeout: 450_000 },
});
