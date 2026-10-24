import { getAgentDir } from "../../../config.ts";
import { SettingsManager } from "../../../core/settings-manager.ts";

/** The shell a background job or a foreground command runs with: the user's Octocode settings, the prefix, a non-interactive environment. */

/** The user's Octocode shell settings that every command runs with. */
export interface ShellSettings {
	type?: "bash" | "powershell";
	shellPath?: string;
	commandPrefix?: string;
	/** `bashBackgroundAfterSeconds`: when a foreground command moves to the background. */
	backgroundAfterSeconds?: number;
}

/** `shellPath`, `shellCommandPrefix` and `bashBackgroundAfterSeconds` from Octocode's settings for `cwd` (project settings only in a trusted project). */
export function shellSettings(cwd: string, projectTrusted: boolean): ShellSettings {
	try {
		const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
		const shellPath = settings.getShellPath();
		const commandPrefix = settings.getShellCommandPrefix();
		return {
			...(shellPath ? { shellPath } : {}),
			...(commandPrefix ? { commandPrefix } : {}),
			backgroundAfterSeconds: settings.getBashBackgroundAfterSeconds(),
		};
	} catch {
		return {};
	}
}

/** Prepare the chosen shell's script; a Bash prefix never runs as PowerShell. */
export function shellScript(command: string, settings: ShellSettings): string {
	return settings.type === "powershell"
		? `try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n${command}`
		: prefixed(command, settings.commandPrefix);
}

/** The command as Octocode's bash runs it: the settings prefix on its own line first. */
export function prefixed(command: string, commandPrefix?: string): string {
	return commandPrefix ? `${commandPrefix}\n${command}` : command;
}

/** What git runs instead of an editor: says how to pass the text, then fails so the command stops at once. */
const NO_EDITOR =
	"echo 'No interactive editor in this shell: pass the text as arguments (git commit -m, git merge --no-edit), or set one for the command (GIT_EDITOR=true git rebase --continue, GIT_SEQUENCE_EDITOR=<script> git rebase -i).' >&2; false";

/**
 * `env` for a command with no terminal: stdin is closed and there is no controlling terminal, so an editor git opens
 * (commit without -m, rebase -i, rebase --continue) would wait until the timeout. git's editors are replaced by one that
 * fails at once and says what to do; a value set on the command line itself still wins. Pagers and git credential
 * prompts get non-interactive defaults unless the environment already sets them.
 */
export function nonInteractiveEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return {
		PAGER: "cat",
		GIT_PAGER: "cat",
		GIT_TERMINAL_PROMPT: "0",
		...env,
		GIT_EDITOR: NO_EDITOR,
		GIT_SEQUENCE_EDITOR: NO_EDITOR,
	};
}
