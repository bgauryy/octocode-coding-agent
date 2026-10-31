/**
 * Layering rules inside coding-agent: `core/` and `octocode/` are hosts of the terminal, web and RPC adapters, so they
 * must not import terminal components under `modes/`, and `core/` (the session and SDK layer) must not import the
 * `octocode/` feature layer. Each baseline lists the files (relative to `packages/`) that already do. A new import
 * fails `check:boundaries`, and so does a listed file that no longer imports the layer: remove it from the list.
 * Shrink a list by moving the shared code out of the upper layer (the theme and interrupted-tool text already moved
 * out of `modes/`); never add to it to make the check pass.
 */
export const LAYER_RULES = [
	{
		name: "core-must-not-import-modes",
		from: "coding-agent/src/core/",
		to: "coding-agent/src/modes/",
		baseline: ["coding-agent/src/core/export-html/tool-renderer.ts", "coding-agent/src/core/tools/renderers/bash.ts"],
	},
	{
		name: "core-must-not-import-octocode",
		from: "coding-agent/src/core/",
		to: "coding-agent/src/octocode/",
		baseline: [
			"coding-agent/src/core/agent-session.ts",
			"coding-agent/src/core/agent-session/api.ts",
			"coding-agent/src/core/agent-session/bash.ts",
			"coding-agent/src/core/agent-session/prompt-expansion.ts",
			"coding-agent/src/core/agent-session/run-loop.ts",
			"coding-agent/src/core/application/transcript.ts",
			"coding-agent/src/core/bash-executor.ts",
			"coding-agent/src/core/extensibility/inventory.ts",
			"coding-agent/src/core/extensibility/toggles.ts",
			"coding-agent/src/core/plugin-context.ts",
			"coding-agent/src/core/plugin-mcp.ts",
			"coding-agent/src/core/resource-loader/builtins.ts",
			"coding-agent/src/core/resource-loader/extension-loading.ts",
			"coding-agent/src/core/settings-defaults.ts",
			"coding-agent/src/core/system-prompt.ts",
			"coding-agent/src/core/tools/bash/budget.ts",
			"coding-agent/src/core/tools/render-utils.ts",
		],
	},
	{
		name: "octocode-must-not-import-modes",
		from: "coding-agent/src/octocode/",
		to: "coding-agent/src/modes/",
		baseline: [
			"coding-agent/src/octocode/files/render.ts",
			"coding-agent/src/octocode/llama/ui.ts",
			"coding-agent/src/octocode/shared/keys.ts",
			"coding-agent/src/octocode/ui/activity.ts",
			"coding-agent/src/octocode/ui/editor.ts",
		],
	},
];
