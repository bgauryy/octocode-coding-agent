import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acquireRegistryLock } from "../../src/octocode/backlog/shared-web-lock.ts";
import { VERSION } from "../../src/config.ts";
import { daemonPage } from "../../src/octocode/web-daemon/build.ts";
import { ensureWebDaemon, usable } from "../../src/octocode/web-daemon/launcher.ts";
import { startWebDaemon } from "../../src/octocode/web-daemon/main.ts";
import { webDaemonPaths } from "../../src/octocode/web-daemon/paths.ts";
import { readDaemonRecord } from "../../src/octocode/web-daemon/records.ts";
import { processAlive } from "../../src/octocode/shared/process.ts";
import { isolatedEnv } from "./web-daemon-fixture.ts";

const entry = fileURLToPath(new URL("../../src/octocode/web-daemon/entry.ts", import.meta.url));
const oldEntry = fileURLToPath(new URL("./web-daemon-old-entry.ts", import.meta.url));
const childScript = fileURLToPath(new URL("./web-daemon-launch-child.ts", import.meta.url));
const resolver = pathToFileURL(fileURLToPath(new URL("../../scripts/source-resolver.ts", import.meta.url))).href;
const invocation = (script = entry) => ({ command: process.execPath, prefix: ["--import", resolver, script] });

const pids = new Set<number>();
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	pids.clear();
});

const track = <T extends { record: { pid: number } }>(daemon: T): T => {
	pids.add(daemon.record.pid);
	return daemon;
};

