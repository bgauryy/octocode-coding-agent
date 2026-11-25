import { type ImageContent } from "@octocodeai/octocode-ai";
import { cliStyle } from "../utils/cli-style.ts";
import type { Args, Mode } from "../cli/args.ts";
import { processFileArguments } from "../cli/file-processor.ts";
import { buildInitialMessage } from "../cli/initial-message.ts";
import { isInputDisabled } from "../cli/no-input.ts";
import { showStartupSelector } from "../cli/startup-ui.ts";
import type { AgentSessionRuntimeDiagnostic } from "../core/agent-session-services.ts";
import { formatMissingSessionCwdPrompt, type SessionCwdIssue } from "../core/session-cwd.ts";
import type { SettingsManager } from "../core/settings-manager.ts";

/** How this process runs: a terminal UI, a one-shot print run, JSON-lines output or the RPC server. */
export type AppMode = "interactive" | "print" | "json" | "rpc";

const STDIN_NOTICE_MS = 5_000;

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 *
 * A parent that spawns with a pipe and never closes it would otherwise hold the run silently, so one line says what the
 * run is waiting for. It only reports: the wait has no deadline, because a slow producer is a legitimate one.
 */
export async function readPipedStdin(
	stdin: Pick<NodeJS.ReadStream, "isTTY" | "setEncoding" | "on" | "resume"> = process.stdin,
	noticeMs = STDIN_NOTICE_MS,
): Promise<string | undefined> {
	// If stdin is a TTY, we're running interactively - don't read stdin
	if (stdin.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		let noticed = false;
		const notice = () => {
			noticed = true;
			console.error("octocode: waiting for stdin to close before starting; close the pipe, or pass --no-stdin.");
		};
		let timer = setTimeout(notice, noticeMs);
		timer.unref();
		stdin.setEncoding("utf8");
		stdin.on("data", (chunk) => {
			data += chunk;
			clearTimeout(timer);
			if (noticed) return;
			timer = setTimeout(notice, noticeMs);
			timer.unref();
		});
		stdin.on("end", () => {
			clearTimeout(timer);
			resolve(data.trim() || undefined);
		});
		stdin.resume();
	});
}

export function reportDiagnostics(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color =
			diagnostic.type === "error" ? cliStyle.error : diagnostic.type === "warning" ? cliStyle.warn : cliStyle.dim;
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}

/** A non-interactive run without a prompt has nothing to do: say so and exit 2 instead of succeeding silently. */
export function requirePrompt(appMode: AppMode, initialMessage: string | undefined, parsed: Args): void {
	if ((appMode !== "print" && appMode !== "json") || initialMessage?.trim() || parsed.messages.length > 0) return;
	console.error(cliStyle.error("Error: no prompt given. Pass a message, an @file, or pipe text on stdin."));
	process.exit(2);
}

/** The run's mode. `--no-input` runs in print mode even on a terminal: the interactive app would wait for typed input. */
export function resolveAppMode(
	parsed: Args,
	stdinIsTTY: boolean,
	stdoutIsTTY: boolean,
	env: NodeJS.ProcessEnv = process.env,
): AppMode {
	if (parsed.mode === "rpc") {
		return "rpc";
	}
	if (parsed.mode === "json") {
		return "json";
	}
	if (parsed.print || !stdinIsTTY || !stdoutIsTTY || isInputDisabled(env)) {
		return "print";
	}
	return "interactive";
}

export function toPrintOutputMode(appMode: AppMode): Exclude<Mode, "rpc" | "acp"> {
	return appMode === "json" ? "json" : "text";
}

export function isPlainRuntimeMetadataCommand(parsed: Args): boolean {
	return !parsed.print && parsed.mode === undefined && (parsed.help === true || parsed.listModels !== undefined);
}

export async function prepareInitialMessage(
	parsed: Args,
	stdinContent?: string,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return buildInitialMessage({ parsed, stdinContent });
	}

	// AgentSession resizes these after feature hooks select the request model.
	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages: false });
	return buildInitialMessage({
		parsed,
		fileText: text,
		fileImages: images,
		stdinContent,
	});
}

export async function promptForMissingSessionCwd(
	issue: SessionCwdIssue,
	settingsManager: SettingsManager,
): Promise<string | undefined> {
	return showStartupSelector(settingsManager, formatMissingSessionCwdPrompt(issue), [
		{ label: "Continue", value: issue.fallbackCwd },
		{ label: "Cancel", value: undefined },
	]);
}
