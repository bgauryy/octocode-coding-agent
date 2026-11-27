import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BashJobs } from "../../../src/octocode/files/bash-jobs.ts";
import { registerBashTool } from "../../../src/octocode/native/tools/bash/tool.ts";
import { Subcommands } from "../../../src/octocode/shared/commands.ts";
import { runningWorkOf } from "../../../src/octocode/shared/running-work.ts";
import { registerTimers } from "../../../src/octocode/timer/register.ts";
import { fakeCtx, fakeHost } from "../fake-host.ts";
import { tmp } from "../helpers.ts";

const T0 = Date.UTC(2026, 10, 5, 12);
let root: string;
const closers: Array<() => Promise<unknown>> = [];

beforeEach(() => {
	// The clock starts at T0 but keeps running: shutdown code (a process stop, a lock wait) polls `Date.now()` against a
	// deadline, and a frozen clock never reaches it, so a slow machine would wait out the hook timeout.
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: T0, shouldAdvanceTime: true });
	root = tmp();
});
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	vi.useRealTimers();
	fs.rmSync(root, { recursive: true, force: true });
});

/** A session with the real bash tool, timers, `/loop` and `/jobs` on one host, so they share the running-work view. */
async function session() {
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ timer: { cron: {} } }));
	const host = fakeHost();
	const commands = new Subcommands();
	const jobs = new BashJobs(tmp());
	registerBashTool(host.api, commands, jobs, () => ({}));
	registerTimers(host.api, {
		reservation: () => undefined,
		agent: () => "me",
		env: { ...process.env, OCTOCODE_AGENT_DB: path.join(root, "workspaces.db") },
		agentDir,
		isSubagent: false,
		commands,
	});
	const base = fakeCtx({ cwd: root, hasUI: true });
	const ctx = {
		...base,
		isIdle: () => true,
		sessionManager: { ...base.sessionManager, getSessionId: () => "s1", getBranch: () => [], getEntries: () => [] },
	};
	await host.fire("session_start", { reason: "startup" }, ctx);
	closers.push(() => host.fire("session_shutdown", {}, ctx));
	const shown = async () => {
		await commands.get("jobs")!.handler("", ctx);
		return ctx.ui.notes.at(-1)!.message;
	};
	return { host, ctx, commands, jobs, shown, work: runningWorkOf(host.api) };
}

describe("/jobs", () => {
	it("says how to start each kind when nothing runs", async () => {
		const { shown } = await session();
		const text = await shown();
		expect(text).toMatch(/^Nothing is running\./);
		expect(text).toContain("/loop <interval> <prompt>");
		expect(text).not.toContain("Cancel any row");
	});

	it("lists crons, waits and bash jobs in groups with ids and time left, and names how to cancel", async () => {
		const { host, ctx, commands, shown } = await session();
		await commands.get("loop")!.handler("10m check the deploy", ctx);
		await host.tools
			.get("notify")
			.execute(
				"w1",
				{ op: "on", event: "check.result", filter: { command: "test -e ready" }, note: "ready file appeared" },
				undefined,
				undefined,
				ctx,
			);
		await host.tools
			.get("bash")
			.execute("b1", { command: "sleep 30", background: true, reason: "keep alive" }, undefined, undefined, ctx);
		const text = await shown();
		const order = ["Background bash jobs", "Crons", "Waits", "Cancel any row"].map((word) => text.indexOf(word));
		expect(order.every((at) => at >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(text).toMatch(/bash-1 · \d+s · pid \d+ · sleep 30/);
		expect(text).toMatch(/#\d+ · cron .* · next in \d+m · check the deploy/);
		expect(text).toMatch(/#\d+ · until .* · ready file appeared/);
		expect(text).toMatch(/Cancel any row: \/jobs kill <id>$/);
		await commands.get("jobs")!.handler("", ctx);
		ctx.ui.confirms.push(true);
		await commands.get("jobs")!.handler("kill bash-1", ctx);
	});

	it("kills a cron and a wait by their #id, names what exists for an unknown id, and still kills a bash job", async () => {
		const { host, ctx, commands, jobs, shown, work } = await session();
		await commands.get("loop")!.handler("10m check the deploy", ctx);
		await host.tools
			.get("notify")
			.execute(
				"w1",
				{ op: "on", event: "check.result", filter: { command: "test -e ready" }, note: "ready file appeared" },
				undefined,
				undefined,
				ctx,
			);
		await host.tools
			.get("bash")
			.execute("b1", { command: "sleep 30", background: true, reason: "keep alive" }, undefined, undefined, ctx);
		const [cron, wait] = work.all().filter((row) => row.kind === "timer");
		expect([cron.title, wait.title]).toEqual([expect.stringMatching(/^cron /), expect.stringMatching(/^until /)]);
		const kill = async (id: string) => {
			await commands.get("jobs")!.handler(`kill ${id}`, ctx);
			return ctx.ui.notes.at(-1)!;
		};
		expect((await kill(cron.id)).message).toBe(`Cancelled ${cron.id}.`);
		expect(work.all().map((row) => row.id)).not.toContain(cron.id);
		expect(await shown()).not.toContain("Crons");
		const missing = await kill("#99");
		expect(missing).toMatchObject({ type: "warning" });
		expect(missing.message).toBe(`No cron or notification #99 in this session. Running: ${wait.id}.`);
		expect((await kill(wait.id)).message).toBe(`Cancelled ${wait.id}.`);
		expect(work.all().some((row) => row.kind === "timer")).toBe(false);
		expect((await kill(wait.id)).message).toContain("No cron or notification");
		expect(await shown()).not.toMatch(/Waits|Crons/);
		ctx.ui.confirms.push(true);
		await commands.get("jobs")!.handler("kill bash-1", ctx);
		await vi.waitFor(() => expect(jobs.jobs.has("bash-1")).toBe(false));
	});
});
