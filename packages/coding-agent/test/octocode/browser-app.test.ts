import { EventEmitter } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openFile } from "../../src/octocode/browser/open.ts";
import { daemonOpener } from "../../src/octocode/web-daemon/open.ts";
import {
	APP_PROFILE_PREFIX,
	appWindowArgs,
	createAppWindow,
	findChromium,
} from "../../src/octocode/browser/app-window.ts";

// The daemon and the system opener are external boundaries of the daemon-path test below.
vi.mock("../../src/octocode/browser/open.ts", () => ({ openFile: vi.fn(async () => undefined) }));
vi.mock("../../src/octocode/web-daemon/launcher.ts", () => ({
	ensureWebDaemon: async () => ({ origin: "http://127.0.0.1:7", token: "tok", record: {} }),
	waitForSession: async () => true,
	daemonRequest: async () => ({ status: 200, json: () => ({ code: "one-time" }) }),
}));

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "browser-app-test-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function touch(file: string, mode = 0o755): string {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, "");
	chmodSync(file, mode);
	return file;
}

class FakeChild extends EventEmitter {
	pid = 4242;
	killed: string[] = [];
	unref = vi.fn();
	kill = vi.fn((signal: string) => {
		this.killed.push(signal);
		queueMicrotask(() => this.emit("exit", null, signal));
		return true;
	});
}

function fakeSpawn(behavior: "spawn" | "error" = "spawn") {
	const children: FakeChild[] = [];
	const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
	const spawn = vi.fn((command: string, args: string[], options: Record<string, unknown>) => {
		const child = new FakeChild();
		children.push(child);
		calls.push({ command, args, options });
		queueMicrotask(() => (behavior === "spawn" ? child.emit("spawn") : child.emit("error", new Error("EACCES"))));
		return child;
	});
	return { spawn: spawn as never, children, calls };
}

const profiles = (dir: string) => readdirSync(dir).filter((name) => name.startsWith(APP_PROFILE_PREFIX));

