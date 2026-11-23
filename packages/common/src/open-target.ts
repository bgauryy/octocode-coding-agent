import { spawn } from "node:child_process";
import path from "node:path";
import { OPEN_BROWSER_ENV } from "./env.ts";

/** What `openTarget` needs of the host; replaceable so a test never opens a real application. */
export interface OpenTargetOptions {
	platform?: NodeJS.Platform;
	env?: Readonly<Record<string, string | undefined>>;
	spawn?: typeof spawn;
}

/** %SystemRoot%, else %windir%, else `C:\Windows`; a value without a drive letter could resolve elsewhere and is skipped. */
function windowsRoot(env: Readonly<Record<string, string | undefined>>): string {
	for (const name of ["SystemRoot", "windir"]) {
		const key = Object.keys(env).find((each) => each.toLowerCase() === name.toLowerCase());
		const value = key === undefined ? undefined : env[key]?.trim();
		if (value && /^[a-z]:[\\/]/i.test(value)) return path.win32.normalize(value).replace(/\\+$/, "");
	}
	return "C:\\Windows";
}

/**
 * The program and arguments that open `target` with its default handler on `platform`. None goes through a shell:
 * on Windows `cmd /c start` would re-parse the target (`&`, `|`, `^`, and `%VAR%` even inside quotes), so the URL
 * handler is called through `rundll32` by its absolute System32 path, since Windows looks a bare name up in the
 * current folder first.
 */
export function openTargetCommand(
	target: string,
	platform: NodeJS.Platform = process.platform,
	env: Readonly<Record<string, string | undefined>> = process.env,
): { command: string; args: string[] } {
	if (platform === "darwin") return { command: "open", args: [target] };
	if (platform === "win32")
		return {
			command: path.win32.join(windowsRoot(env), "System32", "rundll32.exe"),
			args: ["url.dll,FileProtocolHandler", target],
		};
	return { command: "xdg-open", args: [target] };
}

/**
 * Opens a URL or file with the system's default handler (`open`, `xdg-open` or the Windows URL handler), detached so
 * it outlives this process. Resolves once the opener started; rejects with the spawn error (a missing `xdg-open`, for
 * one), or at once when `OPEN_BROWSER_ENV` is `0`. Whether the handler then succeeds is not reported: callers that
 * need the target used also show it.
 */
export function openTarget(target: string, options: OpenTargetOptions = {}): Promise<void> {
	// A caller's own `spawn` (a test's) is not the system's: only the system opener is turned off.
	if (!options.spawn && (options.env ?? process.env)[OPEN_BROWSER_ENV] === "0")
		return Promise.reject(new Error(`Opening an application is turned off (${OPEN_BROWSER_ENV}=0): ${target}`));
	const { command, args } = openTargetCommand(target, options.platform, options.env);
	return new Promise((resolve, reject) => {
		const child = (options.spawn ?? spawn)(command, args, { detached: true, stdio: "ignore", windowsHide: true });
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}
