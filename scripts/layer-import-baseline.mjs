/**
 * Layering rules inside coding-agent: `core/` and `octocode/` are hosts of the terminal, web and RPC adapters, so they
 * must not import terminal components under `modes/`, and `core/` (the session layer) must not import the
 * `octocode/` feature layer or the MCP workspace (by package name or by a relative path into its sources; `to` may
 * list several prefixes). Each baseline lists the files (relative to `packages/`) that already do. A new import
 * fails `check:boundaries`, and so does a listed file that no longer imports the layer: remove it from the list.
 * Shrink a list by moving the shared code out of the upper layer (the theme and interrupted-tool text already moved
 * out of `modes/`, and the keybinding hints into `theme/`); never add to it to make the check pass.
 */
export const LAYER_RULES = [
	{
		name: "core-must-not-import-modes",
		from: "coding-agent/src/core/",
		to: "coding-agent/src/modes/",
		baseline: [],
	},
	{
		name: "core-must-not-import-octocode",
		from: "coding-agent/src/core/",
		to: "coding-agent/src/octocode/",
		baseline: ["coding-agent/src/core/agent-session.ts", "coding-agent/src/core/resource-loader/builtins.ts"],
	},
	{
		name: "core-must-not-import-mcp",
		from: "coding-agent/src/core/",
		to: ["@octocodeai/octocode-mcp", "mcp/src/"],
		baseline: [
			"coding-agent/src/core/agent-session/pending-mcp-tools.ts",
			"coding-agent/src/core/agent-session/tool-definitions.ts",
			"coding-agent/src/core/features/api.ts",
			"coding-agent/src/core/features/runtime.ts",
			"coding-agent/src/core/plugin-mcp.ts",
			"coding-agent/src/core/resource-loader/builtins.ts",
			"coding-agent/src/core/system-prompt.ts",
		],
	},
	{
		name: "octocode-must-not-import-modes",
		from: "coding-agent/src/octocode/",
		to: "coding-agent/src/modes/",
		baseline: [],
	},
];
