import type * as ChildProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processSamples, type AgentDb } from "../../../../db/src/api.ts";
import { tmp } from "../helpers.ts";

/**
 * `sync`: `ps` run on the calling thread (`execFileSync`); `async`: `ps` run without blocking (`execFile`); `self`: the
 * `ps` runs of either kind that asked about this process alone (`-p <pid>`).
 */
const ps = vi.hoisted(() => ({ sync: 0, async: 0, self: 0 }));
const aboutSelf = (args: unknown) => Array.isArray(args) && args.includes("-p") && args.includes(String(process.pid));
vi.mock("node:child_process", async (actual) => {
	const real = await actual<typeof ChildProcess>();
	return {
		...real,
		execFileSync: ((command: string, ...rest: unknown[]) => {
			if (command === "ps") ps.sync++;
			if (command === "ps" && aboutSelf(rest[0])) ps.self++;
			return (real.execFileSync as (...args: unknown[]) => unknown)(command, ...rest);
		}) as typeof real.execFileSync,
		execFile: ((command: string, ...rest: unknown[]) => {
			if (command === "ps") ps.async++;
			if (command === "ps" && aboutSelf(rest[0])) ps.self++;
			return (real.execFile as (...args: unknown[]) => unknown)(command, ...rest);
		}) as typeof real.execFile,
	};
});
const { openAgentDb } = await import("../../../src/storage/database.ts");
const { registerProcesses } = await import("../../../src/octocode/processes/register.ts");
const { processStartTimeAsync } = await import("../../../src/octocode/shared/process.ts");
const { Subcommands } = await import("../../../src/octocode/shared/commands.ts");
const { fakeCtx, fakeHost } = await import("../fake-host.ts");
const { recordLockOwner } = await import("@octocodeai/octocode-common/lock-owner");
const { recordProcessGroup } = await import("@octocodeai/octocode-common/process-group-records");

const startingTitle = process.title;
let agent: AgentDb;
beforeEach(() => {
	agent = openAgentDb(path.join(tmp(), "warm.db"));
});
afterEach(() => {
	agent.close();
	process.title = startingTitle;
});

describe.skipIf(process.platform === "win32")("this process's start time", () => {
	it("is read in the background at registration, so session start runs no ps on the calling thread", async () => {
		const host = fakeHost();
		registerProcesses(host.api, {
			commands: new Subcommands(),
			isSubagent: false,
			env: {},
			db: () => agent.db,
			table: async () => [],
			jobPids: () => [],
			mcpPids: () => [],
			intervalMs: 60_000,
		});
		// The read started with the registration, before any session asked for it.
		expect(ps.async).toBe(1);
		// Shares that read: no second `ps`.
		const started = await processStartTimeAsync(process.pid);
		expect(ps.async).toBe(1);
		expect(started).toMatch(/^\d+$/);

		const ctx = {
			...fakeCtx({ cwd: tmp(), hasUI: true, mode: "tui" }),
			sessionManager: { getSessionId: () => "1-aaaaaaaa" },
		};
		await host.emit("session_start", { reason: "startup" }, ctx);
		await host.emit("session_shutdown", {}, ctx);
		expect(ps.sync).toBe(0);
		expect(processSamples.since(agent.db, 0)[0]).toMatchObject({ pid: process.pid, started });
	});

	it("is read once for every owner: process identity, lock owner records and process-group records", async () => {
		const started = await processStartTimeAsync(process.pid);
		const lock = path.join(tmp(), "file.lock");
		fs.mkdirSync(lock);
		const forget = recordLockOwner(lock);
		expect(JSON.parse(fs.readFileSync(`${lock}.owner`, "utf8")).started).toBe(started);
		forget();
		const groups = tmp();
		const remove = await recordProcessGroup(groups, process.ppid, "parent");
		const [record] = fs.readdirSync(groups).map((file) => JSON.parse(fs.readFileSync(path.join(groups, file), "utf8")));
		expect(record.owner).toEqual({ pid: process.pid, started });
		remove();
		// One read in this file (the registration's above, or the first line here when this test runs alone).
		expect(ps.self).toBe(1);
	});
});
