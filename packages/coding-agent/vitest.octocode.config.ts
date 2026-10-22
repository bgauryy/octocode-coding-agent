import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

export default mergeConfig(baseConfig, defineConfig({
  test: {
    environment: "node",
    include: ["test/octocode/**/*.test.ts"],
    exclude: ["test/octocode/e2e*.test.ts", "test/octocode/*-chrome.test.ts"],
    setupFiles: ["test/octocode/setup-env.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    maxWorkers: 4,
    coverage: { include: ["src/octocode/**/*.ts"], thresholds: { statements: 95.4, branches: 89, functions: 96.1, lines: 97.6 } },
  },
}));
