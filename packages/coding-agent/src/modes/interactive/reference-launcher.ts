import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { findOnPath } from "../../../../common/src/find-on-path.ts";
import { detectIde } from "../../../../common/src/terminal-host.ts";
import { openTargetCommand } from "../../../../common/src/open-target.ts";
import { splitConfigWords } from "../../configuration/command.ts";

/**
 * Which program opens a file reference (`referenceOpener`). GUI editors start detached beside the session; any other
 * program takes the terminal until it exits. Every result is a program and separate arguments: nothing here builds a
 * shell string, and a Windows `.cmd` shim is replaced by the executable it starts.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** `vscode`: Code-family CLIs (`--goto`, `--diff`); `suffix`: Zed and Sublime Text (`path:line:col`); `terminal`: anything else. */
export type EditorFamily = "vscode" | "suffix" | "terminal";

export interface EditorInvocation {
	command: string;
	args: string[];
}

export interface ReferenceOpener extends EditorInvocation {
	/** True for a GUI editor: started detached, the session keeps the terminal. */
	detached: boolean;
	/**
	 * `ide`: the IDE whose terminal runs Octocode; `path`: a GUI CLI found on PATH; `system`: the system's default app
	 * for the file (`openFileWithSystem`); `setting`: an explicit command; `editor`: the prompt editor.
	 */
	source: "ide" | "path" | "system" | "setting" | "editor";
}

/** What resolution reads from the host; each part is replaceable so a test never depends on this machine. */
export interface OpenerHost {
	env: Env;
	platform: NodeJS.Platform;
	isExecutable(file: string): boolean;
	findOnPath(name: string): string | undefined;
	readText(file: string): string | undefined;
}

/** GUI CLIs tried on PATH when `auto` runs outside an IDE, in this order. */
const GUI_EDITOR_CLIS = ["code", "cursor", "code-insiders", "codium", "zed", "subl"] as const;

const VSCODE_NAMES = /^(?:code|code-insiders|code - insiders|codium|vscodium|cursor)$/;
const SUFFIX_NAMES = /^(?:subl|sublime_text|zed)$/;
const WAIT_FLAGS = new Set(["--wait", "-w"]);

/** The program's file name, lower case, without a Windows executable suffix. */
export function editorProgramName(program: string): string {
	return path.posix
		.basename(program.replaceAll("\\", "/"))
		.replace(/\.(?:exe|cmd|bat)$/i, "")
		.toLowerCase();
}

export function editorFamily(program: string): EditorFamily {
	const name = editorProgramName(program);
	return VSCODE_NAMES.test(name) ? "vscode" : SUFFIX_NAMES.test(name) ? "suffix" : "terminal";
}

