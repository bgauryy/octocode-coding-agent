import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processSamples, type AgentDb } from "../../../../db/src/api.ts";
import { openAgentDb } from "../../../src/storage/database.ts";
import { registerProcesses } from "../../../src/octocode/processes/register.ts";
import type { ProcessRow } from "../../../src/octocode/processes/table.ts";
import { Subcommands } from "../../../src/octocode/shared/commands.ts";
import { processStartTime } from "../../../src/octocode/shared/process.ts";
import { fakeCtx, fakeHost } from "../fake-host.ts";
import { tmp } from "../helpers.ts";
import { TEST_WORKER_TITLE } from "../../helpers/worker-title.ts";

const startingTitle = process.title;
let agent: AgentDb;
let table: ProcessRow[];
beforeEach(() => {
	agent = openAgentDb(path.join(tmp(), "register.db"));
	table = [];
});
afterEach(() => {
	agent.close();
	process.title = startingTitle;
	vi.useRealTimers();
});

const ctx = (id: string, mode = "tui", hasUI = true) =>
	({ ...fakeCtx({ cwd: tmp(), hasUI, mode }), sessionManager: { getSessionId: () => id } }) as never;
const live = (env: NodeJS.ProcessEnv = {}, extra: Partial<Parameters<typeof registerProcesses>[1]> = {}) => {
	const host = fakeHost();
	const commands = new Subcommands();
	const stopped: number[] = [];
	registerProcesses(host.api, {
		commands,
		isSubagent: env.OCTOCODE_SUBAGENT === "1",
		env,
		db: () => agent.db,
		table: async () => table,
		jobPids: () => [],
		mcpPids: () => [],
		intervalMs: 60_000,
		stop: async (pid) => void stopped.push(pid),
		match: async () => "same",
		...extra,
	});
	return { ...host, commands, stopped };
};

describe("process title across the session lifecycle", () => {
	it("names a main session after its session id and renames it when the session changes", async () => {
		const host = live();
		await host.emit("session_start", { reason: "startup" }, ctx("eb93-75f9-01a1a2c5"));
		expect(process.title).toBe("octocode-agent-main-01a1a2c5");
		await host.emit("session_shutdown", {}, ctx("eb93-75f9-01a1a2c5"));
		await host.emit("session_start", { reason: "new" }, ctx("0000-02b2b3d6"));
		expect(process.title).toBe("octocode-agent-main-02b2b3d6");
		await host.emit("session_start", { reason: "resume" }, ctx("0000-03c3c4e7"));
		expect(process.title).toBe("octocode-agent-main-03c3c4e7");
		await host.emit("session_start", { reason: "fork" }, ctx("0000-04d4d5f8"));
		expect(process.title).toBe("octocode-agent-main-04d4d5f8");
		await host.emit("session_shutdown", {}, ctx("0000-04d4d5f8"));
	});

	it.skipIf(process.platform === "win32")(
		"leaves a test worker's own title in ps, so a worker never shows as a live session",
		async () => {
			const host = live();
			await host.emit("session_start", { reason: "startup" }, ctx("eb93-75f9-01a1a2c5"));
			expect(process.title).toBe("octocode-agent-main-01a1a2c5");
			const shown = execFileSync("ps", ["-o", "command=", "-p", String(process.pid)], { encoding: "utf8" });
			expect(shown.trim()).toBe(TEST_WORKER_TITLE);
			await host.emit("session_shutdown", {}, ctx("eb93-75f9-01a1a2c5"));
		},
	);

	it("names an RPC host octocode-agent-rpc-<id>", async () => {
		const host = live();
		await host.emit("session_start", { reason: "startup" }, ctx("1-0a0b0c0d", "rpc"));
		expect(process.title).toBe("octocode-agent-rpc-0a0b0c0d");
		await host.emit("session_shutdown", {}, ctx("1-0a0b0c0d", "rpc"));
	});

	it("keeps a subagent's title octocode-agent-<role>-<agent id> whatever its session id", async () => {
		const host = live({ OCTOCODE_SUBAGENT: "1", OCTOCODE_AGENT_ID: "nifty-beak", OCTOCODE_AGENT_ROLE: "implementer" });
		await host.emit("session_start", { reason: "startup" }, ctx("0a0b0c0d-1", "rpc"));
		expect(process.title).toBe("octocode-agent-implementer-nifty-beak");
		await host.emit("session_shutdown", {}, ctx("0a0b0c0d-1", "rpc"));
	});
});

