/**
 * Claude subscription sign-in for the Anthropic provider. Octocode never opens a claude.ai sign-in of its own: it hands
 * the terminal to Claude Code's `claude setup-token`, which runs Anthropic's browser sign-in and prints a long-lived
 * subscription token (`sk-ant-oat…`) and saves it nowhere. Where the system `script` command exists, Octocode records
 * that terminal session to a file in a private temporary folder, reads the token from it and deletes the folder at once;
 * the Anthropic key dialog then stores the token like any Anthropic credential (OS keychain when available). Without a
 * recording, or when the token cannot be read from it, the dialog asks the user to paste the token. Requests made with it
 * draw on the Claude plan.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { findOnPath } from "../../../../../common/src/find-on-path.ts";
import { holdTerminalForChild } from "../../../utils/foreground-child.ts";
import type { ProviderManagerHost } from "./provider-manager-host.ts";

/** The provider a Claude subscription token signs in to. */
export const CLAUDE_SUBSCRIPTION_PROVIDER = "anthropic";
export const CLAUDE_SUBSCRIPTION_ACTION = "Sign in with your Claude subscription — browser, through Claude Code";

/** How a finished terminal command ended: its exit code and, when recorded, what it printed; or why it could not start. */
type TerminalExit = { code: number | null; output?: string } | { error: string };
export type RunInTerminal = (command: string, args: readonly string[]) => Promise<TerminalExit>;

/** The installed Claude Code CLI, or undefined: without it there is no Anthropic-run sign-in to hand over to. */
export function findClaudeCli(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return findOnPath("claude", env);
}

/** Runs `command` with the terminal handed to it, as the external editor does; Ctrl+C belongs to the child. */
async function spawnInTerminal(command: string, args: readonly string[]): Promise<TerminalExit> {
	const release = holdTerminalForChild();
	try {
		return await new Promise<TerminalExit>((resolve) => {
			const child = spawn(command, [...args], { stdio: "inherit", shell: process.platform === "win32" });
			child.on("error", (error) => resolve({ error: errorMessage(error) }));
			child.on("close", (code) => resolve({ code }));
		});
	} finally {
		release();
	}
}

/** The `script` invocation that records `command` to `file` and exits with its code; undefined where there is none. */
function recordingCommand(
	file: string,
	command: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv,
): { command: string; args: string[] } | undefined {
	// `script` needs a terminal on stdin; anywhere else there is nobody to sign in, and the plain run reports that.
	const script = process.platform === "win32" || !process.stdin.isTTY ? undefined : findOnPath("script", env);
	if (!script) return undefined;
	if (process.platform !== "linux") return { command: script, args: ["-q", file, command, ...args] };
	// util-linux takes one shell command and needs -e to pass the child's exit code on.
	const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
	return { command: script, args: ["-q", "-e", "-c", [command, ...args].map(quote).join(" "), file] };
}

/**
 * Runs `command` in the terminal and, where `script` can record it, returns what it printed. The recording lives in a
 * folder only this user can read (mkdtemp creates it 0700) and is deleted before this returns, whatever happened.
 */
async function runInTerminal(
	command: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
): Promise<TerminalExit> {
	const dir = await mkdtemp(join(tmpdir(), "octocode-claude-"));
	try {
		const file = join(dir, "session");
		const recorder = recordingCommand(file, command, args, env);
		if (!recorder) return await spawnInTerminal(command, args);
		const exit = await spawnInTerminal(recorder.command, recorder.args);
		if ("error" in exit) return exit;
		const output = await readFile(file, "utf8").catch(() => undefined);
		return output === undefined ? exit : { ...exit, output };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// Cursor-forward moves stand in for spaces; the other escapes (CSI, OSC, charset and keypad switches) carry no text.
const CURSOR_FORWARD = /\x1b\[(\d*)C/g;
const ESCAPES = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][A-Z0-9]|[=>78])/g;
// The control characters left besides newlines.
const CONTROLS = /[\x00-\x09\x0b-\x1f\x7f]/g;
// The token, then any following lines made only of token characters: the terminal UI hard-wraps it at the width.
const TOKEN = /sk-ant-oat\d+-[A-Za-z0-9_-]+(?:\n[ \t]*(?!sk-ant-oat)[A-Za-z0-9_-]+(?=[ \t]*(?:\n|$)))*/g;

/**
 * The last subscription token in a recorded `claude setup-token` session, rejoined where the terminal UI wrapped it, or
 * undefined when none is there or what is there is too short to be whole.
 */
export function findSetupToken(recording: string): string | undefined {
	const text = recording
		.replace(CURSOR_FORWARD, (_match, count: string) => " ".repeat(Number(count || 1)))
		.replace(ESCAPES, "")
		.replaceAll("\r", "")
		.replace(CONTROLS, "");
	const found = [...text.matchAll(TOKEN)].at(-1)?.[0].replace(/\s+/g, "");
	return found && found.length >= 80 ? found : undefined;
}

/**
 * Runs `claude setup-token` in the terminal, then opens the Anthropic key dialog with the token it printed, or asking for
 * it when it could not be read. A failed run saves nothing and returns to the provider's page through `back`.
 */
export async function signInWithClaudeSubscription(
	host: Pick<ProviderManagerHost, "ui" | "showApiKeyLoginDialog" | "showError">,
	claude: string,
	providerName: string,
	back: () => void,
	run: RunInTerminal = runInTerminal,
): Promise<void> {
	host.ui.stop();
	let exit: TerminalExit;
	try {
		process.stdout.write(
			"Running `claude setup-token`: finish the sign-in in your browser. Claude then prints a token that starts with " +
				"sk-ant-oat; Octocode saves it when this command exits, and asks you to paste it if it cannot read it.\n\n",
		);
		exit = await run(claude, ["setup-token"]);
	} finally {
		host.ui.start();
		host.ui.requestRender(true);
	}
	if ("error" in exit) {
		host.showError(`Could not run claude setup-token: ${exit.error}`);
		return back();
	}
	if (exit.code !== 0) {
		host.showError(`claude setup-token exited with code ${exit.code ?? "none"}; nothing was saved.`);
		return back();
	}
	const token = exit.output === undefined ? undefined : findSetupToken(exit.output);
	if (token) await host.showApiKeyLoginDialog(CLAUDE_SUBSCRIPTION_PROVIDER, providerName, back, token);
	else await host.showApiKeyLoginDialog(CLAUDE_SUBSCRIPTION_PROVIDER, providerName, back);
}
