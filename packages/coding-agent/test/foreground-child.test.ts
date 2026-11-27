import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { editInExternalEditor } from "../src/modes/interactive/external-editor.ts";
import * as lifecycle from "../src/modes/interactive/interactive-mode/lifecycle.ts";
import { foregroundChildActive, holdTerminalForChild } from "../src/utils/foreground-child.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

type SignalContext = {
	signalCleanupHandlers: Array<() => void>;
	shutdown: (options?: { fromSignal?: boolean }) => Promise<void>;
	unregisterSignalHandlers: () => void;
};

const SIGNALS = ["SIGINT", "SIGTERM"] as const;

describe("a foreground child owns Ctrl+C", () => {
	let context: SignalContext | undefined;
	let foreign: Map<string, Set<unknown>>;
	const releases: Array<() => void> = [];

	// The test runner's worker exits on these signals: dispatch only to the listeners these tests add.
	function deliver(signal: (typeof SIGNALS)[number]): void {
		for (const listener of process.listeners(signal)) {
			if (!foreign.get(signal)?.has(listener)) (listener as () => void)();
		}
	}

	function register(): SignalContext {
		const created: SignalContext = {
			signalCleanupHandlers: [],
			shutdown: vi.fn(async () => {}),
			unregisterSignalHandlers: () => lifecycle.unregisterSignalHandlers(createFakeHost(created)),
		};
		lifecycle.registerSignalHandlers(createFakeHost(created));
		context = created;
		return created;
	}

	function hold(): () => void {
		const release = holdTerminalForChild();
		releases.push(release);
		return release;
	}

	beforeEach(() => {
		foreign = new Map(SIGNALS.map((signal) => [signal, new Set<unknown>(process.listeners(signal))]));
	});

	afterEach(() => {
		for (const release of releases.splice(0)) release();
		context?.unregisterSignalHandlers();
		context = undefined;
		vi.restoreAllMocks();
	});

	test("a SIGINT while a child holds the terminal is ignored, and shuts down again after release", () => {
		const ctx = register();
		const release = hold();

		deliver("SIGINT");
		expect(ctx.shutdown).not.toHaveBeenCalled();

		release();
		deliver("SIGINT");
		expect(ctx.shutdown).toHaveBeenCalledWith({ fromSignal: true });
	});

	test("a SIGTERM while a child holds the terminal still shuts down", () => {
		const ctx = register();
		hold();

		deliver("SIGTERM");

		expect(ctx.shutdown).toHaveBeenCalledWith({ fromSignal: true });
	});

	test("nested holds keep the guard until the last release, and a second release does nothing", () => {
		const ctx = register();
		const first = hold();
		const second = hold();

		first();
		first();
		expect(foregroundChildActive()).toBe(true);
		deliver("SIGINT");
		expect(ctx.shutdown).not.toHaveBeenCalled();

		second();
		expect(foregroundChildActive()).toBe(false);
		deliver("SIGINT");
		expect(ctx.shutdown).toHaveBeenCalledTimes(1);
	});

	test("a hold keeps a SIGINT listener so Node's default exit cannot end Octocode, and removes it on release", () => {
		const before = process.listenerCount("SIGINT");
		const release = hold();
		expect(process.listenerCount("SIGINT")).toBe(before + 1);

		release();
		expect(process.listenerCount("SIGINT")).toBe(before);
	});

	test.skipIf(process.platform === "win32")(
		"the external editor holds the terminal while it runs and releases it when it exits",
		async () => {
			const directory = mkdtempSync(join(tmpdir(), "octocode-fg-editor-"));
			try {
				const editor = join(directory, "editor.sh");
				writeFileSync(editor, "#!/bin/sh\nsleep 0.3\n");
				chmodSync(editor, 0o755);
				vi.spyOn(process.stdout, "write").mockImplementation(() => true);

				const running = editInExternalEditor({ command: editor, content: "draft" });
				expect(foregroundChildActive()).toBe(true);

				await expect(running).resolves.toEqual({ status: "complete", content: "draft" });
				expect(foregroundChildActive()).toBe(false);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	test("the external editor releases the terminal when the editor cannot start", async () => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const result = await editInExternalEditor({ command: "/nonexistent/octocode-editor", content: "x" });

		expect(result.status).toBe("failed");
		expect(foregroundChildActive()).toBe(false);
	});
});
