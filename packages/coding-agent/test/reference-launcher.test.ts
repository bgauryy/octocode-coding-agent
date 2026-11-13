import { describe, expect, it } from "vitest";
import {
	detectIde,
	resolveReferenceOpener,
	windowsLaunchable,
	type OpenerHost,
} from "../src/modes/interactive/reference-launcher.ts";
import { assertEditorPath, locationInvocation } from "../src/modes/interactive/reference-opener.ts";

const MAC_CODE = "/Applications/Visual Studio Code.app/Contents";
const MAC_CURSOR = "/Applications/Cursor.app/Contents";
const MAC_INSIDERS = "/Applications/Visual Studio Code - Insiders.app/Contents";

/** A host with only the named executables and files; nothing reads this machine. */
function fakeHost(
	env: Record<string, string | undefined>,
	options: {
		platform?: NodeJS.Platform;
		executables?: string[];
		onPath?: Record<string, string>;
		files?: Record<string, string>;
	} = {},
): OpenerHost {
	const executables = new Set(options.executables);
	return {
		env,
		platform: options.platform ?? "darwin",
		isExecutable: (file) => executables.has(file),
		findOnPath: (name) => options.onPath?.[name],
		readText: (file) => options.files?.[file],
	};
}

function vscodeEnv(contents: string, extra: Record<string, string> = {}): Record<string, string> {
	return {
		TERM_PROGRAM: "vscode",
		VSCODE_GIT_IPC_HANDLE: "/tmp/vscode-git.sock",
		VSCODE_GIT_ASKPASS_NODE: `${contents}/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)`,
		VSCODE_GIT_ASKPASS_MAIN: `${contents}/Resources/app/extensions/git/dist/askpass-main.js`,
		...extra,
	};
}

describe("IDE detection", () => {
	it("recognizes VS Code, its forks and a tmux pane inside the IDE terminal", () => {
		expect(detectIde(vscodeEnv(MAC_CODE))).toBe("code");
		expect(detectIde(vscodeEnv(MAC_CURSOR))).toBe("cursor");
		expect(detectIde({ TERM_PROGRAM: "vscode", CURSOR_TRACE_ID: "abc" })).toBe("cursor");
		expect(detectIde(vscodeEnv(MAC_INSIDERS))).toBe("code-insiders");
		expect(detectIde({ TERM_PROGRAM: "vscode", TERM_PROGRAM_VERSION: "1.96.0-insider" })).toBe("code-insiders");
		expect(detectIde({ TERM_PROGRAM: "vscode", VSCODE_GIT_ASKPASS_NODE: "/usr/share/codium/codium" })).toBe("codium");
		expect(detectIde({ TERM_PROGRAM: "tmux", VSCODE_GIT_IPC_HANDLE: "/tmp/s.sock" })).toBe("code");
		expect(detectIde({ VSCODE_IPC_HOOK_CLI: "/run/user/1000/vscode-ipc.sock" })).toBe("code");
	});

	it("break-test: another terminal or a stray askpass path is not an IDE", () => {
		expect(detectIde({ TERM_PROGRAM: "iTerm.app" })).toBeUndefined();
		expect(detectIde({ TERM_PROGRAM: "Apple_Terminal", VSCODE_GIT_ASKPASS_MAIN: `${MAC_CODE}/x.js` })).toBeUndefined();
		expect(detectIde({})).toBeUndefined();
	});
});

