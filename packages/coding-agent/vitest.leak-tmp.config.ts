import { defineConfig } from "vitest/config";
import e2e from "./vitest.e2e.config.ts";
const base = e2e as { test: Record<string, unknown> };
export default defineConfig({ ...(e2e as object), test: { ...base.test, include: ["test/leak-tmp/*.test.ts"], maxWorkers: 1, testTimeout: 900000, hookTimeout: 120000 } } as never);
