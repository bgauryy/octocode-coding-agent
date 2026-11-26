import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { browserStateDir, recordBrowser, stopOwnedBrowsers } from "../src/presets/browser/owned.ts";

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const until = async (condition: () => boolean, ms = 5000): Promise<void> => {
	for (let waited = 0; !condition() && waited < ms; waited += 25) await new Promise((r) => setTimeout(r, 25));
};

describe("stopOwnedBrowsers", () => {
	const dirs: string[] = [];
	const pids: number[] = [];
	afterEach(() => {
		for (const pid of pids.splice(0))
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				// already gone
			}
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	/** A detached "Chrome": a shell leading its own group, with a helper child that ignores SIGTERM and holds the profile. */
	async function fakeChrome(port: string) {
		const cwd = mkdtempSync(join(tmpdir(), "owned-stop-"));
		dirs.push(cwd);
		const profileDir = join(cwd, "profile");
		mkdirSync(profileDir);
		writeFileSync(join(profileDir, "Cookies"), "x");
		const script = `trap '' TERM; (trap '' TERM; echo $$ > helper.pid; sleep 60) & wait`;
		const child = spawn("sh", ["-c", script, "chrome", `--remote-debugging-port=${port}`], {
			cwd,
			detached: true,
			stdio: "ignore",
		});
		child.unref();
		const pid = child.pid as number;
		pids.push(pid);
		const stateDir = browserStateDir(cwd);
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(join(stateDir, `octocode-proxy-${port}.json`), JSON.stringify({ proxyPort: 1, owner: process.pid }));
		writeFileSync(
			join(stateDir, `cdp-session-${port}.json`),
			JSON.stringify({ headless: true, isolated: true, pid, profileDir }),
		);
		await until(() => existsSync(join(cwd, "helper.pid")));
		return { cwd, pid, profileDir };
	}

	it("ends the whole process group, waits for exit and removes the profile", async () => {
		const { cwd, pid, profileDir } = await fakeChrome("39871");
		const reported: string[] = [];
		await stopOwnedBrowsers(cwd, (message) => reported.push(message));
		expect(alive(pid)).toBe(false);
		const helper = Number.parseInt((await import("node:fs")).readFileSync(join(cwd, "helper.pid"), "utf8"), 10);
		await until(() => !alive(helper), 1000);
		expect(alive(helper)).toBe(false);
		expect(existsSync(profileDir)).toBe(false);
		expect(reported).toEqual([]);
	}, 20_000);

	it("reports a profile that cannot be removed instead of swallowing it", async () => {
		const { cwd, profileDir } = await fakeChrome("39872");
		const reported: string[] = [];
		// A file where the profile directory was expected makes the removal itself fail for a non-ENOENT reason.
		const real = await import("node:fs");
		rmSync(profileDir, { recursive: true, force: true });
		writeFileSync(profileDir, "not a dir");
		real.chmodSync(cwd, 0o500);
		try {
			await stopOwnedBrowsers(cwd, (message) => reported.push(message));
		} finally {
			real.chmodSync(cwd, 0o700);
		}
		expect(reported.join("\n")).toContain(profileDir);
	}, 20_000);

	it("leaves a Chrome a running peer session also uses, and stops it once the peer is gone", async () => {
		const { cwd, pid } = await fakeChrome("39873");
		const peer = spawn("sleep", ["60"], { stdio: "ignore" });
		const peerPid = peer.pid as number;
		const record = join(browserStateDir(cwd), "octocode-proxy-39873.json");
		writeFileSync(record, JSON.stringify({ proxyPort: 1, owners: [peerPid] }));
		recordBrowser(cwd, "39873", 1); // this session reuses the peer's Chrome
		await stopOwnedBrowsers(cwd, () => undefined);
		expect(alive(pid)).toBe(true);
		expect(JSON.parse(readFileSync(record, "utf8")).owners).toEqual([peerPid]);
		peer.kill("SIGKILL");
		await until(() => !alive(peerPid));
		writeFileSync(record, JSON.stringify({ proxyPort: 1, owners: [peerPid, process.pid] }));
		await stopOwnedBrowsers(cwd, () => undefined);
		expect(alive(pid)).toBe(false);
	}, 20_000);
});
