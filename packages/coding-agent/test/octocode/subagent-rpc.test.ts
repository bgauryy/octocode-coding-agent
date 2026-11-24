import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import octocode from "../../src/octocode/index.ts";
import type { ChildProgress } from "../../src/octocode/subagents/events.ts";
import { runSubagent } from "../../src/octocode/subagents/process.ts";
import type { RelayHost } from "../../src/octocode/subagents/relay.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { resetOctocodeEnv, tmp } from "./helpers.ts";
import { ABORT_SETTLE_MS, USER_STOP } from "../../src/octocode/subagents/process/outcome.ts";

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-host.cjs");
const savedArgv = process.argv[1];
const savedEnv = { ...process.env };

beforeAll(() => {
	const root = tmp("octocode-agent-rpc-");
	resetOctocodeEnv();
	Object.assign(process.env, {
		OCTOCODE_HOME: path.join(root, "home"),
		OCTOCODE_AGENT_DB: path.join(root, "team.sqlite"),
	});
	// runSubagent re-runs the current `octocode` script: point it at the scripted RPC stand-in.
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.copyFileSync(FIXTURE, path.join(bin, "octocode"));
	process.argv[1] = path.join(bin, "octocode");
});

afterAll(() => {
	process.argv[1] = savedArgv!;
	process.env = savedEnv;
});

afterEach(() => {
	delete process.env.OCTOCODE_FAKE_LOG;
	delete process.env.OCTOCODE_FAKE_BOOT;
});

/** What the stand-in child recorded: `abort` when it got that command, `stdin-closed` when its input ended. */
function childLog(): { file: string; lines: () => string[] } {
	const file = path.join(tmp(), "child.log");
	process.env.OCTOCODE_FAKE_LOG = file;
	return { file, lines: () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : []) };
}

/** Resolves once the stand-in child reads its input: it is up, and has handled whatever was written to it before. */
function childBoot(): () => Promise<void> {
	const file = path.join(tmp(), "child.boot");
	process.env.OCTOCODE_FAKE_BOOT = file;
	return () => vi.waitFor(() => expect(fs.existsSync(file)).toBe(true));
}

/**
 * A parent that sees when the child's run started. `output` is stamped once when the task is sent, then at each model
 * event the child prints; `agent_start` is the first of those. From then an abort is sent to the run as a command,
 * where a child still loading would only have its input closed.
 */
function runningChild(): { host: RelayHost; started: Promise<void> } {
	let seen!: () => void;
	const started = new Promise<void>((resolve) => {
		seen = resolve;
	});
	let stamps = 0;
	return {
		host: {
			permission: { allows: () => false, relayedAllow: vi.fn(), adopt: vi.fn(), relayNote: vi.fn() },
			output: () => {
				if (++stamps === 2) seen();
			},
		},
		started,
	};
}

