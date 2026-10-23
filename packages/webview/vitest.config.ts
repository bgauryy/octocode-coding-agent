import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

// Component tests opt into jsdom with a `@vitest-environment jsdom` docblock; page tests build their own JSDOM.
export default mergeConfig(
	baseConfig,
	defineConfig({
		test: { environment: "node", include: ["test/**/*.test.ts", "test/**/*.test.tsx"], setupFiles: ["test/setup.ts"] },
	}),
);
