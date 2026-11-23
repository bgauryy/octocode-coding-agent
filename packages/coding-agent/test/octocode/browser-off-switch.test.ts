import type * as ChildProcess from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAppWindow, OPEN_BROWSER_ENV } from "../../src/octocode/browser/app-window.ts";
import { daemonOpener } from "../../src/octocode/web-daemon/open.ts";

// The real launchers are the boundary under test. Each records what it was asked to start and starts nothing, so a
// regression fails here instead of opening a window on the machine that runs the suite.
const started = vi.hoisted(() => [] as string[]);
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof ChildProcess>()),
	spawn: vi.fn((command: string, args: readonly string[] = []) => {
		started.push([command, ...args].join(" "));
		throw new Error("a test asked to start a real process");
	}),
}));
vi.mock("@octocodeai/octocode-common/open-target", () => ({
	openTarget: vi.fn(async (target: string) => void started.push(`default browser ${target}`)),
}));
vi.mock("../../src/octocode/web-daemon/launcher.ts", () => ({
	ensureWebDaemon: async () => ({ origin: "http://127.0.0.1:7", token: "tok", record: {} }),
	waitForSession: async () => true,
	daemonRequest: async () => ({ status: 200, json: () => ({ code: "one-time" }) }),
}));

let root: string;
beforeEach(() => {
	started.length = 0;
	root = mkdtempSync(join(tmpdir(), "browser-off-switch-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A macOS applications folder with Google Chrome in it, so the app window finds a browser to start. */
function installedChrome(): string {
	const executable = join(root, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome");
	mkdirSync(dirname(executable), { recursive: true });
	writeFileSync(executable, "");
	chmodSync(executable, 0o755);
	return join(root, "Applications");
}

it("turns browser opening off for the whole test run", () => {
	expect(process.env[OPEN_BROWSER_ENV]).toBe("0");
});

it("starts no browser from the app window's own launchers and gives the address instead", async () => {
	const tmpDir = join(root, "tmp");
	mkdirSync(tmpDir);
	const options = { platform: "darwin" as const, applicationsDir: installedChrome(), home: root, tmpDir };
	const url = "http://127.0.0.1:9/open/code?s=s1&view=board";
	for (const mode of ["app", "browser"] as const) {
		const notice = await createAppWindow({ ...options, mode: () => mode }).open(url);
		expect(notice).toContain(`${OPEN_BROWSER_ENV}=0`);
		expect(notice).toContain(url);
	}
	expect(started).toEqual([]);
	// Nothing was launched, so no temporary browser profile was made either.
	expect(readdirSync(tmpDir)).toEqual([]);
});

it("makes /web through the daemon say the page's address rather than open a window", async () => {
	const notify = vi.fn();
	const opener = daemonOpener({ ensure: async () => ({ sessionId: "s1", port: 1, close: async () => undefined }) });
	await opener({ hasUI: true, ui: { notify } } as never, "board");
	expect(started).toEqual([]);
	expect(notify).toHaveBeenCalledOnce();
	expect(notify.mock.calls[0]?.[0]).toContain("http://127.0.0.1:7/open/one-time?s=s1&view=board");
});
