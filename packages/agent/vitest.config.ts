import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const telemetrySrcIndex = fileURLToPath(new URL("../telemetry/src/index.ts", import.meta.url));
const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../ai/src/compat.ts", import.meta.url));
const aiSrc = fileURLToPath(new URL("../ai/src", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globalSetup: [fileURLToPath(new URL("../../vitest.tmp.global.ts", import.meta.url))],
		globals: true,
		environment: "node",
		testTimeout: 30000, // 30 seconds for API calls
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@octocodeai\/octocode-telemetry$/, replacement: telemetrySrcIndex },
			{ find: /^@octocodeai\/octocode-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@octocodeai\/octocode-ai$/, replacement: aiSrcIndex },
			{ find: /^@octocodeai\/octocode-ai\/compat$/, replacement: aiSrcCompat },
			{ find: /^@octocodeai\/octocode-ai\/(providers|utils)\/(.+)$/, replacement: `${aiSrc}/$1/$2.ts` },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
