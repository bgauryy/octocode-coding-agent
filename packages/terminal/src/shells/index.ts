import { findExecutable, loginShellName } from "../executables.ts";
import type { ShellName, ShellSetting } from "../types.ts";
import { bashSpec } from "./bash.ts";
import { fishSpec } from "./fish.ts";
import { pwshSpec } from "./pwsh.ts";
import type { ShellSpec } from "./spec.ts";
import { zshSpec } from "./zsh.ts";

const SPECS: Record<ShellName, ShellSpec> = { zsh: zshSpec, bash: bashSpec, fish: fishSpec, pwsh: pwshSpec };

/** A shell to start and its binary. */
export interface ResolvedShell {
	spec: ShellSpec;
	binary: string;
}

function locate(spec: ShellSpec, env: NodeJS.ProcessEnv, preferred?: string): ResolvedShell | undefined {
	if (preferred) {
		const found = findExecutable(preferred, env);
		if (found) return { spec, binary: found };
	}
	for (const name of [spec.binary].flat()) {
		const found = findExecutable(name, env);
		if (found) return { spec, binary: found };
	}
	return undefined;
}

/**
 * The shell `setting` names. `auto` takes the login shell (`$SHELL`) when it is one Octocode can drive and is installed;
 * on Windows without `$SHELL`, PowerShell. `none`, an unknown login shell or a missing binary give undefined.
 */
export function resolveShell(setting: ShellSetting, env: NodeJS.ProcessEnv = process.env): ResolvedShell | undefined {
	if (setting === "none") return undefined;
	if (setting !== "auto") return locate(SPECS[setting], env);
	const login = loginShellName(env);
	if (login === "zsh" || login === "bash" || login === "fish") return locate(SPECS[login], env, env.SHELL);
	if (login === "pwsh" || login === "powershell") return locate(SPECS.pwsh, env, env.SHELL);
	if (!login && process.platform === "win32") return locate(SPECS.pwsh, env);
	return undefined;
}
