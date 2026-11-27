import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
	spawn: vi.fn(),
}));

vi.mock("node:child_process", () => childProcessMocks);

import { shareSession } from "../src/modes/interactive/session-share.ts";
import type { StatusText } from "../src/modes/interactive/interactive-mode/types.ts";
import { initTheme } from "../src/theme/theme.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

type FakeChild = EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void };

function fakeChild(): FakeChild {
	return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
}

/** A gh process that prints `stdout` and exits with `code`. */
function exitingChild(stdout: string, code: number): FakeChild {
	const child = fakeChild();
	queueMicrotask(() => {
		child.stdout.end(stdout);
		child.stderr.end();
		child.emit("close", code);
	});
	return child;
}

/** A gh process that cannot start: Node emits `error`, then `close` with a negative code. */
function failingChild(message: string, code: string, exitCode: number): FakeChild {
	const child = fakeChild();
	queueMicrotask(() => child.emit("error", Object.assign(new Error(message), { code })));
	setTimeout(() => child.emit("close", exitCode), 0);
	return child;
}

/** Answer `gh auth status` with `auth`, and every other gh call with `gist`. */
function fakeGh(gist: (args: string[]) => FakeChild, auth: () => FakeChild = () => exitingChild("", 0)): void {
	childProcessMocks.spawn.mockImplementation((_command: string, args: string[]) =>
		args[0] === "auth" ? auth() : gist(args),
	);
}

function shareContext(errors: string[], statuses: StatusText[] = []) {
	return {
		session: {
			sessionManager: { getSessionId: () => "gist", getCwd: () => "/tmp", getBranch: () => [] },
			state: { systemPrompt: "", tools: [] },
			exportToHtml: async (filePath: string) => writeFileSync(filePath, "html"),
		},
		ui: { setFocus() {}, requestRender() {} },
		editorContainer: { clear() {}, addChild() {} },
		editor: {},
		showStatus: (message: StatusText) => statuses.push(message),
		showError: (message: string) => errors.push(message),
	};
}

describe("shareSession", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => vi.clearAllMocks());

	it("keeps concurrent session exports isolated", async () => {
		const uploads: string[] = [];
		fakeGh((args) => {
			uploads.push(readFileSync(args.at(-1)!, "utf8"));
			return exitingChild(`https://gist.github.com/test/${uploads.length}\n`, 0);
		});

		const aWritten = deferred();
		const bWritten = deferred();
		const releaseB = deferred();
		const errors: string[] = [];
		const context = (name: "A" | "B") => ({
			session: {
				sessionManager: {
					getSessionId: () => name,
					getCwd: () => "/tmp",
					getBranch: () => [],
				},
				state: { systemPrompt: name, tools: [] },
				exportToHtml: async (filePath: string) => {
					writeFileSync(filePath, name);
					if (name === "A") {
						aWritten.resolve();
						await bWritten.promise;
					} else {
						bWritten.resolve();
						await releaseB.promise;
					}
				},
			},
			ui: { setFocus() {}, requestRender() {} },
			editorContainer: { clear() {}, addChild() {} },
			editor: {},
			showStatus() {},
			showError(message: string) {
				errors.push(message);
			},
		});

		const shareA = shareSession(context("A") as never);
		await aWritten.promise;
		const shareB = shareSession(context("B") as never);
		await bWritten.promise;
		await shareA;
		releaseB.resolve();
		await shareB;

		expect(uploads).toEqual(["A", "B"]);
		expect(errors).toEqual([]);
	});

	it("shares the HTML export as a private gist", async () => {
		fakeGh((args) => {
			expect(readFileSync(args.at(-1)!, "utf8")).toBe("html");
			return exitingChild("https://gist.github.com/test/forced-gist\n", 0);
		});
		const errors: string[] = [];
		const statuses: StatusText[] = [];

		await shareSession(shareContext(errors, statuses) as never);

		expect(childProcessMocks.spawn).toHaveBeenCalledWith("gh", ["auth", "status"]);
		expect(childProcessMocks.spawn).toHaveBeenCalledWith("gh", [
			"gist",
			"create",
			"--public=false",
			expect.any(String),
		]);
		expect(errors).toEqual([]);
		// Links go to the status helper as parts it validates and draws, never as caller-built escape sequences.
		expect(statuses[0]).toContainEqual({ url: "https://gist.github.com/forced-gist" });
		expect(statuses[0]).toContainEqual({ url: "https://gist.github.com/test/forced-gist" });
	});

	it("shows the text of a non-Error export failure instead of a generic line", async () => {
		fakeGh(() => exitingChild("", 0));
		const errors: string[] = [];
		const context = shareContext(errors);
		context.session.exportToHtml = async () => {
			// oxlint-disable-next-line typescript/only-throw-error -- the test needs a non-Error rejection
			throw "disk quota exceeded";
		};

		await shareSession(context as never);

		expect(errors).toEqual(["Failed to export session: disk quota exceeded"]);
	});

	it("reports a gh gist spawn failure instead of throwing it", async () => {
		fakeGh(() => failingChild("spawn gh EACCES", "EACCES", -13));
		const errors: string[] = [];

		await shareSession(shareContext(errors) as never);

		expect(errors).toEqual(["Failed to create gist: spawn gh EACCES"]);
	});

	it("checks gh authentication without blocking and reports a missing or signed-out gh", async () => {
		const gist = vi.fn(() => exitingChild("", 0));
		const errors: string[] = [];

		fakeGh(gist, () => failingChild("spawn gh ENOENT", "ENOENT", -2));
		await shareSession(shareContext(errors) as never);
		fakeGh(gist, () => exitingChild("", 1));
		await shareSession(shareContext(errors) as never);

		expect(errors).toEqual([
			"GitHub CLI (gh) is not installed. Install it from https://cli.github.com/",
			"GitHub CLI is not logged in. Run 'gh auth login' first.",
		]);
		expect(gist).not.toHaveBeenCalled();
	});
});