describe("a subagent child over RPC", () => {
	it("hands the selected role bytes to the child independently of CLI append instructions", async () => {
		const prompt = "ROLE POLICY\nExact selected profile instructions.";
		const result = await runSubagent({
			task: "role prompt",
			args: [],
			cwd: tmp(),
			profile: { name: "selected", description: "", prompt },
			identity: { id: "role-handoff" },
			onProgress: () => undefined,
		});
		expect(result.text).toBe(prompt);
		const general = await runSubagent({
			task: "role prompt",
			args: [],
			cwd: tmp(),
			identity: { id: "no-role" },
			onProgress: () => undefined,
		});
		expect(general.text).toBe("NO ROLE");
	});

	it("runs a task sent as a prompt command, however long, with no byte of it in the arguments", async () => {
		const task = `echo task ${"x".repeat(200_000)} end of task`;
		const outcome = await runSubagent({
			task,
			args: [],
			cwd: tmp(),
			identity: { id: "a-long" },
			onProgress: () => undefined,
		});
		expect(outcome.text).toBe(`TASK ${task.length} ${JSON.stringify(task.slice(0, 40))} ${task.slice(-12)}`);
	});

	it("starts the child at once and sends its task only when its turn is ready", async () => {
		let open: () => void = () => undefined;
		const ready = new Promise<void>((resolve) => (open = resolve));
		const spawned: number[] = [];
		let settled = false;
		const booted = childBoot();
		const run = runSubagent({
			task: "echo task gated",
			args: [],
			cwd: tmp(),
			identity: { id: "a-gated" },
			onProgress: () => undefined,
			onSpawn: (pid) => spawned.push(pid),
			ready: () => ready,
		}).finally(() => (settled = true));
		await vi.waitFor(() => expect(spawned).toHaveLength(1));
		// Booted and reading its input, but no task yet: the run cannot have finished. A task sent at the start would be
		// answered within this window (the child echoes it at once).
		await booted();
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(settled).toBe(false);
		open();
		const outcome = await run;
		expect(outcome.text).toContain("TASK");
	});

	it("does not stop a child as stalled while its turn waits longer than its idle limit", async () => {
		let open: () => void = () => undefined;
		const ready = new Promise<void>((resolve) => (open = resolve));
		const spawned: number[] = [];
		const run = runSubagent({
			task: "echo task held",
			args: [],
			cwd: tmp(),
			identity: { id: "a-held" },
			onProgress: () => undefined,
			onSpawn: (pid) => spawned.push(pid),
			ready: () => ready,
			// The watchdog ticks every 250 ms: four idle limits pass while the turn waits.
			limits: { idleMs: 500, busyMs: 60_000 },
		});
		await vi.waitFor(() => expect(spawned).toHaveLength(1));
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		open();
		const outcome = await run;
		expect(outcome.text).toContain("TASK");
	}, 15_000);

	it("sends no task when the run is stopped while its turn waits", async () => {
		const log = childLog();
		const controller = new AbortController();
		const spawned: number[] = [];
		const booted = childBoot();
		const run = runSubagent({
			task: "budget loop 3",
			args: [],
			cwd: tmp(),
			identity: { id: "a-gate-stop" },
			signal: controller.signal,
			onProgress: () => undefined,
			onSpawn: (pid) => spawned.push(pid),
			ready: () =>
				new Promise<void>((_, reject) =>
					controller.signal.addEventListener("abort", () => reject(new Error("Subagent cancelled"))),
				),
		});
		await vi.waitFor(() => expect(spawned).toHaveLength(1));
		// The child reads its input in order: had a task been sent, it is read (and logged as `prompt …`) before the close
		// that the stop below sends.
		await booted();
		controller.abort();
		await expect(run).rejects.toThrow("Subagent cancelled");
		expect(log.lines().filter((line) => line.startsWith("prompt") || line === "abort")).toEqual([]);
	}, 15_000);

	it("closes the child's stdin once its run settles, so it leaves by itself", async () => {
		const log = childLog();
		const outcome = await runSubagent({
			task: "grants",
			args: [],
			cwd: tmp(),
			identity: { id: "a-settled" },
			onProgress: () => undefined,
		});
		expect(outcome.text).toContain("mode=");
		// Its report names no outcome, so it is asked for the word once before its input closes.
		expect(log.lines()).toEqual(["outcome-ask", "stdin-closed"]);
		expect(outcome).toMatchObject({ outcome: "done", outcomeSource: "asked" });
	});

	it("records partial when the child's answer to the outcome question names no outcome either", async () => {
		const log = childLog();
		const outcome = await runSubagent({
			task: 'grants outcome ask answers "## Still a heading"',
			args: [],
			cwd: tmp(),
			identity: { id: "a-miss" },
			onProgress: () => undefined,
		});
		expect(outcome.text).toContain("mode=");
		expect(outcome.text).not.toContain("Still a heading");
		// Asked once: the second miss is recorded, not asked about again.
		expect(log.lines()).toEqual(["outcome-ask", "stdin-closed"]);
		expect(outcome).toMatchObject({ outcome: "partial", outcomeSource: "asked" });
		expect(outcome.error).toBeUndefined();
	});

	it("ignores response and fire-and-forget records, reporting what JSON mode would", async () => {
		const seen: ChildProgress[] = [];
		const outcome = await runSubagent({
			task: "dialogs",
			args: [],
			cwd: tmp(),
			identity: { id: "a-ui" },
			onProgress: (update) => seen.push(update),
		});
		expect(outcome.text.startsWith("ANSWERS ")).toBe(true);
		// The notify, the setStatus and the prompt response are not activity: only the child's replies show (its report,
		// then its answer to the one question about the outcome word that report lacks).
		expect(seen.filter((update) => update.activity)).toEqual([]);
		expect(seen.filter((update) => update.reply)).toHaveLength(2);
	});

	it("answers every dialog the child opens as cancelled, and nothing else", async () => {
		const outcome = await runSubagent({
			task: "dialogs",
			args: [],
			cwd: tmp(),
			identity: { id: "a-dialogs" },
			onProgress: () => undefined,
		});
		const [, answers, sent] = /^ANSWERS (.*) COMMANDS (.*)$/.exec(outcome.text)!;
		expect(JSON.parse(answers)).toEqual(
			["d1", "d2", "d3", "d4"].map((id) => ({ type: "extension_ui_response", id, cancelled: true })),
		);
		// The only commands the child received after its prompt are those four answers: none for notify or setStatus.
		expect(JSON.parse(sent)).toEqual(["d1", "d2", "d3", "d4"]);
	});

	it("stops with abort, then agent_settled, then a closed stdin, without signalling a child that follows", async () => {
		const log = childLog();
		const controller = new AbortController();
		const child = runningChild();
		const run = runSubagent({
			task: "abortable",
			args: [],
			cwd: tmp(),
			identity: { id: "a-abort" },
			signal: controller.signal,
			onProgress: () => undefined,
			host: child.host,
		});
		// The child reports `agent_start` first; abort once it is running.
		await child.started;
		const started = Date.now();
		controller.abort();
		await expect(run).rejects.toThrow("Subagent cancelled");
		expect(log.lines()).toEqual(["abort", "stdin-closed"]);
		expect(Date.now() - started).toBeLessThan(ABORT_SETTLE_MS);
	}, 15_000);

	it("falls back to signals after the bounded wait when a child never settles", async () => {
		const log = childLog();
		const controller = new AbortController();
		let ignoring!: () => void;
		const ignores = new Promise<void>((resolve) => {
			ignoring = resolve;
		});
		const run = runSubagent({
			task: "stubborn",
			args: [],
			cwd: tmp(),
			identity: { id: "a-unresponsive" },
			signal: controller.signal,
			onProgress: () => ignoring(),
		});
		// The child reported the tool it starts once it ignores SIGTERM and a closed input: a stop before that would end it at once.
		await ignores;
		controller.abort(USER_STOP);
		await expect(run).rejects.toThrow("Subagent cancelled");
		// It ignored the abort, the closed input and SIGTERM: only the SIGKILL ended it, and the input was closed first.
		expect(log.lines()).toEqual(["stdin-closed"]);
	}, 20_000);

	it("fails a task the child rejects instead of waiting for a run that never starts", async () => {
		await expect(
			runSubagent({
				task: "rejected",
				args: [],
				cwd: tmp(),
				identity: { id: "a-rejected" },
				onProgress: () => undefined,
			}),
		).rejects.toThrow("Subagent rejected its task: No model selected");
	}, 20_000);

	it("closes the child's input when an extension command consumed the prompt (no run, no agent_settled)", async () => {
		const log = childLog();
		const outcome = await runSubagent({
			task: "handled",
			args: [],
			cwd: tmp(),
			identity: { id: "a-handled" },
			onProgress: () => undefined,
		});
		expect(outcome.text).toBe("");
		expect(log.lines()).toEqual(["stdin-closed"]);
	});
});

