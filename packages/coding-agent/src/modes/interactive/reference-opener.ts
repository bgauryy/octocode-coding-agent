import { spawn } from "node:child_process";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { openTarget } from "../../../../common/src/open-target.ts";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import { holdTerminalForChild } from "../../utils/foreground-child.ts";
import {
	defaultOpenerHost,
	editorFamily,
	editorProgramName,
	launchDetached,
	openFileWithSystem,
	resolveReferenceOpener,
	type EditorInvocation,
	type OpenerHost,
} from "./reference-launcher.ts";
import type { TUI } from "@octocodeai/octocode-tui";

export interface FileLocation {
	path: string;
	line?: number;
	column?: number;
}

export function referenceLocation(target: string): FileLocation | undefined {
	if (!URL.canParse(target) || /[\x00-\x1f\x7f-\x9f]/u.test(target)) return undefined;
	const url = new URL(target);
	if (url.protocol !== "file:") return undefined;
	try {
		const position = /^#L([1-9]\d*)(?::([1-9]\d*))?$/.exec(url.hash);
		url.hash = "";
		const path = fileURLToPath(url);
		if (/[\x00-\x1f\x7f-\x9f]/u.test(path)) return undefined;
		const line = position && Number(position[1]);
		const column = position?.[2] ? Number(position[2]) : undefined;
		if ((line && !Number.isSafeInteger(line)) || (column && !Number.isSafeInteger(column))) return undefined;
		return { path, ...(line ? { line, ...(column ? { column } : {}) } : {}) };
	} catch {
		return undefined;
	}
}

export const locationText = ({ path, line, column }: FileLocation): string =>
	`${path}${line ? `:${line}${column ? `:${column}` : ""}` : ""}`;

/**
 * A path an editor cannot read as an option: `referenceLocation` and `/diff --editor` pass absolute paths, so a
 * path that starts with `-` (a flag to every editor CLI) never reaches here; a relative one is refused.
 */
export function assertEditorPath(file: string): string {
	if (!(posix.isAbsolute(file) || win32.isAbsolute(file)) || file.startsWith("-"))
		throw new Error("Only absolute file paths open in an editor");
	return file;
}

/** Editor syntax is selected by the program's name, never by the terminal brand. No argument is evaluated by a shell. */
export function locationInvocation(
	program: string,
	configured: readonly string[],
	location: FileLocation,
): EditorInvocation {
	const args = [...configured];
	const path = assertEditorPath(location.path);
	const family = editorFamily(program);
	// Code reads a trailing `:n` as a line only after `--goto`, so a name like `a:3` without a position stays a name.
	if (family === "vscode")
		args.push("--reuse-window", ...(location.line ? ["--goto", locationText(location)] : [path]));
	else if (family === "suffix") args.push(locationText(location));
	else {
		const name = editorProgramName(program);
		if (location.line) {
			if (/^(?:vi|vim|nvim)$/.test(name)) args.push(`+call cursor(${location.line},${location.column ?? 1})`);
			else if (name === "nano") args.push(`+${location.line},${location.column ?? 1}`);
			else if (/^emacs(?:client)?$/.test(name)) args.push(`+${location.line}:${location.column ?? 1}`);
		}
		args.push(path);
	}
	return { command: program, args };
}

export interface ReferenceHost {
	ui: TUI;
	/** `getExternalEditorCommand` is the prompt editor; `getReferenceOpener` is the `referenceOpener` setting. */
	settingsManager: { getExternalEditorCommand(): string; getReferenceOpener(): string };
	showStatus(message: string): void;
	showError(message: string): void;
	showWarning(message: string): void;
}

/** Run a configured editor with foreground ownership; restore input and rendering on every exit path. */
export async function runReferenceEditor(host: Pick<ReferenceHost, "ui">, invocation: EditorInvocation): Promise<void> {
	host.ui.stop({ preserveScreen: true });
	const release = holdTerminalForChild();
	try {
		await host.ui.terminal.drainOutput?.();
		await new Promise<void>((resolve, reject) => {
			const child = spawn(invocation.command, invocation.args, { stdio: "inherit", shell: false });
			child.once("error", reject);
			child.once("close", (code) =>
				code === 0 ? resolve() : reject(new Error(`Editor exited with ${code ?? "a signal"}`)),
			);
		});
	} finally {
		release();
		host.ui.start();
		host.ui.requestRender(true);
	}
}

/** Opens a reference from model output: web and mail links with the system handler, file locations with `referenceOpener`. */
export async function openReference(
	host: ReferenceHost,
	target: string,
	openerHost: OpenerHost = defaultOpenerHost(),
): Promise<void> {
	try {
		if (!URL.canParse(target) || /[\x00-\x1f\x7f-\x9f]/u.test(target)) throw new Error("Invalid reference target");
		const url = new URL(target);
		if (["https:", "http:", "mailto:"].includes(url.protocol)) {
			await openTarget(url.href);
			return;
		}
		const location = referenceLocation(target);
		if (!location) {
			host.showWarning(`Copy this target to open it with its application: ${sanitizeTerminalText(target)}`);
			return;
		}
		const opener = resolveReferenceOpener(
			host.settingsManager.getReferenceOpener(),
			host.settingsManager.getExternalEditorCommand(),
			openerHost,
		);
		if (opener.source === "system") {
			await openFileWithSystem(assertEditorPath(location.path), { host: openerHost });
			const line = location.line ? ` (go to line ${location.line})` : "";
			host.showStatus(`Opened with the default app: ${sanitizeTerminalText(location.path)}${line}`);
			return;
		}
		const invocation = locationInvocation(opener.command, opener.args, location);
		if (opener.detached) {
			await launchDetached(invocation, { host: openerHost });
			host.showStatus(
				`Opened in ${editorProgramName(opener.command)}: ${sanitizeTerminalText(locationText(location))}`,
			);
			return;
		}
		await runReferenceEditor(host, invocation);
		host.showStatus(`Editor returned: ${locationText(location)}`);
	} catch (error) {
		host.showError(`Could not open reference: ${errorMessage(error)}. Target: ${sanitizeTerminalText(target)}`);
	}
}
