import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { resetOctocodeEnv, tmp } from "./helpers.ts";

/** Every way the coordinator exits takes its subagents' process groups along, and nothing stays stale. */

const SRC = path.join(import.meta.dirname, "..", "..", "src");
const SOURCE_RESOLVER = path.join(import.meta.dirname, "..", "..", "scripts", "source-resolver.ts");
const SHELL = pathToFileURL(path.join(SRC, "utils", "shell.ts")).href;
const DEADLINE = pathToFileURL(path.join(SRC, "modes", "rpc", "shutdown-deadline.ts")).href;
const savedEnv = { ...process.env };
// Each case starts node processes that load the source tree: slow on a busy machine.
vi.setConfig({ testTimeout: 90_000 });
let dir = "";

beforeAll(() => {
	dir = tmp("octocode-exit-kill-");
	resetOctocodeEnv();
	Object.assign(process.env, {
		OCTOCODE_HOME: path.join(dir, "home"),
		OCTOCODE_AGENT_DB: path.join(dir, "team", "team.sqlite"),
	});
});

afterAll(() => {
	process.env = savedEnv;
});

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function until(check: () => boolean, ms = 45_000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

const pidsToClean: number[] = [];
afterEach(() => {
	for (const pid of pidsToClean.splice(0)) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
});

/**
 * A coordinator stand-in running the real tracking code. It spawns a detached group leader, like a subagent, that starts a
 * grandchild (an MCP server or bash job) and writes both pids to `pids`, then ends the way `mode` says.
 */
const COORDINATOR = `
import { spawn } from "node:child_process";
import fs from "node:fs";
import { killTrackedDetachedChildren, trackDetachedChildPid, untrackDetachedChildPid } from ${JSON.stringify(SHELL)};
const [mode, pids] = process.argv.slice(2);
const leader = spawn(process.execPath, ["-e", ${JSON.stringify(`
const g = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
require("node:fs").writeFileSync(process.argv[1], process.pid + " " + g.pid);
setInterval(() => {}, 1000);
`)}, pids], { detached: true, stdio: "ignore" });
trackDetachedChildPid(leader.pid, { graceful: true });
while (!fs.existsSync(pids) || fs.readFileSync(pids, "utf8").split(" ").length < 2) await new Promise((r) => setTimeout(r, 20));
if (mode === "emergency") {
	killTrackedDetachedChildren();
	process.exit(129);
}
if (mode === "signal") {
	// A signal handler spares a subagent for the graceful stop; one still running dies with the process.
	killTrackedDetachedChildren({ sparingGraceful: true });
	await new Promise((r) => setTimeout(r, 200));
	let spared = true;
	try { process.kill(leader.pid, 0); } catch { spared = false; }
	fs.writeFileSync(pids + ".spared", String(spared));
	process.exit(143);
}
if (mode === "uncaught") {
	process.on("uncaughtException", () => {
		killTrackedDetachedChildren();
		process.exit(1);
	});
	setTimeout(() => { throw new Error("boom"); }, 10);
} else if (mode === "untracked") {
	untrackDetachedChildPid(leader.pid);
	process.exit(0);
} else {
	// A plain process.exit with the run unsettled: only the exit hook is left.
	process.exit(0);
}
`;

async function runCoordinator(mode: string): Promise<{ leader: number; grandchild: number }> {
	const script = path.join(dir, `coordinator-${mode}.mjs`);
	const pids = path.join(dir, `pids-${mode}`);
	fs.rmSync(pids, { force: true });
	fs.writeFileSync(script, COORDINATOR);
	const coordinator = spawn(process.execPath, ["--import", SOURCE_RESOLVER, script, mode, pids], { stdio: "ignore" });
	await new Promise((resolve) => coordinator.on("exit", resolve));
	const [leader, grandchild] = fs.readFileSync(pids, "utf8").split(" ").map(Number);
	pidsToClean.push(leader);
	return { leader: leader, grandchild: grandchild };
}

describe("a coordinator that exits", () => {
	it.each(["emergency", "uncaught", "exit"])("kills the tracked group (%s)", async (mode) => {
		const { leader, grandchild } = await runCoordinator(mode);
		await until(() => !alive(leader) && !alive(grandchild));
	});

	it("spares a subagent's group on a signal for the graceful stop, then kills it at exit", async () => {
		const { leader, grandchild } = await runCoordinator("signal");
		expect(fs.readFileSync(path.join(dir, "pids-signal.spared"), "utf8")).toBe("true");
		await until(() => !alive(leader) && !alive(grandchild));
	});

	it("leaves a group that was untracked (its run ended) alone", async () => {
		const { leader, grandchild } = await runCoordinator("untracked");
		expect(alive(leader)).toBe(true);
		expect(alive(grandchild)).toBe(true);
	});
});

describe("a child whose parent is gone", () => {
	it("exits within its deadline although its shutdown never finishes", async () => {
		const script = path.join(dir, "hung-dispose.mjs");
		fs.writeFileSync(
			script,
			`import { armShutdownDeadline } from ${JSON.stringify(DEADLINE)};
armShutdownDeadline(7, 300);
// dispose that never settles, with a live handle like an MCP connection
setInterval(() => {}, 1000);
await new Promise(() => {});
`,
		);
		const started = Date.now();
		const child = spawn(process.execPath, ["--import", SOURCE_RESOLVER, script], { stdio: "ignore" });
		const code = await new Promise((resolve) => child.on("exit", resolve));
		expect(code).toBe(7);
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it("does not keep a process alive that would end anyway", async () => {
		const script = path.join(dir, "finished.mjs");
		fs.writeFileSync(
			script,
			`import { armShutdownDeadline } from ${JSON.stringify(DEADLINE)};
armShutdownDeadline(7, 60000);
`,
		);
		const child = spawn(process.execPath, ["--import", SOURCE_RESOLVER, script], { stdio: "ignore" });
		const code = await new Promise((resolve) => child.on("exit", resolve));
		expect(code).toBe(0);
	});
});

describe("child leases when the session ends", () => {
	it("stay until the child's run ends", async () => {
		const cwd = fs.realpathSync(tmp("octocode-exit-kill-cwd-"));
		const team = new Team(fakeHost().api);
		const ctx = fakeCtx({ cwd, hasUI: true });
		team.start(ctx);
		team.join();
		const store = TeamStore.open(cwd, process.env.OCTOCODE_AGENT_DB);
		try {
			const held = () => store.leases().map((lease) => `${lease.owner}:${lease.path}`);
			expect(await team.childLeases.reserve({ id: "kid-one", role: "general", goal: "g" }, ["a.ts"])).toMatchObject({
				ok: true,
			});
			team.stop();
			// /new: the session ended, the child is still closing, and nothing may reserve what it still writes.
			expect(held()).toEqual(["kid-one:a.ts"]);
			team.start(ctx);
			team.join();
			expect(team.childLeases.conflicts(["a.ts"])).not.toEqual([]);
			await team.childLeases.release("kid-one");
			expect(held()).toEqual([]);
		} finally {
			team.stop();
			for (const id of store.names()) store.remove(id);
			store.close();
		}
	});
});
