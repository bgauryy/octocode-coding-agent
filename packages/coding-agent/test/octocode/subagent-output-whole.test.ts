import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { shortPath } from "../../src/utils/display-path.ts";
import type { ChildProgress } from "../../src/octocode/subagents/events.ts";
import type { ChildNotices } from "../../src/octocode/subagents/notices.ts";
import { pause, runSubagent, STARTUP_RETRY_ENV, type StartupPause } from "../../src/octocode/subagents/process.ts";
import { noticeLines } from "../../src/octocode/subagents/render.ts";
import { tmp } from "./helpers.ts";
import { STARTUP_RETRY_DELAY_MS, StartupError, USER_STOP } from "../../src/octocode/subagents/process/outcome.ts";

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-host.cjs");
const savedArgv = process.argv[1];
const savedEnv = { ...process.env };

beforeAll(() => {
	const root = tmp("octocode-whole-");
	process.env.OCTOCODE_HOME = path.join(root, "home");
	for (const key of [
		"OCTOCODE_SUBAGENT",
		"OCTOCODE_AGENT_ID",
		"OCTOCODE_PARENT_ID",
		"OCTOCODE_AGENT_GOAL",
		"OCTOCODE_AGENT_SCRATCH",
		"OCTOCODE_TEAM_WORKSPACE",
		STARTUP_RETRY_ENV,
	])
		delete process.env[key];
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.copyFileSync(FIXTURE, path.join(bin, "octocode"));
	process.argv[1] = path.join(bin, "octocode");
});

afterAll(() => {
	process.argv[1] = savedArgv!;
	process.env = savedEnv;
});

/** Runs a scenario and returns what the parent was told: the last notices update, and the outcome or the error. */
async function run(task: string, scratch: string, wait?: StartupPause) {
	const notices: ChildNotices[] = [];
	const onProgress = (update: ChildProgress) => {
		if (update.notices) notices.push(update.notices);
		return undefined;
	};
	const id = `a-${task.replace(/\W+/g, "-")}`;
	const result = await runSubagent(
		{
			task,
			args: ["--session-dir", tmp(), "--session-id", id],
			cwd: tmp(),
			identity: { id, scratch },
			onProgress,
		},
		wait,
	).then(
		(outcome) => ({ outcome, error: undefined as Error | undefined }),
		(error: Error) => ({ outcome: undefined, error }),
	);
	return { ...result, notices: notices.at(-1) };
}

describe("a child's notices past the inline page", () => {
	it("are saved whole in notices.txt, each distinct one on a line with its repeat count, and the report names the file", async () => {
		const scratch = tmp();
		const { notices } = await run("wordy notices", scratch);
		const file = path.join(scratch, "notices.txt");
		expect(notices).toMatchObject({ more: 5, file });
		const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
		expect(lines).toHaveLength(10);
		expect(lines[0]).toBe(`error: long failure ${"detail ".repeat(300)}end`);
		expect(lines[1]).toBe("warning (×9): retrying the cache");
		expect(lines.at(-1)).toBe("warning: distinct warning 8");
		// The inline page is whole notices, and the last line is the way to the rest.
		const text = noticeLines({ notices }).join("\n");
		expect(text).toContain(`- error: long failure ${"detail ".repeat(300)}end`);
		expect(text).toContain(`- +5 more notices; every notice, whole, is in ${shortPath(file)} (read it, or search it)`);
		expect(text).not.toContain("distinct warning 8");
	});

	it("stay inline, with no file, when they fit the page", async () => {
		const scratch = tmp();
		const { notices } = await run("thrash", scratch);
		expect(notices).toMatchObject({ more: 0 });
		expect(notices?.kept).toHaveLength(2);
		expect(notices?.file).toBeUndefined();
		expect(fs.existsSync(path.join(scratch, "notices.txt"))).toBe(false);
	});

	it("all go inline, whole, when no file can be written: nothing is dropped silently", async () => {
		const { notices } = await run("wordy notices", path.join(tmp(), "missing", "folder"));
		expect(notices?.more).toBe(0);
		expect(notices?.file).toBeUndefined();
		expect(notices?.kept).toHaveLength(10);
		expect(notices?.kept.at(-1)).toMatchObject({ text: "distinct warning 8" });
	});
});

