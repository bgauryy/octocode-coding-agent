import { spawn } from "node:child_process";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { openTarget } from "../../../../common/src/open-target.ts";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import { splitConfigWords } from "../../configuration/command.ts";
import { holdTerminalForChild } from "../../utils/foreground-child.ts";
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

/** Editor syntax is selected by the configured program, never by the terminal brand. No argument is evaluated by a shell. */
export function editorLocationCommand(command: string, location: FileLocation): { command: string; args: string[] } {
	const [program, ...args] = splitConfigWords(command);
	if (!program) throw new Error("No external editor configured");
	const name = basename(program.replaceAll("\\", "/"))
		.replace(/\.(?:exe|cmd|bat)$/i, "")
		.toLowerCase();
	if (/^(?:code|code-insiders|codium|cursor)$/.test(name))
		args.push("--reuse-window", "--goto", locationText(location));
	else if (/^(?:subl|sublime_text|zed)$/.test(name)) args.push(locationText(location));
	else {
		if (location.line) {
			if (/^(?:vi|vim|nvim)$/.test(name)) args.push(`+call cursor(${location.line},${location.column ?? 1})`);
			else if (name === "nano") args.push(`+${location.line},${location.column ?? 1}`);
			else if (/^emacs(?:client)?$/.test(name)) args.push(`+${location.line}:${location.column ?? 1}`);
		}
		args.push(location.path);
	}
	return { command: program, args };
}

export interface ReferenceHost {
	ui: TUI;
	settingsManager: { getExternalEditorCommand(): string };
	showStatus(message: string): void;
	showError(message: string): void;
	showWarning(message: string): void;
}

/** Run a configured editor with foreground ownership; restore input and rendering on every exit path. */
export async function runReferenceEditor(
	host: Pick<ReferenceHost, "ui">,
	invocation: { command: string; args: string[] },
): Promise<void> {
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

export async function openReference(host: ReferenceHost, target: string): Promise<void> {
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
		const invocation = editorLocationCommand(host.settingsManager.getExternalEditorCommand(), location);
		await runReferenceEditor(host, invocation);
		host.showStatus(`Editor returned: ${locationText(location)}`);
	} catch (error) {
		host.showError(`Could not open reference: ${errorMessage(error)}. Target: ${sanitizeTerminalText(target)}`);
	}
}
