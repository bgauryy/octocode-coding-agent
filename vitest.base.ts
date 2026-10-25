import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const workspaceSourcePaths = {
	telemetryIndex: fileURLToPath(new URL("./packages/telemetry/src/index.ts", import.meta.url)),
	telemetryTesting: fileURLToPath(new URL("./packages/telemetry/src/testing/index.ts", import.meta.url)),
	mcpIndex: fileURLToPath(new URL("./packages/mcp/src/client/index.ts", import.meta.url)),
	mcpOAuth: fileURLToPath(new URL("./packages/mcp/src/client/oauth/index.ts", import.meta.url)),
	mcpTesting: fileURLToPath(new URL("./packages/mcp/src/client/testing/index.ts", import.meta.url)),
	aiIndex: fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
	aiCompat: fileURLToPath(new URL("./packages/ai/src/compat.ts", import.meta.url)),
	aiOAuth: fileURLToPath(new URL("./packages/ai/src/oauth.ts", import.meta.url)),
	aiApi: fileURLToPath(new URL("./packages/ai/src/api", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/ai/src/providers", import.meta.url)),
	aiUtils: fileURLToPath(new URL("./packages/ai/src/utils", import.meta.url)),
	agentIndex: fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
	codingAgentIndex: fileURLToPath(new URL("./packages/coding-agent/src/index.ts", import.meta.url)),
	tuiIndex: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^@octocodeai\/octocode-contacts$/,
				replacement: fileURLToPath(new URL("./packages/contacts/src/index.ts", import.meta.url)),
			},
			{
				find: /^@octocodeai\/octocode-contacts\/(.+)$/,
				replacement: fileURLToPath(new URL("./packages/contacts/src/", import.meta.url)) + "$1.ts",
			},
			{
				find: /^@octocodeai\/octocode-webview$/,
				replacement: fileURLToPath(new URL("./packages/webview/src/index.ts", import.meta.url)),
			},
			{
				find: /^@octocodeai\/octocode-webview\/(.+)$/,
				replacement: fileURLToPath(new URL("./packages/webview/src/", import.meta.url)) + "$1.ts",
			},

			{ find: /^@octocodeai\/octocode-telemetry$/, replacement: workspaceSourcePaths.telemetryIndex },
			{ find: /^@octocodeai\/octocode-telemetry\/testing$/, replacement: workspaceSourcePaths.telemetryTesting },
			{ find: /^@octocodeai\/octocodecode\/mcp$/, replacement: workspaceSourcePaths.mcpIndex },
			{ find: /^@octocodeai\/octocodecode\/mcp\/oauth$/, replacement: workspaceSourcePaths.mcpOAuth },
			{ find: /^@octocodeai\/octocodecode\/mcp\/testing$/, replacement: workspaceSourcePaths.mcpTesting },
			{ find: /^@octocodeai\/octocode-ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^@octocodeai\/octocode-ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
			{ find: /^@octocodeai\/octocode-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
			{
				find: /^@octocodeai\/octocode-ai\/utils\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiUtils}/$1.ts`,
			},
			{
				find: /^@octocodeai\/octocode-ai\/api\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiApi}/$1.ts`,
			},
			{
				find: /^@octocodeai\/octocode-ai\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
			},
			{ find: /^@octocodeai\/octocode-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
			{ find: /^@octocodeai\/octocode-tui$/, replacement: workspaceSourcePaths.tuiIndex },
		],
	},
});