describe("memory sampling follows the session", () => {
	it("starts on session start, restarts for the next session and stops with a final sample at shutdown", async () => {
		vi.useFakeTimers();
		const host = live();
		await host.emit("session_start", { reason: "startup" }, ctx("1-aaaaaaaa"));
		expect(vi.getTimerCount()).toBe(1);
		// A frozen clock would give both samples one instant, and a process has one sample per instant.
		await vi.advanceTimersByTimeAsync(1000);
		await host.emit("session_shutdown", {}, ctx("1-aaaaaaaa"));
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(1000);
		await host.emit("session_start", { reason: "resume" }, ctx("2-bbbbbbbb"));
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(61_000);
		await host.emit("session_shutdown", {}, ctx("2-bbbbbbbb"));
		expect(vi.getTimerCount()).toBe(0);
		const samples = processSamples.since(agent.db, 0);
		expect(samples.map((sample) => [sample.sessionId, sample.ended])).toEqual([
			["1-aaaaaaaa", false],
			["1-aaaaaaaa", true],
			["2-bbbbbbbb", false],
			["2-bbbbbbbb", false],
			["2-bbbbbbbb", true],
		]);
		expect(samples[0].title).toBe("octocode-agent-main-aaaaaaaa");
		expect(samples[0].pid).toBe(process.pid);
	});

	it("records the owner of a subagent from its parent-pid variable", async () => {
		const host = live({
			OCTOCODE_SUBAGENT: "1",
			OCTOCODE_AGENT_ID: "nifty-beak",
			OCTOCODE_AGENT_ROLE: "implementer",
			OCTOCODE_PARENT_PID: "8585 1700000000",
		});
		await host.emit("session_start", { reason: "startup" }, ctx("0a0b0c0d-1", "rpc"));
		await host.emit("session_shutdown", {}, ctx("0a0b0c0d-1", "rpc"));
		expect(processSamples.since(agent.db, 0)[0]).toMatchObject({
			role: "implementer",
			agentId: "nifty-beak",
			ownerPid: 8585,
			ownerStarted: "1700000000",
		});
	});

	it("does not sample when the interval is 0", async () => {
		vi.useFakeTimers();
		const host = live({}, { intervalMs: 0 });
		await host.emit("session_start", { reason: "startup" }, ctx("1-aaaaaaaa"));
		expect(vi.getTimerCount()).toBe(0);
		await host.emit("session_shutdown", {}, ctx("1-aaaaaaaa"));
	});
});