describe("a crashed child's stderr", () => {
	it("is shown whole when it is small, with no file", async () => {
		const scratch = tmp();
		const { error } = await run("narrate then crash", scratch);
		expect(error?.message).toContain("Subagent exited with code 3: segfault\n");
		expect(fs.existsSync(path.join(scratch, "stderr.txt"))).toBe(false);
	});

	it("is saved whole when only its tail fits, and the error says how much it shows and where the rest is", async () => {
		const scratch = tmp();
		const { error } = await run("noisy stderr", scratch);
		const whole = `${Array.from({ length: 300 }, (_, n) => `diagnostic line ${n + 1} of the noisy child`).join("\n")}\n`;
		const file = path.join(scratch, "stderr.txt");
		expect(fs.readFileSync(file, "utf8")).toBe(whole);
		expect(error?.message).toContain(`[stderr: last 4000 of ${whole.length} characters; whole: ${shortPath(file)}]`);
		expect(error?.message).toContain("diagnostic line 300 of the noisy child");
		expect(error?.message).not.toContain("diagnostic line 1 of");
	});

	it("says the rest could not be saved when no file can be written", async () => {
		const { error } = await run("noisy stderr", path.join(tmp(), "missing", "folder"));
		expect(error?.message).toMatch(/\[stderr: last 4000 of \d+ characters; the rest could not be saved\]/);
	});
});

const attempts = (scratch: string) => fs.readFileSync(path.join(scratch, "attempts"), "utf8").length;

/** A wait that returns at once and records how long the run asked to wait. */
function recordedWaits() {
	const asked: number[] = [];
	return {
		asked,
		wait: (async (ms) => {
			asked.push(ms);
		}) as StartupPause,
	};
}

