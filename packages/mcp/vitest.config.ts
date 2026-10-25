import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import hostConfig from "../coding-agent/vitest.config.ts";

export default mergeConfig(
	{ ...hostConfig, test: { ...hostConfig.test, setupFiles: [] } },
	defineConfig({
		test: { setupFiles: [fileURLToPath(new URL("../coding-agent/test/setup-env.ts", import.meta.url))] },
	}),
);
