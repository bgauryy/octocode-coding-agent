import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenerHost } from "../src/modes/interactive/reference-launcher.ts";

const { spawn, release } = vi.hoisted(() => ({ spawn: vi.fn(), release: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
vi.mock("../src/utils/foreground-child.ts", () => ({ holdTerminalForChild: () => release }));

import { openEditorDiff } from "../src/modes/interactive/editor-diff.ts";
import { openReference } from "../src/modes/interactive/reference-opener.ts";

class FakeChild extends EventEmitter {
	unref = vi.fn();
}

const CODE = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
const vscode: OpenerHost = {
	env: {
		TERM_PROGRAM: "vscode",
		VSCODE_GIT_ASKPASS_MAIN: "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/git/dist/a.js",
		ELECTRON_RUN_AS_NODE: "1",
		PATH: "/usr/bin",
	},
	platform: "darwin",
	isExecutable: (file) => file === CODE,
	findOnPath: () => undefined,
	readText: () => undefined,
};
const plain: OpenerHost = { ...vscode, env: { PATH: "/usr/bin" }, isExecutable: () => false };

function host(opener = "auto", editor = "nvim") {
	return {
		ui: {
			stop: vi.fn(),
			start: vi.fn(),
			requestRender: vi.fn(),
			terminal: { drainOutput: vi.fn().mockResolvedValue(undefined) },
		},
		settingsManager: { getReferenceOpener: () => opener, getExternalEditorCommand: () => editor },
		sessionManager: { getCwd: () => "/work/space dir" },
		showStatus: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
	};
}

/** Lets the spawned child report `event` once the launcher listens. */
function nextChild(event: "spawn" | "close" | "error", value?: unknown): FakeChild {
	const child = new FakeChild();
	spawn.mockImplementationOnce(() => {
		queueMicrotask(() => child.emit(event, value));
		return child;
	});
	return child;
}

beforeEach(() => {
	spawn.mockReset();
	release.mockReset();
});

describe("opening a file reference", () => {
	it("starts the IDE detached and keeps the session's terminal", async () => {
		const ui = host();
		const child = nextChild("spawn");
		await openReference(ui as never, "file:///work/space%20dir/a.ts#L12:3", vscode);
		expect(spawn).toHaveBeenCalledOnce();
		const [command, args, options] = spawn.mock.calls[0];
		expect(command).toBe(CODE);
		expect(args).toEqual(["--reuse-window", "--goto", "/work/space dir/a.ts:12:3"]);
		expect(options).toMatchObject({ detached: true, stdio: "ignore", shell: false });
		expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
		expect(options.env.PATH).toBe("/usr/bin");
		expect(child.unref).toHaveBeenCalledOnce();
		expect(ui.ui.stop).not.toHaveBeenCalled();
		expect(release).not.toHaveBeenCalled();
		expect(ui.showStatus).toHaveBeenCalledWith("Opened in code: /work/space dir/a.ts:12:3");
		expect(ui.showError).not.toHaveBeenCalled();
	});

	it("break-test: an editor that cannot start is reported and the terminal was never handed over", async () => {
		const ui = host("/missing/code");
		nextChild("error", new Error("spawn /missing/code ENOENT"));
		await openReference(ui as never, "file:///work/a.ts#L2", plain);
		expect(ui.ui.stop).not.toHaveBeenCalled();
		expect(ui.showError).toHaveBeenCalledExactlyOnceWith(
			"Could not open reference: spawn /missing/code ENOENT. Target: file:///work/a.ts#L2",
		);
		expect(ui.showStatus).not.toHaveBeenCalled();
	});

	it("keeps the foreground handoff for a terminal editor", async () => {
		const ui = host("auto", "nvim");
		nextChild("close", 0);
		await openReference(ui as never, "file:///work/a.ts#L4:2", plain);
		expect(spawn).toHaveBeenCalledWith("nvim", ["+call cursor(4,2)", "/work/a.ts"], { stdio: "inherit", shell: false });
		expect(ui.ui.stop).toHaveBeenCalledOnce();
		expect(ui.ui.start).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledOnce();
		expect(ui.showStatus).toHaveBeenCalledWith("Editor returned: /work/a.ts:4:2");
	});

	it("never passes a reference with controls or another scheme to an editor", async () => {
		const ui = host();
		await openReference(ui as never, "file:///work/a%0A.ts", vscode);
		await openReference(ui as never, "javascript:alert(1)", vscode);
		expect(spawn).not.toHaveBeenCalled();
		expect(ui.showWarning).toHaveBeenCalledTimes(2);
	});
});

describe("/diff --editor", () => {
	it("compares in the IDE with --diff, detached", async () => {
		const ui = host();
		nextChild("spawn");
		await openEditorDiff(ui as never, '"before file" after.ts', vscode);
		expect(spawn).toHaveBeenCalledWith(
			CODE,
			["--reuse-window", "--diff", "/work/space dir/before file", "/work/space dir/after.ts"],
			expect.objectContaining({ detached: true, stdio: "ignore", shell: false }),
		);
		expect(ui.ui.stop).not.toHaveBeenCalled();
		expect(ui.showStatus).toHaveBeenCalledWith("Diff opened in code. The compared files remain on disk.");
	});

	it("keeps the prompt editor's terminal diff otherwise", async () => {
		const ui = host("auto", "vim");
		nextChild("close", 0);
		await openEditorDiff(ui as never, "a b", plain);
		expect(spawn).toHaveBeenCalledWith("vim", ["-d", "/work/space dir/a", "/work/space dir/b"], {
			stdio: "inherit",
			shell: false,
		});
		expect(ui.ui.stop).toHaveBeenCalledOnce();
	});

	it("break-test: a failed detached diff is reported once, without a terminal fallback", async () => {
		const ui = host();
		nextChild("error", new Error("spawn EACCES"));
		await openEditorDiff(ui as never, "a b", vscode);
		expect(spawn).toHaveBeenCalledOnce();
		expect(ui.ui.stop).not.toHaveBeenCalled();
		expect(ui.showError).toHaveBeenCalledExactlyOnceWith(
			"Could not open editor diff: spawn EACCES. Use /diff [path] to review changes in the terminal.",
		);
	});
});