describe("a sampling failure after the session context went stale", () => {
	it("is dropped without an unhandled rejection, and nothing is recorded after shutdown", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => void unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			let release!: () => void;
			const failing = new Promise<ProcessRow[]>((_resolve, reject) => {
				release = () => reject(new Error("database is closed"));
			});
			const host = live({}, { table: () => failing });
			const base = ctx("1-aaaaaaaa") as unknown as { ui: { notify: (message: string) => void } };
			const attempts: string[] = [];
			base.ui.notify = (message) => {
				attempts.push(message);
				throw new Error("This feature ctx is stale after session replacement or reload.");
			};
			await host.emit("session_start", { reason: "startup" }, base);
			release();
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(attempts).toHaveLength(1);
			expect(unhandled).toEqual([]);
			await host.emit("session_shutdown", {}, base);
			const count = processSamples.since(agent.db, 0).length;
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(processSamples.since(agent.db, 0)).toHaveLength(count);
			expect(attempts).toHaveLength(1);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});

describe("/processes", () => {
	const NOW = Date.now();
	const started = (secondsAgo: number) => String(Math.floor(NOW / 1000) - secondsAgo);
	const orphanSetup = () => {
		processSamples.record(agent.db, {
			at: NOW - 60_000,
			pid: 4000,
			started: started(7200),
			ppid: 1,
			role: "main",
			title: "octocode-agent-main-dead0000",
			id: "dead0000",
			sessionId: "dead0000-1",
			agentId: null,
			ownerPid: null,
			ownerStarted: null,
			cwd: null,
			rss: 1,
			heapUsed: 1,
			ended: false,
			children: [{ pid: 4001, started: started(7100), ppid: 4000, kind: "mcp", label: "node octocode-mcp", rss: 1 }],
		});
		table = [{ pid: 4001, ppid: 1, started: started(7100), command: "node octocode-mcp", rssKb: 35_000 }];
	};

	it("is a main-session command only, registered once under one word", () => {
		expect(live().commands.has("processes")).toBe(true);
		expect(live({ OCTOCODE_SUBAGENT: "1", OCTOCODE_AGENT_ID: "x" }).commands.has("processes")).toBe(false);
	});

	it("lists processes, their children, and the orphan it found", async () => {
		orphanSetup();
		const host = live();
		const context = ctx("1-aaaaaaaa");
		await host.commands.get("processes")!.handler("", context);
		const text = (context as unknown as { ui: { notes: Array<{ message: string }> } }).ui.notes
			.map((n) => n.message)
			.join("\n");
		expect(text).toContain("Orphans (1)");
		expect(text).toContain("4001");
		expect(text).toContain("dead0000");
		expect(text).toContain("/processes stop");
	});

	it("stops orphans only after the user confirms", async () => {
		orphanSetup();
		const declined = live();
		const noContext = fakeCtx({ cwd: tmp(), hasUI: true, mode: "tui", ui: { confirms: [false] } });
		await declined.commands.get("processes")!.handler("stop", noContext);
		expect(declined.stopped).toEqual([]);

		const accepted = live();
		const yesContext = fakeCtx({ cwd: tmp(), hasUI: true, mode: "tui", ui: { confirms: [true] } });
		await accepted.commands.get("processes")!.handler("stop", yesContext);
		expect(accepted.stopped).toEqual([4001]);
	});

	it("does not stop anything without a UI to confirm in", async () => {
		orphanSetup();
		const host = live();
		const headless = fakeCtx({ cwd: tmp(), hasUI: false, mode: "print" });
		await host.commands.get("processes")!.handler("stop", headless);
		expect(host.stopped).toEqual([]);
	});

	it("refuses a recorded pid that another process now holds", async () => {
		orphanSetup();
		const host = live({}, { match: async () => "other" });
		await host.commands
			.get("processes")!
			.handler("stop", fakeCtx({ cwd: tmp(), hasUI: true, mode: "tui", ui: { confirms: [true] } }));
		expect(host.stopped).toEqual([]);
	});

	it("rejects an unknown argument", async () => {
		const host = live();
		const context = ctx("1-aaaaaaaa");
		await host.commands.get("processes")!.handler("kill 1", context);
		expect((context as unknown as { ui: { notes: Array<{ message: string }> } }).ui.notes[0].message).toContain(
			"Usage: /processes",
		);
	});
});

describe("an MCP server that starts after the session's first sample", () => {
	it("is recorded and listed as mcp, not as a child", async () => {
		let changed: () => void = () => {};
		const mcp: number[] = [];
		const host = live(
			{},
			{
				mcpPids: () => mcp,
				onMcpServersChange: (listener) => {
					changed = listener;
					return () => {
						changed = () => {};
					};
				},
			},
		);
		const context = ctx("1-aaaaaaaa");
		await host.emit("session_start", { reason: "startup" }, context);
		// The server starts after the first sample read the table.
		await vi.waitFor(() => expect(processSamples.since(agent.db, 0)).toHaveLength(1));
		const self = processStartTime(process.pid)!;
		const server = { pid: 7001, ppid: process.pid, started: self, command: "node server.mjs", rssKb: 1 };
		table = [{ pid: process.pid, ppid: 1, started: self, command: process.title, rssKb: 1 }, server];
		mcp.push(server.pid);
		changed();
		await vi.waitFor(() =>
			expect(processSamples.since(agent.db, 0).at(-1)?.children).toEqual([
				expect.objectContaining({ pid: 7001, kind: "mcp" }),
			]),
		);
		await host.commands.get("processes")!.handler("", context);
		const text = (context as unknown as { ui: { notes: Array<{ message: string }> } }).ui.notes
			.map((n) => n.message)
			.join("\n");
		expect(text).toMatch(/mcp\s+pid 7001/);
		await host.emit("session_shutdown", {}, context);
	});
});
