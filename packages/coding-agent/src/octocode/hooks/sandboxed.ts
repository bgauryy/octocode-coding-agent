import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { optInSandboxLaunch, shellWord } from "../permission/sandbox/opt-in.ts";
import { expandHookPlaceholders, runCommandHook } from "./command.ts";
import type { HookCommand, HookRun } from "./contracts.ts";

/** The `/bin/sh` script that runs the hook as it would run unsandboxed: its shell command, or its exec form quoted. */
function hookScript(hook: HookCommand, environment: NodeJS.ProcessEnv): string {
	if (hook.args === undefined) return hook.command;
	const words = [hook.command, ...hook.args].map((word) => shellWord(expandHookPlaceholders(word, environment)));
	return ["exec", ...words].join(" ");
}

/**
 * Runs a command hook that sets `sandbox: true` inside the command sandbox (`optInSandboxLaunch`). A hook the sandbox
 * cannot run (a PowerShell hook, a sandbox that cannot start) is not started and fails, as a crash does: `failClosed`
 * decides whether its call goes ahead.
 */
export async function runSandboxedCommandHook(
	hook: HookCommand,
	input: Record<string, unknown>,
	cwd: string,
	environment: NodeJS.ProcessEnv,
	signal?: AbortSignal,
): Promise<HookRun> {
	const refused = (reason: string): HookRun => ({
		code: null,
		stdout: "",
		stderr: `The sandboxed hook was not started: ${reason}`,
		timedOut: false,
	});
	if (hook.args === undefined && hook.shell === "powershell")
		return refused("the sandbox runs POSIX shell hooks only.");
	let launch;
	try {
		launch = await optInSandboxLaunch(hookScript(hook, environment), cwd, `the hook ${hook.command}`);
	} catch (error) {
		return refused(errorMessage(error));
	}
	return runCommandHook(hook, input, cwd, environment, signal, launch);
}
