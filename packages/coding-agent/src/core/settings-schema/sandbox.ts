import { Type } from "typebox";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";

const SandboxModeSchema = Type.Union([Type.Literal("off"), Type.Literal("auto"), Type.Literal("on")], {
	description:
		'`"off"` runs agent shell commands as you, with your rights. `"auto"` runs every command the agent starts (the `bash` tool and its background jobs) inside an operating-system sandbox in the `manual`, `workspace` and `full` permission modes, and unsandboxed in `bypass`; `"on"` sandboxes them in every mode. A sandboxed command reads everything; it writes the workspace (the repository root, or the working folder outside a repository), the system temporary folder and its scratch folder, and nowhere else. A read-only subagent writes only its scratch and throwaway folders, and an isolated subagent its own worktree, never the main tree. Paths later sessions load (git hooks and config, `.octocode/` configuration, instruction files, other agents\' project folders) stay write-protected. Network goes through a filtering proxy: in `manual` and `workspace` each new host asks (a private address as a private-network ask), allowed once or for the session; `full` allows every host and records each; a read-only subagent gets none; loopback is always reachable. A refused write or host is named in the command\'s result. Your own `!` commands are never sandboxed. macOS only (Seatbelt): when the sandbox cannot start (another platform, a missing dependency) a warning says why and one question asks whether this session\'s commands run unsandboxed. Read from the global settings file; a project file cannot change it. Takes effect for new sessions.',
	default: SETTINGS_DEFAULTS.sandbox.mode,
});

const AllowUnsandboxedSchema = Type.Boolean({
	description:
		"Whether the agent may ask to run a command outside the sandbox (the `bash` tool's `sandbox: false`, and the question when the sandbox cannot start). Such a run asks in every permission mode but `bypass`, and allowing all shell commands never covers it. `false` refuses it without asking. Read from the global settings file only.",
	default: SETTINGS_DEFAULTS.sandbox.allowUnsandboxed,
});

/** The `sandbox` settings of the root schema. */
export const SandboxSettingsProperties = {
	sandbox: Type.Optional(
		Type.Object(
			{ mode: Type.Optional(SandboxModeSchema), allowUnsandboxed: Type.Optional(AllowUnsandboxedSchema) },
			{ additionalProperties: false },
		),
	),
};
