import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import hostConfig from "../coding-agent/vitest.config.ts";

export default mergeConfig(
	{ ...hostConfig, test: { ...hostConfig.test, setupFiles: [] } },
	defineConfig({
		// Every MCP test drives the workspace, so the host ports are installed for all of them (see mcp-host.ts).
		test: {
			setupFiles: [
				fileURLToPath(new URL("../coding-agent/test/setup-env.ts", import.meta.url)),
				fileURLToPath(new URL("../coding-agent/test/mcp-host.ts", import.meta.url)),
			],
		},
	}),
);