function executable(file: string): boolean {
	try {
		if (!statSync(file).isFile()) return false;
		accessSync(file, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function readText(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

export function defaultOpenerHost(): OpenerHost {
	return {
		env: process.env,
		platform: process.platform,
		isExecutable: executable,
		findOnPath: (name) => findOnPath(name, process.env),
		readText,
	};
}

/**
 * The IDE's own CLI, found from its Git askpass paths (set in every integrated terminal), so a `code` command that
 * was never installed on PATH still works. `askpass-main.js` lives under `<app>/extensions/`; the CLI is in
 * `<app>/bin` (macOS), `<app>/../../bin` (Windows, Linux) or `<app>/bin/remote-cli` (a remote server). On Windows
 * the askpass Node is the IDE's own executable, which takes the same arguments without a `.cmd` shim.
 */
function ideCli(host: OpenerHost, name: string): string | undefined {
	const p = host.platform === "win32" ? path.win32 : path.posix;
	const node = host.env.VSCODE_GIT_ASKPASS_NODE;
	if (host.platform === "win32" && node && /\.exe$/i.test(node) && !/^node\.exe$/i.test(p.basename(node))) {
		if (host.isExecutable(node)) return node;
	}
	const main = host.env.VSCODE_GIT_ASKPASS_MAIN;
	const marker = main ? main.lastIndexOf(`${p.sep}extensions${p.sep}`) : -1;
	const dirs: string[] = [];
	const names = [name];
	if (main && marker > 0) {
		const app = main.slice(0, marker);
		dirs.push(p.join(app, "bin", "remote-cli"), p.join(app, "bin"), p.join(app, "..", "..", "bin"));
		// A fork names its CLI in product.json (`cursor`, `codium`, ...); the name is a word, never a path.
		const product = /"applicationName"\s*:\s*"([\w.-]+)"/.exec(host.readText(p.join(app, "product.json")) ?? "")?.[1];
		if (product && product !== name) names.unshift(product);
	}
	if (node) dirs.push(p.join(p.dirname(node), "bin", "remote-cli"));
	return ideCliIn(host, dirs, names) ?? host.findOnPath(name);
}

function ideCliIn(host: OpenerHost, dirs: string[], names: string[]): string | undefined {
	const p = host.platform === "win32" ? path.win32 : path.posix;
	const suffixes = host.platform === "win32" ? [".exe", ".cmd"] : [""];
	for (const dir of dirs)
		for (const name of names)
			for (const suffix of suffixes) {
				const file = p.join(dir, `${name}${suffix}`);
				if (host.isExecutable(file)) return file;
			}
	return undefined;
}

/** True when a GUI found on PATH could not show a window here: an SSH login, or Linux without a display. */
function headless(host: OpenerHost): boolean {
	if (host.env.SSH_CONNECTION || host.env.SSH_TTY) return true;
	return host.platform === "linux" && !host.env.DISPLAY && !host.env.WAYLAND_DISPLAY;
}

function opener(command: string, args: string[], source: ReferenceOpener["source"]): ReferenceOpener {
	const detached = editorFamily(command) !== "terminal";
	// A detached editor is never waited for, so a configured `--wait` would only leave its CLI running.
	return { command, args: detached ? args.filter((arg) => !WAIT_FLAGS.has(arg)) : args, detached, source };
}

function fromCommand(text: string, source: "setting" | "editor"): ReferenceOpener {
	const [program, ...args] = splitConfigWords(text);
	if (!program) throw new Error("No editor configured");
	return opener(program, args, source);
}

/**
 * The program for `referenceOpener`: `auto` tries (a) the IDE whose terminal runs Octocode, (b) the first GUI CLI on
 * PATH, (c) the system's default app for the file, and only in a headless session (SSH, Linux without a display)
 * (d) the prompt editor, which takes over the terminal; `editor` is the prompt editor; anything else is a command.
 * `editorCommand` is the prompt editor (`externalEditor`, `VISUAL`, `EDITOR`, platform default).
 */
export function resolveReferenceOpener(
	setting: string,
	editorCommand: string,
	host: OpenerHost = defaultOpenerHost(),
): ReferenceOpener {
	const value = setting.trim() || "auto";
	if (value === "editor") return fromCommand(editorCommand, "editor");
	if (value !== "auto") return fromCommand(value, "setting");
	const ide = detectIde(host.env);
	const ideCommand = ide && ideCli(host, ide);
	if (ideCommand) return opener(ideCommand, [], "ide");
	if (!headless(host)) {
		for (const name of GUI_EDITOR_CLIS) {
			const found = host.findOnPath(name);
			if (found) return opener(found, [], "path");
		}
		const { command, args } = openTargetCommand("", host.platform, host.env);
		return { command, args: args.slice(0, -1), detached: true, source: "system" };
	}
	return fromCommand(editorCommand, "editor");
}

/** How long a system opener may run before it counts as started: `open` and most `xdg-open` handlers exit at once. */
const SYSTEM_OPEN_WAIT_MS = 3000;

/**
 * Opens `file` with the system's default app for it (`open`, `xdg-open`, the Windows URL handler), detached, without
 * a shell. Rejects when the opener cannot start or exits with a failure, as `open` does for a file type no app
 * claims; on macOS that file then opens in the default text editor (`open -t`).
 */
export async function openFileWithSystem(
	file: string,
	options: { spawn?: typeof spawn; host?: Pick<OpenerHost, "env" | "platform"> } = {},
): Promise<void> {
	const host = options.host ?? defaultOpenerHost();
	const run = (command: string, args: string[]) =>
		new Promise<number | null>((resolve, reject) => {
			const child = (options.spawn ?? spawn)(command, args, {
				detached: true,
				stdio: "ignore",
				shell: false,
				windowsHide: true,
				env: launchEnv(host.env),
			});
			const timer = setTimeout(() => resolve(0), SYSTEM_OPEN_WAIT_MS);
			timer.unref();
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("exit", (code) => {
				clearTimeout(timer);
				resolve(code);
			});
			child.unref();
		});
	const { command, args } = openTargetCommand(file, host.platform, host.env);
	let code = await run(command, args);
	if (code !== 0 && host.platform === "darwin") code = await run(command, ["-t", file]);
	if (code !== 0) throw new Error(`${path.basename(command)} found no app for this file (exit ${code ?? "signal"})`);
}

/**
 * Windows starts a `.cmd` or `.bat` file only through `cmd.exe`, which re-parses its arguments. A Code-family shim
 * starts its executable as `"%~dp0..\Code.exe" "%~dp0..\...\cli.js" %*`; that executable takes the same arguments
 * directly, so it is launched instead. Other platforms and plain executables are unchanged.
 */
export function windowsLaunchable(
	invocation: EditorInvocation,
	host: Pick<OpenerHost, "platform" | "findOnPath" | "readText">,
): EditorInvocation {
	if (host.platform !== "win32") return invocation;
	const program = /[\\/]/.test(invocation.command)
		? invocation.command
		: (host.findOnPath(invocation.command) ?? invocation.command);
	if (!/\.(?:cmd|bat)$/i.test(program)) return { ...invocation, command: program };
	const target = /"%~dp0([^"%]+?\.exe)"/i.exec(host.readText(program) ?? "")?.[1];
	if (!target)
		throw new Error(
			`${path.win32.basename(program)} is a command script that cannot start without a shell; set referenceOpener to the editor's .exe`,
		);
	return { command: path.win32.resolve(path.win32.dirname(program), target), args: invocation.args };
}

/** The environment a detached editor gets: this one, without the flag that would make an Electron editor run as Node. */
function launchEnv(env: Env): NodeJS.ProcessEnv {
	const copy: NodeJS.ProcessEnv = { ...env };
	delete copy.ELECTRON_RUN_AS_NODE;
	return copy;
}

/**
 * Starts a GUI editor detached, without a shell and without the terminal: resolves once it started, rejects with the
 * spawn error. The session keeps rendering; whether the editor then finds the file is the editor's to report.
 */
export function launchDetached(
	invocation: EditorInvocation,
	options: { spawn?: typeof spawn; host?: Pick<OpenerHost, "env" | "platform" | "findOnPath" | "readText"> } = {},
): Promise<void> {
	const host = options.host ?? defaultOpenerHost();
	return new Promise((resolve, reject) => {
		const { command, args } = windowsLaunchable(invocation, host);
		const child = (options.spawn ?? spawn)(command, args, {
			detached: true,
			stdio: "ignore",
			shell: false,
			env: launchEnv(host.env),
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}