describe("daemon launcher", () => {
	it("makes two racing launchers produce one daemon, and a later launcher reuses it", async () => {
		const { env } = isolatedEnv({ OCTOCODE_WEB_DAEMON_IDLE_MINUTES: "5" });
		const [a, b, c] = (await Promise.all([1, 2, 3].map(() => ensureWebDaemon({ env, invocation: invocation() })))).map(
			track,
		);
		expect(new Set([a.record.pid, b.record.pid, c.record.pid]).size).toBe(1);
		expect(new Set([a.origin, b.origin, c.origin]).size).toBe(1);
		expect(new Set([a.record.nonce, b.record.nonce, c.record.nonce]).size).toBe(1);
		const again = track(await ensureWebDaemon({ env, invocation: invocation() }));
		expect(again.record.nonce).toBe(a.record.nonce);
		const record = readDaemonRecord(webDaemonPaths(env).record)!;
		expect(record.pid).toBe(a.record.pid);
		expect(record.pid).not.toBe(process.pid);
		if (process.platform !== "win32") {
			expect(fs.statSync(webDaemonPaths(env).record).mode & 0o777).toBe(0o600);
			expect(fs.statSync(webDaemonPaths(env).dir).mode & 0o777).toBe(0o700);
		}
		// The unauthenticated answer names the build; the page is served.
		expect((await (await fetch(a.origin + "/api/health")).json()).build).toBe(record.build);
		expect((await fetch(a.origin + "/")).status).toBe(200);
	});

	it("keeps the daemon running after the session that launched it exits", async () => {
		const { env } = isolatedEnv({ OCTOCODE_WEB_DAEMON_IDLE_MINUTES: "5" });
		const output = execFileSync(process.execPath, ["--import", resolver, childScript, entry, resolver], {
			env,
			encoding: "utf8",
		});
		const launched = JSON.parse(output.trim().split("\n").at(-1)!) as { pid: number; origin: string };
		pids.add(launched.pid);
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(processAlive(launched.pid)).toBe(true);
		expect((await fetch(launched.origin + "/api/health")).status).toBe(200);
		// A launcher in this process finds it instead of starting another.
		const reused = track(await ensureWebDaemon({ env, invocation: invocation() }));
		expect(reused.record.pid).toBe(launched.pid);
	});

	it("exits after the idle timeout with no tab and no session, removing its record", async () => {
		const { env } = isolatedEnv({ OCTOCODE_WEB_DAEMON_IDLE_MINUTES: "0.01" });
		const daemon = track(await ensureWebDaemon({ env, invocation: invocation() }));
		await expect.poll(() => processAlive(daemon.record.pid), { timeout: 15_000, interval: 100 }).toBe(false);
		expect(fs.existsSync(webDaemonPaths(env).record)).toBe(false);
		// The next launcher starts a fresh daemon.
		const next = track(
			await ensureWebDaemon({ env: { ...env, OCTOCODE_WEB_DAEMON_IDLE_MINUTES: "5" }, invocation: invocation() }),
		);
		expect(next.record.pid).not.toBe(daemon.record.pid);
	});

	it("drains a daemon of another build and serves from a new one", async () => {
		const { env } = isolatedEnv({ OCTOCODE_WEB_DAEMON_IDLE_MINUTES: "5" });
		const old = track(await ensureWebDaemon({ env, build: "0.0.0:old", invocation: invocation(oldEntry) }));
		expect(old.record.build).toBe("0.0.0:old");
		const current = track(await ensureWebDaemon({ env, invocation: invocation() }));
		expect(current.record.pid).not.toBe(old.record.pid);
		expect(current.record.build).not.toBe("0.0.0:old");
		await expect.poll(() => processAlive(old.record.pid), { timeout: 15_000, interval: 100 }).toBe(false);
		expect(readDaemonRecord(webDaemonPaths(env).record)!.pid).toBe(current.record.pid);
	});

	it("reuses the fresh daemon when the install's page changed since this terminal started", async () => {
		const { env } = isolatedEnv({ OCTOCODE_WEB_DAEMON_IDLE_MINUTES: "5" });
		const build = `${VERSION}:earlier-page:${daemonPage().build.split(":")[2]}`;
		const launch = () => ensureWebDaemon({ env, build, invocation: invocation() });
		try {
			const first = track(await launch());
			expect(first.record.build).toBe(daemonPage().build);
			expect((await launch()).record.nonce).toBe(first.record.nonce);
		} finally {
			const record = readDaemonRecord(webDaemonPaths(env).record);
			if (record) pids.add(record.pid);
		}
	});

	it("drains a daemon of its own install and version that serves an older page", async () => {
		const { env } = isolatedEnv({ OCTOCODE_WEB_DAEMON_IDLE_MINUTES: "5" });
		const install = daemonPage().build.split(":")[2];
		const stale = `${VERSION}:oldpage:${install}`;
		const old = track(
			await ensureWebDaemon({
				env: { ...env, OCTOCODE_TEST_DAEMON_BUILD: stale },
				build: stale,
				invocation: invocation(oldEntry),
			}),
		);
		expect(old.record.build).toBe(stale);
		const current = track(await ensureWebDaemon({ env, invocation: invocation() }));
		expect(current.record.pid).not.toBe(old.record.pid);
		expect(current.record.build).toBe(daemonPage().build);
		await expect.poll(() => processAlive(old.record.pid), { timeout: 15_000, interval: 100 }).toBe(false);
	});

	it("reuses or drains by version, page and install, so two installs never drain each other in turn", () => {
		const status = (build: string, draining = false) => ({
			status: {
				ok: true as const,
				protocolVersion: 1 as const,
				build,
				nonce: "n",
				pid: 1,
				startedAt: 0,
				tabs: 0,
				sessions: 0,
				draining,
			},
		});
		const mine = "1.3.0:page-new:inst-a";
		const cases: Array<[daemon: string, reuse: boolean]> = [
			[mine, true],
			["1.3.0:page-old:inst-a", false], // same install, source changed since it started
			["1.3.0:page-old", false], // a daemon from before builds named their install
			["1.3.0:page-old:inst-b", true], // another install of this version: leave it
			["1.2.0:page-old:inst-b", false], // older version
			["1.4.0:page-old:inst-a", true], // newer version: an older launcher never drains it
			["x", true], // no comparable version
		];
		for (const [daemon, reuse] of cases) expect([daemon, usable(status(daemon), mine)]).toEqual([daemon, reuse]);
		expect(usable(status(mine, true), mine)).toBe(false);
	});

	it("replaces a record whose pid is alive with another start time, and never talks to that stranger", async () => {
		const { env } = isolatedEnv({ OCTOCODE_WEB_DAEMON_IDLE_MINUTES: "5" });
		let requests = 0;
		const stranger = http.createServer((_req, res) => {
			requests++;
			res.writeHead(200).end("{}");
		});
		await new Promise<void>((resolve) => stranger.listen(0, "127.0.0.1", resolve));
		cleanup.push(() => new Promise<void>((resolve) => stranger.close(() => resolve())));
		const port = (stranger.address() as AddressInfo).port;
		const paths = webDaemonPaths(env);
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(
			paths.record,
			JSON.stringify({
				pid: process.pid,
				pid_started: "1",
				port,
				url: `http://127.0.0.1:${port}/#access=stolen`,
				protocolVersion: 1,
				build: "x",
				startedAt: 1,
				nonce: "n",
			}),
		);
		if (process.platform === "win32") return; // No start times to compare there; the nonce probe covers it.
		const daemon = track(await ensureWebDaemon({ env, invocation: invocation() }));
		expect(daemon.record.pid).not.toBe(process.pid);
		expect(daemon.origin).not.toContain(String(port));
		expect(requests).toBe(0);
	});

	it("does not trust a record whose answer lacks its nonce (a stranger on the recorded port)", async () => {
		const { env } = isolatedEnv({ OCTOCODE_WEB_DAEMON_IDLE_MINUTES: "5" });
		let requests = 0;
		const stranger = http.createServer((_req, res) => {
			requests++;
			res
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ ok: true, protocolVersion: 1, build: "x" }));
		});
		await new Promise<void>((resolve) => stranger.listen(0, "127.0.0.1", resolve));
		cleanup.push(() => new Promise<void>((resolve) => stranger.close(() => resolve())));
		const port = (stranger.address() as AddressInfo).port;
		const paths = webDaemonPaths(env);
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(
			paths.record,
			JSON.stringify({
				pid: process.pid,
				port,
				url: `http://127.0.0.1:${port}/#access=t`,
				protocolVersion: 1,
				build: "x",
				startedAt: 1,
				nonce: "n",
			}),
		);
		const daemon = track(await ensureWebDaemon({ env, invocation: invocation() }));
		expect(daemon.record.pid).not.toBe(process.pid);
		expect(requests).toBeGreaterThan(0);
	});

	it("starts no second daemon beside a running one: the run lock holds for its lifetime", async () => {
		const { env } = isolatedEnv({ OCTOCODE_WEB_DAEMON_IDLE_MINUTES: "5" });
		const first = await startWebDaemon(env);
		expect(first).toBeDefined();
		cleanup.push(() => first!.shutdown());
		expect(await startWebDaemon(env)).toBeUndefined();
		await first!.shutdown();
		const second = await startWebDaemon(env);
		expect(second).toBeDefined();
		await second!.shutdown();
		expect(fs.existsSync(webDaemonPaths(env).record)).toBe(false);
	});

	it("recovers a launch lock left by a crashed launcher at once", async () => {
		const { env } = isolatedEnv({ OCTOCODE_WEB_DAEMON_IDLE_MINUTES: "5" });
		const paths = webDaemonPaths(env);
		fs.mkdirSync(paths.dir, { recursive: true });
		const release = await acquireRegistryLock(paths.launchLock);
		// Pretend the owner died: its pid no longer exists.
		fs.writeFileSync(`${paths.launchLock}.owner`, JSON.stringify({ pid: 2 ** 22 + 12345 }));
		cleanup.push(() => release().catch(() => undefined));
		const started = Date.now();
		const daemon = track(await ensureWebDaemon({ env, invocation: invocation() }));
		expect(daemon.record.pid).toBeGreaterThan(0);
		expect(Date.now() - started).toBeLessThan(8000);
	});
});
