import assert from "node:assert/strict";
import { test } from "node:test";
import { violations } from "./check-mcp-boundary.mjs";

const at = (file, text) => ({ file, text });

test("flags static, type-only, dynamic and re-exported imports of private MCP modules", () => {
	const files = [
		at("coding-agent/src/octocode/turn.ts", 'import { getMcpSessionStatus } from "../../../mcp/src/status.ts";'),
		at(
			"coding-agent/src/octocode/hooks/mcp.ts",
			'import type { BoundMcpHookCaller } from "../../../../mcp/src/hook-caller.ts";',
		),
		at("coding-agent/src/main.ts", 'const cli = await import("../../mcp/src/cli.ts");'),
		at("coding-agent/src/index.ts", 'export { loadMcpConfig } from "../../mcp/src/config.ts";'),
		at("coding-agent/scripts/export-agent-prompts.ts", 'import { MCPS_SECTION } from "../../mcp/src/section.ts";'),
		at("acp/src/server/mcp.ts", 'import "../../../mcp/src/client/index.ts";'),
	];
	assert.deepEqual(violations(files), [
		"coding-agent/src/octocode/turn.ts -> mcp/src/status.ts",
		"coding-agent/src/octocode/hooks/mcp.ts -> mcp/src/hook-caller.ts",
		"coding-agent/src/main.ts -> mcp/src/cli.ts",
		"coding-agent/src/index.ts -> mcp/src/config.ts",
		"coding-agent/scripts/export-agent-prompts.ts -> mcp/src/section.ts",
		"acp/src/server/mcp.ts -> mcp/src/client/index.ts",
	]);
});

test("allows the API, the package exports, the workspace itself and the bundle's client subpaths", () => {
	const files = [
		at(
			"coding-agent/src/octocode/turn.ts",
			'import { getMcpSessionStatus, type McpServerStatus } from "../../../mcp/src/api.ts";',
		),
		at("acp/src/server/mcp.ts", 'import { loadMcpConfig } from "@octocodeai/octocode-mcp/config";'),
		at("mcp/src/events.ts", 'import { McpFeatureState } from "./state.ts";'),
		at("mcp/src/cli.lazy.ts", 'export const load = () => import("../../mcp/src/cli.ts");'),
		at(
			"coding-agent/src/bundle.ts",
			'export * from "../../mcp/src/client/index.ts";\nexport * from "../../mcp/src/client/oauth/index.ts";',
		),
		at("coding-agent/src/octocode/web/browser-mcp.ts", " * (`mcp/src/presets/browser/proxy.ts`). The tools"),
	];
	assert.deepEqual(violations(files), []);
});

test("keeps the bundle's exception to its client subpaths", () => {
	assert.deepEqual(violations([at("coding-agent/src/bundle.ts", 'export * from "../../mcp/src/config.ts";')]), [
		"coding-agent/src/bundle.ts -> mcp/src/config.ts",
	]);
});
