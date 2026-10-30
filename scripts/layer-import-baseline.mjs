/**
 * Layering rules inside coding-agent: `core/` and `octocode/` are hosts of the terminal, web and RPC adapters, so they
 * must not import terminal components under `modes/`. Each baseline lists the files (relative to `packages/`) that
 * already do. A new import fails `check:boundaries`. Shrink a list by moving the shared code out of `modes/`
 * (the theme and interrupted-tool text already moved); never add to it to make the check pass.
 */
export const LAYER_RULES = [
	{
		name: "core-must-not-import-modes",
		from: "coding-agent/src/core/",
		to: "coding-agent/src/modes/",
		baseline: ["coding-agent/src/core/export-html/tool-renderer.ts", "coding-agent/src/core/tools/renderers/bash.ts"],
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
