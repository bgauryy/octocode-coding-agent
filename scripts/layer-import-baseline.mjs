/**
 * Layering rules inside coding-agent: `core/` and `octocode/` are hosts of the terminal, web and RPC adapters, so they
 * must not import terminal components under `modes/`, and `core/` (the session layer) must not import the
 * `octocode/` feature layer or the MCP workspace (by package name or by a relative path into its sources; `to` may
 * list several prefixes). Each baseline lists the files (relative to `packages/`) that already do. A new import
 * fails `check:boundaries`, and so does a listed file that no longer imports the layer: remove it from the list.
 * Shrink a list by moving the shared code out of the upper layer (the theme and interrupted-tool text already moved
 * out of `modes/`, and the keybinding hints into `theme/`); never add to it to make the check pass. `except` lists
 * prefixes inside `from` that the rule does not cover (the layer's own home).
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
		baseline: [],
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
			"coding-agent/src/core/system-prompt.ts",
		],
	},
	{
		name: "octocode-must-not-import-modes",
		from: "coding-agent/src/octocode/",
		to: "coding-agent/src/modes/",
		baseline: [],
	},
	{
		// The base layer of the feature folders: shared helpers that reach no app code (package-layering RFC, phase 0).
		name: "shared-must-not-import-host",
		from: "coding-agent/src/octocode/shared/",
		to: [
			"coding-agent/src/core/",
			"coding-agent/src/storage/",
			"coding-agent/src/theme/",
			"coding-agent/src/config.ts",
			"mcp/src/",
			"@octocodeai/octocode-mcp",
			"db/src/",
		],
		baseline: [
			"coding-agent/src/octocode/shared/ask-view.ts",
			"coding-agent/src/octocode/shared/commands.ts",
			"coding-agent/src/octocode/shared/fence.ts",
			"coding-agent/src/octocode/shared/home.ts",
			"coding-agent/src/octocode/shared/home/workspace.ts",
			"coding-agent/src/octocode/shared/host-api.ts",
			"coding-agent/src/octocode/shared/interactive.ts",
			"coding-agent/src/octocode/shared/keys.ts",
			"coding-agent/src/octocode/shared/local-reads.ts",
			"coding-agent/src/octocode/shared/page.ts",
			"coding-agent/src/octocode/shared/session-liveness.ts",
			"coding-agent/src/octocode/shared/session-report.ts",
			"coding-agent/src/octocode/shared/spill.ts",
			"coding-agent/src/octocode/shared/tokens.ts",
			"coding-agent/src/octocode/shared/util.ts",
		],
	},
	{
		// Generic utilities stay below the app; app-bound helpers live with their feature (RFC phase 0).
		name: "utils-must-not-import-app",
		from: "coding-agent/src/utils/",
		to: [
			"coding-agent/src/core/",
			"coding-agent/src/octocode/",
			"coding-agent/src/modes/",
			"coding-agent/src/storage/",
			"coding-agent/src/config.ts",
		],
		baseline: [
			"coding-agent/src/utils/changelog.ts",
			"coding-agent/src/utils/clipboard-image.ts",
			"coding-agent/src/utils/clipboard.ts",
			"coding-agent/src/utils/git-run.ts",
			"coding-agent/src/utils/output-files.ts",
			"coding-agent/src/utils/repository-diff.ts",
			"coding-agent/src/utils/shell.ts",
			"coding-agent/src/utils/tools-manager.ts",
		],
	},
	{
		// Shell parsing and command analysis is a library inside `permission/`, on its way to its own workspace (RFC
		// phase 3): other features use it only through the files listed here.
		name: "octocode-must-not-import-permission-shell",
		from: "coding-agent/src/octocode/",
		except: ["coding-agent/src/octocode/permission/"],
		to: ["coding-agent/src/octocode/permission/bash-", "coding-agent/src/octocode/permission/shell/"],
		baseline: [
			"coding-agent/src/octocode/compaction/clearable-bash.ts",
			"coding-agent/src/octocode/compaction/edit-ledger.ts",
			"coding-agent/src/octocode/compaction/register.ts",
			"coding-agent/src/octocode/files/bash-reads.ts",
			"coding-agent/src/octocode/files/bash/mutation.ts",
			"coding-agent/src/octocode/index.ts",
			"coding-agent/src/octocode/team-surfaces.ts",
			"coding-agent/src/octocode/timer/conditions/command.ts",
		],
	},
];