describe("the run-hold for background work in an RPC child", () => {
	/**
	 * A session whose bash job runs until `endJob`, and the settle of its run. `exitsAtSettle` is how many exit reports
	 * of that job had been sent when the settle resolved: one when the settle waited for the job, none when it did not.
	 */
	const withRunningJob = async (
		env: Record<string, string | undefined>,
		hasUI: boolean,
		body: (run: {
			settle: () => Promise<void>;
			settled: () => boolean;
			exitsAtSettle: () => number;
			endJob: () => void;
		}) => Promise<void>,
	): Promise<void> => {
		const saved = { ...process.env };
		Object.assign(process.env, { OCTOCODE_MCP: "0", OCTOCODE_HOME: tmp(), ...env });
		const fake = fakeHost();
		try {
			await octocode(fake.api);
			const ctx = fakeCtx({ cwd: tmp(), hasUI, mode: hasUI ? "rpc" : "json" });
			const controller = new AbortController();
			Object.assign(ctx, { signal: controller.signal });
			const gate = path.join(tmp(), "gate");
			await fake.tools
				.get("bash")
				.execute(
					"t1",
					{ command: `while [ ! -e '${gate}' ]; do sleep 0.05; done`, background: true, timeout: 30 },
					undefined,
					undefined,
					ctx,
				);
			const exits = () => fake.sent.filter((entry) => entry.message.customType === "octocode-bash-job").length;
			expect(exits()).toBe(0);
			let exitsAtSettle: number | undefined;
			try {
				await body({
					settle: () =>
						fake
							.fire(
								"agent_before_settle",
								{
									type: "agent_before_settle",
									outcome: "completed",
									entries: [],
									context: {
										contextEntries: [],
										contextMessages: [],
										llmMessages: [],
										pendingMessages: [],
										canContinue: false,
									},
									continue: false,
								},
								ctx,
							)
							.then(() => {
								exitsAtSettle = exits();
								return undefined;
							}),
					settled: () => exitsAtSettle !== undefined,
					exitsAtSettle: () => exitsAtSettle ?? Number.NaN,
					endJob: () => fs.writeFileSync(gate, ""),
				});
			} finally {
				// Ends a settle that still holds and stops a job that still runs.
				controller.abort();
				await fake.emit("session_shutdown", { type: "session_shutdown" }, ctx);
			}
		} finally {
			process.env = saved;
		}
	};

	/** The settle is still pending while the job runs, and resolves only after the job's exit was reported. */
	const holds = (env: Record<string, string | undefined>, hasUI: boolean) =>
		withRunningJob(env, hasUI, async (run) => {
			const settle = run.settle();
			await new Promise((resolve) => setImmediate(resolve));
			expect(run.settled()).toBe(false);
			run.endJob();
			await settle;
			expect(run.exitsAtSettle()).toBe(1);
		});

	it("still waits for a bash job when hasUI is true (RPC), because the session is a subagent", async () => {
		await holds({ OCTOCODE_SUBAGENT: "1" }, true);
	}, 20_000);

	it("does not wait in a main session with a UI, and still waits in a headless one", async () => {
		// No bound on this settle: it resolves while the job, which nothing ends, still runs.
		await withRunningJob({ OCTOCODE_SUBAGENT: undefined }, true, async (run) => {
			await run.settle();
			expect(run.exitsAtSettle()).toBe(0);
		});
		await holds({ OCTOCODE_SUBAGENT: undefined }, false);
	}, 20_000);
});

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));