describe("referenceOpener resolution", () => {
	it("auto inside VS Code uses the IDE's own CLI when `code` is not on PATH", () => {
		const cli = `${MAC_CODE}/Resources/app/bin/code`;
		expect(resolveReferenceOpener("auto", "vim", fakeHost(vscodeEnv(MAC_CODE), { executables: [cli] }))).toEqual({
			command: cli,
			args: [],
			detached: true,
			source: "ide",
		});
	});

	it("auto inside Cursor and Insiders uses the CLI product.json names", () => {
		const cursor = `${MAC_CURSOR}/Resources/app/bin/cursor`;
		const cursorHost = fakeHost(vscodeEnv(MAC_CURSOR, { CURSOR_TRACE_ID: "t" }), {
			executables: [`${MAC_CURSOR}/Resources/app/bin/code`, cursor],
			files: { [`${MAC_CURSOR}/Resources/app/product.json`]: '{"applicationName": "cursor"}' },
		});
		expect(resolveReferenceOpener("auto", "vim", cursorHost).command).toBe(cursor);
		const insiders = `${MAC_INSIDERS}/Resources/app/bin/code-insiders`;
		const insidersHost = fakeHost(vscodeEnv(MAC_INSIDERS), {
			executables: [insiders],
			files: { [`${MAC_INSIDERS}/Resources/app/product.json`]: '{"applicationName":"code-insiders"}' },
		});
		expect(resolveReferenceOpener("auto", "vim", insidersHost)).toMatchObject({ command: insiders, source: "ide" });
	});

	it("auto finds a Linux install's bin folder and a remote server's remote CLI", () => {
		const linux = fakeHost(
			{
				TERM_PROGRAM: "vscode",
				DISPLAY: ":0",
				VSCODE_GIT_ASKPASS_MAIN: "/usr/share/codium/resources/app/extensions/git/dist/askpass-main.js",
			},
			{ platform: "linux", executables: ["/usr/share/codium/bin/codium"] },
		);
		expect(resolveReferenceOpener("auto", "nano", linux).command).toBe("/usr/share/codium/bin/codium");
		const server = "/home/u/.vscode-server/bin/abc123";
		const remote = fakeHost(
			{
				TERM_PROGRAM: "tmux",
				SSH_CONNECTION: "10.0.0.1 1 10.0.0.2 22",
				VSCODE_IPC_HOOK_CLI: "/run/user/1000/vscode-ipc.sock",
				VSCODE_GIT_ASKPASS_NODE: `${server}/node`,
				VSCODE_GIT_ASKPASS_MAIN: `${server}/extensions/git/dist/askpass-main.js`,
			},
			{ platform: "linux", executables: [`${server}/bin/remote-cli/code`] },
		);
		expect(resolveReferenceOpener("auto", "nano", remote)).toMatchObject({
			command: `${server}/bin/remote-cli/code`,
			source: "ide",
		});
	});

	it("auto inside VS Code on Windows launches Code.exe, never the .cmd shim", () => {
		const exe = "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe";
		const host = fakeHost(
			{
				TERM_PROGRAM: "vscode",
				VSCODE_GIT_ASKPASS_NODE: exe,
				VSCODE_GIT_ASKPASS_MAIN:
					"C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\resources\\app\\extensions\\git\\dist\\askpass-main.js",
			},
			{ platform: "win32", executables: [exe] },
		);
		expect(resolveReferenceOpener("auto", "notepad", host)).toMatchObject({ command: exe, detached: true });
	});

	it("auto outside an IDE takes the first GUI CLI on PATH, in order", () => {
		const host = fakeHost(
			{ TERM_PROGRAM: "iTerm.app" },
			{ onPath: { zed: "/usr/local/bin/zed", code: "/usr/local/bin/code" } },
		);
		expect(resolveReferenceOpener("auto", "vim", host)).toEqual({
			command: "/usr/local/bin/code",
			args: [],
			detached: true,
			source: "path",
		});
		const zedOnly = fakeHost({}, { onPath: { zed: "/usr/local/bin/zed" } });
		expect(resolveReferenceOpener("auto", "vim", zedOnly)).toMatchObject({
			command: "/usr/local/bin/zed",
			detached: true,
		});
	});

	it("auto with nothing found, over SSH, or on Linux without a display keeps the terminal editor", () => {
		const editor = { command: "vim", args: [], detached: false, source: "editor" };
		expect(resolveReferenceOpener("auto", "vim", fakeHost({}))).toEqual(editor);
		const onPath = { onPath: { code: "/usr/bin/code" } };
		expect(resolveReferenceOpener("auto", "vim", fakeHost({ SSH_TTY: "/dev/ttys001" }, onPath))).toEqual(editor);
		expect(resolveReferenceOpener("auto", "vim", fakeHost({}, { ...onPath, platform: "linux" }))).toEqual(editor);
		expect(
			resolveReferenceOpener("auto", "vim", fakeHost({ DISPLAY: ":0" }, { ...onPath, platform: "linux" })).source,
		).toBe("path");
	});

	it("break-test: an IDE whose CLI is missing falls through instead of launching a guess", () => {
		const host = fakeHost(vscodeEnv(MAC_CODE), { onPath: { zed: "/opt/bin/zed" } });
		expect(resolveReferenceOpener("auto", "vim", host)).toMatchObject({ command: "/opt/bin/zed", source: "path" });
		expect(resolveReferenceOpener("auto", "vim", fakeHost(vscodeEnv(MAC_CODE)))).toMatchObject({
			command: "vim",
			detached: false,
		});
	});

	it("an explicit command and `editor` keep their words; GUI editors drop --wait", () => {
		expect(resolveReferenceOpener('"/opt/My Editor/cursor" --new-window', "vim", fakeHost({}))).toEqual({
			command: "/opt/My Editor/cursor",
			args: ["--new-window"],
			detached: true,
			source: "setting",
		});
		expect(resolveReferenceOpener("nvim --clean", "code", fakeHost({}))).toEqual({
			command: "nvim",
			args: ["--clean"],
			detached: false,
			source: "setting",
		});
		expect(resolveReferenceOpener("editor", "code --wait", fakeHost(vscodeEnv(MAC_CODE)))).toEqual({
			command: "code",
			args: [],
			detached: true,
			source: "editor",
		});
		expect(resolveReferenceOpener("editor", "emacs -nw", fakeHost({}))).toMatchObject({
			detached: false,
			args: ["-nw"],
		});
	});
});