it("finds a macOS browser in /Applications before ~/Applications, in preference order", () => {
	const apps = join(root, "Applications");
	const home = join(root, "home");
	const edge = touch(join(apps, "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge"));
	const userChrome = touch(join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"));
	const options = { platform: "darwin" as const, applicationsDir: apps, home };
	expect(findChromium(options)).toBe(edge);
	rmSync(edge);
	expect(findChromium(options)).toBe(userChrome);
	rmSync(userChrome);
	expect(findChromium(options)).toBeUndefined();
});

it("finds a Linux browser on PATH and skips a non-executable file", () => {
	const first = join(root, "a");
	const second = join(root, "b");
	touch(join(first, "google-chrome"), 0o644);
	const chromium = touch(join(second, "chromium-browser"));
	const env = { PATH: `${first}:${second}` };
	expect(findChromium({ platform: "linux", env })).toBe(chromium);
	expect(findChromium({ platform: "linux", env: { PATH: first } })).toBeUndefined();
});

it.skipIf(process.platform === "win32")("names the Windows install locations of Chrome and Edge", () => {
	// Windows paths are backslash-joined strings: on another OS no file can match, so the candidates show in a miss.
	const env = { ProgramFiles: join(root, "pf"), LOCALAPPDATA: join(root, "local") };
	expect(findChromium({ platform: "win32", env })).toBeUndefined();
	const exe = `${env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`;
	writeFileSync(exe, "");
	expect(findChromium({ platform: "win32", env })).toBe(exe);
});

it("builds the exact app window arguments per platform", () => {
	const common = [
		"--app=http://127.0.0.1:1/x",
		"--user-data-dir=/p",
		"--disable-extensions",
		"--disable-sync",
		"--disable-default-apps",
		"--no-first-run",
		"--no-default-browser-check",
		"--autoplay-policy=no-user-gesture-required",
	];
	expect(appWindowArgs("http://127.0.0.1:1/x", "/p", "win32")).toEqual(common);
	expect(appWindowArgs("http://127.0.0.1:1/x", "/p", "darwin")).toEqual([...common, "--use-mock-keychain"]);
	expect(appWindowArgs("http://127.0.0.1:1/x", "/p", "linux")).toEqual([...common, "--password-store=basic"]);
	const all = appWindowArgs("http://x", "/p", "linux").join(" ");
	expect(all).not.toMatch(/kiosk|incognito/);
});

function setup(extra: Partial<Parameters<typeof createAppWindow>[0]> = {}) {
	const bin = touch(join(root, "bin", "google-chrome"));
	const tmp = join(root, "tmp");
	mkdirSync(tmp);
	const fake = fakeSpawn();
	const openDefault = vi.fn(async () => undefined);
	const onError = vi.fn();
	const window = createAppWindow({
		platform: "linux",
		env: { PATH: join(root, "bin") },
		tmpDir: tmp,
		spawn: fake.spawn,
		openDefault,
		onError,
		isAlive: () => false,
		...extra,
	});
	return { bin, tmp, fake, openDefault, onError, window };
}

it("spawns the browser without a shell, in a private temporary profile, with a one-time-code url", async () => {
	const { bin, tmp, fake, openDefault, window } = setup();
	const url = "http://127.0.0.1:9/launch/abc?s=1";
	expect(await window.open(url)).toBeUndefined();
	const [call] = fake.calls;
	const [profile] = profiles(tmp);
	expect(call?.command).toBe(bin);
	expect(call?.args).toEqual(appWindowArgs(url, join(tmp, profile ?? ""), "linux"));
	expect(call?.options).toMatchObject({ detached: true, stdio: "ignore" });
	expect(call?.options.shell).toBeUndefined();
	if (process.platform !== "win32") expect(statSync(join(tmp, profile ?? "")).mode & 0o077).toBe(0);
	expect(fake.children[0]?.unref).toHaveBeenCalled();
	expect(openDefault).not.toHaveBeenCalled();
});

it("removes the profile when the browser exits", async () => {
	const { tmp, fake, window } = setup();
	await window.open("http://127.0.0.1:9/");
	expect(profiles(tmp)).toHaveLength(1);
	fake.children[0]?.emit("exit", 0, null);
	await vi.waitFor(() => expect(profiles(tmp)).toHaveLength(0));
});

it("closes the browser and removes the profile on close", async () => {
	const { tmp, fake, window } = setup();
	await window.open("http://127.0.0.1:9/");
	await window.open("http://127.0.0.1:9/");
	await window.close();
	expect(fake.children.map((child) => child.killed)).toEqual([["SIGTERM"], ["SIGTERM"]]);
	expect(profiles(tmp)).toEqual([]);
});

it("kills a browser that ignores SIGTERM", async () => {
	const { tmp, fake, window } = setup({ closeGraceMs: 5 });
	await window.open("http://127.0.0.1:9/");
	const child = fake.children[0];
	if (!child) throw new Error("no child");
	child.kill.mockImplementation((signal: string) => {
		child.killed.push(signal);
		if (signal === "SIGKILL") queueMicrotask(() => child.emit("exit", null, signal));
		return true;
	});
	await window.close();
	expect(child.killed).toEqual(["SIGTERM", "SIGKILL"]);
	expect(profiles(tmp)).toEqual([]);
});

it("removes stale profiles of dead browsers and keeps live, young and foreign ones", async () => {
	const { tmp, window } = setup({ isAlive: (pid) => pid === 111, now: () => Date.now() });
	const make = (name: string, pid?: number, ageMs = 0) => {
		const dir = join(tmp, name);
		mkdirSync(dir);
		if (pid !== undefined) writeFileSync(join(dir, "owner.pid"), String(pid));
		const when = new Date(Date.now() - ageMs);
		utimesSync(dir, when, when);
	};
	make(`${APP_PROFILE_PREFIX}dead`, 222);
	make(`${APP_PROFILE_PREFIX}live`, 111);
	make(`${APP_PROFILE_PREFIX}young`);
	make(`${APP_PROFILE_PREFIX}abandoned`, undefined, 10 * 60_000);
	make("other-dir", 222);
	await window.open("http://127.0.0.1:9/");
	expect(existsSync(join(tmp, `${APP_PROFILE_PREFIX}dead`))).toBe(false);
	expect(existsSync(join(tmp, `${APP_PROFILE_PREFIX}abandoned`))).toBe(false);
	expect(existsSync(join(tmp, `${APP_PROFILE_PREFIX}live`))).toBe(true);
	expect(existsSync(join(tmp, `${APP_PROFILE_PREFIX}young`))).toBe(true);
	expect(existsSync(join(tmp, "other-dir"))).toBe(true);
});

it("falls back to the default opener, with a notice, when no Chromium browser is installed", async () => {
	const { fake, openDefault, window } = setup({ env: { PATH: join(root, "empty") } });
	const notice = await window.open("http://127.0.0.1:9/");
	expect(notice).toMatch(/default browser/);
	expect(openDefault).toHaveBeenCalledWith("http://127.0.0.1:9/");
	expect(fake.spawn).not.toHaveBeenCalled();
});

it("falls back, names the error and removes the profile when the browser cannot start", async () => {
	const bin = touch(join(root, "bin", "chromium"));
	const tmp = join(root, "tmp");
	mkdirSync(tmp);
	const openDefault = vi.fn(async () => undefined);
	const window = createAppWindow({
		platform: "linux",
		env: { PATH: dirname(bin) },
		tmpDir: tmp,
		spawn: fakeSpawn("error").spawn,
		openDefault,
	});
	const notice = await window.open("http://127.0.0.1:9/");
	expect(notice).toMatch(/EACCES.*default browser/);
	expect(openDefault).toHaveBeenCalledOnce();
	expect(profiles(tmp)).toEqual([]);
});

it("uses the default browser without a notice when the setting says browser", async () => {
	const { fake, openDefault, window } = setup({ mode: () => "browser" });
	expect(await window.open("http://127.0.0.1:9/")).toBeUndefined();
	expect(openDefault).toHaveBeenCalledOnce();
	expect(fake.spawn).not.toHaveBeenCalled();
});

it("opens the daemon page in the default browser when web.window is browser", async () => {
	const ctx = { hasUI: true, ui: { notify: vi.fn() } } as never;
	const opener = daemonOpener(
		{ ensure: async () => ({ sessionId: "s1", port: 1, close: async () => undefined }) },
		{ env: { OCTOCODE_WEB_DAEMON: "1" }, window: () => "browser" },
	);
	expect(await opener(ctx, "activity")).toBe(true);
	expect(openFile).toHaveBeenCalledOnce();
	const url = new URL(vi.mocked(openFile).mock.calls[0]?.[0] ?? "");
	expect(url.origin).toBe("http://127.0.0.1:7");
	expect(url.searchParams.get("s")).toBe("s1");
	expect(url.href).not.toContain("tok");
});
