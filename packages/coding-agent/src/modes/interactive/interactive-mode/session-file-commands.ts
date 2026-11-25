/**
 * The session commands that read or write a session file: /export, /import and /share, and what they share with the
 * other session commands (whether the session is saved yet, a cancelled command's status).
 */

import { existsSync } from "node:fs";
import { resolvePath } from "@octocodeai/octocode-common/paths";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { getApplicationPort } from "../../../core/application/index.ts";
import {
	SessionImportFileNotFoundError,
	SessionImportInvalidError,
	sessionFileProblem,
} from "../../../core/agent-session-runtime.ts";
import { MissingSessionCwdError } from "../../../core/session-cwd.ts";
import { theme } from "../../../theme/theme.ts";
import { shareSession } from "../session-share.ts";
import { countProblem } from "./display.ts";
import type { InteractiveModeHost } from "./host.ts";
import { warnRefusedSwitch } from "./trust-switch.ts";

/** Interactive-mode members used by the session file commands. */
type SessionFileCommandsHost = Pick<
	InteractiveModeHost,
	| "clearStatusIndicator"
	| "editor"
	| "editorContainer"
	| "handleFatalRuntimeError"
	| "promptForMissingSessionCwd"
	| "runtimeHost"
	| "session"
	| "sessionManager"
	| "showConfirmDialog"
	| "showError"
	| "showStatus"
	| "showWarning"
	| "ui"
>;

/** A status for a command that did nothing (stopped by the user, or nothing to do): its next-step hint stays out. */
export function showCancelled(host: Pick<SessionFileCommandsHost, "showStatus">, text: string): void {
	host.showStatus(text);
	countProblem(host);
}

/**
 * The session file is written with the first message: before it there is nothing to save or upload, which is no failure,
 * so the command says so instead of asking a question or reporting an export error.
 */
function nothingSavedYet(
	{ sessionManager, showWarning }: Pick<SessionFileCommandsHost, "sessionManager" | "showWarning">,
	verb: "export" | "share",
): boolean {
	if (!unsaved(sessionManager)) return false;
	showWarning(`Nothing to ${verb} yet: send a message first.`);
	return true;
}

/** A saved session whose file is not written yet: it has no message, and is dropped, name and all, when you leave it. */
export function unsaved(sessionManager: SessionFileCommandsHost["sessionManager"]): boolean {
	const sessionFile = sessionManager.getSessionFile();
	return !!sessionFile && !existsSync(sessionFile);
}

export async function handleExportCommand(host: SessionFileCommandsHost, text: string): Promise<void> {
	const outputPath = getPathCommandArgument(text, "/export");
	if (nothingSavedYet(host, "export")) return;

	try {
		const app = getApplicationPort(host.session);
		if (outputPath?.endsWith(".jsonl")) {
			const filePath = app.invoke("exportToJsonl", outputPath);
			host.showStatus(`Session exported to: ${filePath}`);
		} else {
			const filePath = await app.invoke("exportToHtml", outputPath, {
				themeName: theme.name,
			});
			host.showStatus(`Session exported to: ${filePath}`);
		}
	} catch (error: unknown) {
		host.showError(`Failed to export session: ${errorMessage(error)}`);
	}
}

export function getPathCommandArgument(text: string, command: "/export" | "/import"): string | undefined {
	if (text === command) {
		return undefined;
	}
	if (!text.startsWith(`${command} `)) {
		return undefined;
	}

	const argsString = text.slice(command.length + 1).trimStart();
	if (!argsString) {
		return undefined;
	}

	const firstChar = argsString[0];
	if (firstChar === '"' || firstChar === "'") {
		const closingQuoteIndex = argsString.indexOf(firstChar, 1);
		if (closingQuoteIndex < 0) {
			return undefined;
		}
		return argsString.slice(1, closingQuoteIndex);
	}

	const firstWhitespaceIndex = argsString.search(/\s/);
	if (firstWhitespaceIndex < 0) {
		return argsString;
	}
	return argsString.slice(0, firstWhitespaceIndex);
}

export async function handleImportCommand(host: SessionFileCommandsHost, text: string): Promise<void> {
	const inputPath = getPathCommandArgument(text, "/import");
	if (!inputPath) {
		host.showWarning("Usage: /import <path.jsonl>");
		return;
	}

	// A missing or invalid file is refused before the question: confirming a replacement that cannot happen is a wasted step.
	const resolved = resolvePath(inputPath);
	if (!existsSync(resolved)) {
		host.showWarning(`Not imported: ${inputPath} does not exist.`);
		return;
	}
	const problem = sessionFileProblem(resolved);
	if (problem) {
		host.showWarning(`Not imported: ${inputPath} is not a session file: ${problem}.`);
		return;
	}
	const confirmed = await host.showConfirmDialog("Import session", `Replace current session with ${inputPath}?`);
	if (!confirmed) {
		showCancelled(host, "Import cancelled");
		return;
	}

	host.clearStatusIndicator();
	const { runtimeHost } = host;
	const runImport = async (cwdOverride?: string) => {
		const result = await (cwdOverride === undefined
			? runtimeHost.importFromJsonl(inputPath)
			: runtimeHost.importFromJsonl(inputPath, cwdOverride));
		if (result.cancelled) showCancelled(host, "Import cancelled");
		else host.showStatus(`Session imported from: ${inputPath}`);
	};
	// The retry in a chosen folder fails the same way as the first attempt.
	try {
		try {
			await runImport();
		} catch (error: unknown) {
			if (!(error instanceof MissingSessionCwdError)) throw error;
			const selectedCwd = await host.promptForMissingSessionCwd(error);
			if (!selectedCwd) {
				showCancelled(host, "Import cancelled");
				return;
			}
			await runImport(selectedCwd);
		}
	} catch (error: unknown) {
		if (error instanceof SessionImportFileNotFoundError || error instanceof SessionImportInvalidError) {
			host.showError(`Failed to import session: ${error.message}`);
			return;
		}
		if (warnRefusedSwitch(host, error)) return;
		await host.handleFatalRuntimeError("Failed to import session", error);
	}
}

export async function handleShareCommand(host: SessionFileCommandsHost): Promise<void> {
	if (nothingSavedYet(host, "share")) return;
	const confirmed = await host.showConfirmDialog(
		"Share session",
		"Uploads this whole session (every branch, the system prompt and tool definitions) to a secret GitHub gist. It is unlisted, but anyone with the link can read it. Continue?",
	);
	if (!confirmed) {
		showCancelled(host, "Share cancelled");
		return;
	}
	await shareSession({
		session: host.session,
		ui: host.ui,
		editorContainer: host.editorContainer,
		editor: host.editor,
		showStatus: (message) => host.showStatus(message),
		showError: (message) => host.showError(message),
	});
}