describe("editor arguments", () => {
	it("keeps a path with spaces and its position as one argument", () => {
		const location = { path: "/work/space dir/a.ts", line: 12, column: 3 };
		expect(locationInvocation("/bin/code", [], location).args).toEqual([
			"--reuse-window",
			"--goto",
			"/work/space dir/a.ts:12:3",
		]);
		expect(locationInvocation("/bin/code", [], { path: "/work/a:3" }).args).toEqual(["--reuse-window", "/work/a:3"]);
		expect(locationInvocation("/usr/bin/zed", [], { path: "/w/a b.ts", line: 2 }).args).toEqual(["/w/a b.ts:2"]);
		expect(locationInvocation("C:\\Code\\Code.exe", [], { path: "C:\\w\\a b.ts", line: 4 }).args).toEqual([
			"--reuse-window",
			"--goto",
			"C:\\w\\a b.ts:4",
		]);
	});

	it("break-test: a path that could read as an option or a relative path is refused", () => {
		expect(() => locationInvocation("code", [], { path: "--disable-extensions", line: 1 })).toThrow(/absolute/);
		expect(() => locationInvocation("vim", [], { path: "-c!rm" })).toThrow(/absolute/);
		expect(() => assertEditorPath("a.ts")).toThrow(/absolute/);
		expect(assertEditorPath("/-x/a.ts")).toBe("/-x/a.ts");
	});

	it("replaces a Windows .cmd shim with the executable it starts", () => {
		const cmd = "C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd";
		const shim = [
			"@echo off",
			"setlocal",
			"set ELECTRON_RUN_AS_NODE=1",
			'"%~dp0..\\Code.exe" "%~dp0..\\resources\\app\\out\\cli.js" %*',
			"endlocal",
		].join("\r\n");
		const host = {
			platform: "win32" as const,
			findOnPath: (name: string) => (name === "code" ? cmd : undefined),
			readText: () => shim,
		};
		const args = ["--reuse-window", "--goto", "C:\\w\\a & b.ts:4"];
		expect(windowsLaunchable({ command: "code", args }, host)).toEqual({
			command: "C:\\Program Files\\Microsoft VS Code\\Code.exe",
			args,
		});
		expect(() =>
			windowsLaunchable({ command: cmd, args }, { ...host, readText: () => "@echo off\r\nstart %*" }),
		).toThrow(/cannot start without a shell/);
		expect(windowsLaunchable({ command: "code", args }, { ...host, platform: "darwin" })).toEqual({
			command: "code",
			args,
		});
	});
});
