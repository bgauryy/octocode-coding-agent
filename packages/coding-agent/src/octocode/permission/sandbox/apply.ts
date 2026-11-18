import { getAgentDir } from "../../../config.ts";
import { SettingsManager } from "../../../core/settings-manager.ts";
import { setCommandSandbox } from "../../../utils/command-sandbox.ts";
import type { FeatureContext } from "../../../core/features/index.ts";
import type { Permission } from "../ask.ts";
import type { PermissionMode } from "../mode.ts";
import { sandboxPolicy } from "./policy.ts";
import { sandboxPrompts } from "./prompts.ts";
import { type SandboxPrompts, SrtCommandSandbox } from "./srt.ts";

/**
 * Applies `sandbox.mode` and `sandbox.allowUnsandboxed`, read from the global settings only: a project file must not
 * switch off the sandbox that protects the user from that project's commands. Each command's policy follows the
 * permission mode `mode` reports when it starts, and this process's role in `env` (`sandboxPolicy`). `prompts` answers
 * the sandbox's questions (a new host, a sandbox that cannot start); without it they are refused. Unreadable settings
 * throw: a sandbox that silently stays off would report a protection that is not there.
 */
export function applyCommandSandboxSetting(
	mode: () => PermissionMode,
	agentDir: string = getAgentDir(),
	env: NodeJS.ProcessEnv = process.env,
	prompts?: SandboxPrompts,
): void {
	const settings = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
	const setting = settings.getSandboxMode();
	setCommandSandbox(
		setting === "off"
			? undefined
			: new SrtCommandSandbox((cwd) => sandboxPolicy(cwd, { setting, mode: mode(), env }), {
					...(prompts ? { prompts } : {}),
					allowsUnsandboxed: settings.getSandboxAllowUnsandboxed(),
				}),
	);
}

/** The session's sandbox: its policy follows `permission`'s mode, and its questions are asked in `ctx`. */
export function applySessionSandbox(permission: Permission, ctx: FeatureContext): void {
	applyCommandSandboxSetting(() => permission.mode, getAgentDir(), process.env, sandboxPrompts(permission, ctx));
}