describe("the wait between two starts", () => {
	it("ends at once when the stop signal fires, and at once when it already fired", async () => {
		vi.useFakeTimers();
		try {
			const controller = new AbortController();
			const waiting = pause(STARTUP_RETRY_DELAY_MS, controller.signal);
			expect(vi.getTimerCount()).toBe(1);
			controller.abort(USER_STOP);
			await waiting;
			expect(vi.getTimerCount()).toBe(0);
			await pause(STARTUP_RETRY_DELAY_MS, controller.signal);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("lasts the asked time when nothing stops it", async () => {
		vi.useFakeTimers();
		try {
			let over = false;
			const waiting = pause(STARTUP_RETRY_DELAY_MS, undefined).then(() => (over = true));
			await vi.advanceTimersByTimeAsync(STARTUP_RETRY_DELAY_MS - 1);
			expect(over).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await waiting;
			expect(over).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});

// A bundled child (this stand-in is no `.ts` entry) gets the one retry: its code does not change under it.
describe("a child that exits before its first model turn", () => {
	it("is started once more after a module-load error, and the second start's report stands", async () => {
		const scratch = tmp();
		const { asked, wait } = recordedWaits();
		const { outcome, error } = await run("startup flaky", scratch, wait);
		expect(error).toBeUndefined();
		expect(outcome?.text).toBe("RECOVERED");
		expect(attempts(scratch)).toBe(2);
		expect(asked).toEqual([STARTUP_RETRY_DELAY_MS]);
	});

	it("reports failed (startup) after a second failure: one error line and the saved stderr, not the tail", async () => {
		const scratch = tmp();
		const { error } = await run("startup crash", scratch, recordedWaits().wait);
		const file = path.join(scratch, "stderr.txt");
		expect(attempts(scratch)).toBe(2);
		expect(error).toBeInstanceOf(StartupError);
		expect(error?.message).toBe(
			`Subagent failed (startup): exited with code 1 before its first model turn: SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode\nFull stderr: ${shortPath(file)}`,
		);
		expect(error?.message).not.toContain("compileSourceTextModule");
		expect(fs.readFileSync(file, "utf8")).toContain("compileSourceTextModule");
	});

	it("is not retried when the error is not a module-load error", async () => {
		const scratch = tmp();
		const { error } = await run("startup plain", scratch, recordedWaits().wait);
		expect(attempts(scratch)).toBe(1);
		expect(error?.message).toMatch(
			/^Subagent failed \(startup\): exited with code 2 before its first model turn: No API key for provider\nFull stderr: /,
		);
	});

	it("is no startup failure once a tool ran: reported as an ordinary crash, never retried", async () => {
		const scratch = tmp();
		const { error } = await run("startup after tool", scratch, recordedWaits().wait);
		expect(attempts(scratch)).toBe(1);
		expect(error).not.toBeInstanceOf(StartupError);
		expect(error?.message).toMatch(/^Subagent exited with code 1: /);
	});

	it("is not retried when the user stopped it during the delay", async () => {
		const scratch = tmp();
		const controller = new AbortController();
		const id = "a-startup-stop";
		let inWait!: () => void;
		const reachedWait = new Promise<void>((resolve) => (inWait = resolve));
		// A wait that ends only when the stop arrives, so the test needs no clock.
		const untilStopped: StartupPause = (_ms, signal) =>
			new Promise((resolve) => {
				signal?.addEventListener("abort", () => resolve(), { once: true });
				inWait();
			});
		const pending = runSubagent(
			{
				task: "startup crash",
				args: ["--session-dir", tmp(), "--session-id", id],
				cwd: tmp(),
				identity: { id, scratch },
				signal: controller.signal,
				onProgress: () => undefined,
			},
			untilStopped,
		);
		const failed = pending.then(
			() => new Error("finished"),
			(error: Error) => error,
		);
		await reachedWait;
		controller.abort(USER_STOP);
		expect((await failed).message).toBe("Subagent cancelled");
		expect(attempts(scratch)).toBe(1);
	});
});

describe("a child that runs the source tree and crashes while loading", () => {
	/** Runs `task` with the stand-in started as a `.ts` entry, as a source parent starts `src/cli.ts`. */
	async function fromSource(task: string, scratch: string, wait: StartupPause = recordedWaits().wait) {
		const entry = path.join(tmp(), "cli.ts");
		fs.copyFileSync(FIXTURE, entry);
		const bundle = process.argv[1];
		process.argv[1] = entry;
		try {
			return await run(task, scratch, wait);
		} finally {
			process.argv[1] = bundle!;
		}
	}

	it("is started again with a doubling wait until the edit it met is saved whole", async () => {
		const scratch = tmp();
		const { asked, wait } = recordedWaits();
		const { outcome, error } = await fromSource("startup until 3", scratch, wait);
		expect(error).toBeUndefined();
		expect(outcome?.text).toBe("RECOVERED on start 3: startup until 3");
		expect(attempts(scratch)).toBe(3);
		expect(asked).toEqual([STARTUP_RETRY_DELAY_MS, 2 * STARTUP_RETRY_DELAY_MS]);
	}, 30_000);

	it(`gets only the one retry when ${STARTUP_RETRY_ENV}=0`, async () => {
		const scratch = tmp();
		process.env[STARTUP_RETRY_ENV] = "0";
		try {
			const { error } = await fromSource("startup until 3", scratch);
			expect(error).toBeInstanceOf(StartupError);
			expect(attempts(scratch)).toBe(2);
		} finally {
			delete process.env[STARTUP_RETRY_ENV];
		}
	}, 30_000);

	it(`stops when the waits would pass ${STARTUP_RETRY_ENV}, with the last start's error`, async () => {
		const scratch = tmp();
		process.env[STARTUP_RETRY_ENV] = "4";
		const { asked, wait } = recordedWaits();
		try {
			const { error } = await fromSource("startup crash", scratch, wait);
			expect(error).toBeInstanceOf(StartupError);
			// The first wait, then what is left of the 4 s budget: three starts in all.
			expect(attempts(scratch)).toBe(3);
			expect(asked).toEqual([STARTUP_RETRY_DELAY_MS, 4_000 - STARTUP_RETRY_DELAY_MS]);
		} finally {
			delete process.env[STARTUP_RETRY_ENV];
		}
	}, 30_000);
});

describe("a crashed child's last progress", () => {
	it("is whole, however long it is below the report preview", async () => {
		const { error } = await run("medium narrate then crash", tmp());
		expect(error?.message).toContain(`Last progress: ${"progress detail ".repeat(60)}the end`);
		expect(error?.message).not.toContain("more characters cut");
	});
});

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));
