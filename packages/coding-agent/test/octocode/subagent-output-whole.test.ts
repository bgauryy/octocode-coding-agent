import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { shortPath } from "../../src/octocode/shared/format.ts";
import type { ChildNotices, ChildProgress } from "../../src/octocode/subagents/events.ts";
import { runSubagent } from "../../src/octocode/subagents/process.ts";
import { noticeLines } from "../../src/octocode/subagents/render.ts";
import { tmp } from "./helpers.ts";
import { STARTUP_RETRY_DELAY_MS, StartupError, USER_STOP } from "../../src/octocode/subagents/process/outcome.ts";

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-pi.cjs");
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
		"OCTOCODE_AGENT_COLLABORATE",
		"OCTOCODE_AGENT_SCRATCH",
		"OCTOCODE_TEAM_WORKSPACE",
	])
		delete process.env[key];
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.copyFileSync(FIXTURE, path.join(bin, "pi"));
	process.argv[1] = path.join(bin, "pi");
});

afterAll(() => {
	process.argv[1] = savedArgv!;
	process.env = savedEnv;
});

/** Runs a scenario and returns what the parent was told: the last notices update, and the outcome or the error. */
async function run(task: string, scratch: string) {
	const notices: ChildNotices[] = [];
	const onProgress = (update: ChildProgress) => {
		if (update.notices) notices.push(update.notices);
		return undefined;
	};
	const id = `a-${task.replace(/\W+/g, "-")}`;
	const result = await runSubagent(
		task,
		["--session-dir", tmp(), "--session-id", id],
		tmp(),
		undefined,
		{ id, scratch },
		undefined,
		onProgress,
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

describe("a child that exits before its first model turn", () => {
	const attempts = (scratch: string) => fs.readFileSync(path.join(scratch, "attempts"), "utf8").length;

	it("is started once more after a module-load error, and the second start's report stands", async () => {
		const scratch = tmp();
		const started = Date.now();
		const { outcome, error } = await run("startup flaky", scratch);
		expect(error).toBeUndefined();
		expect(outcome?.text).toBe("RECOVERED");
		expect(attempts(scratch)).toBe(2);
		expect(Date.now() - started).toBeGreaterThanOrEqual(STARTUP_RETRY_DELAY_MS - 100);
	});

	it("reports failed (startup) after a second failure: one error line and the saved stderr, not the tail", async () => {
		const scratch = tmp();
		const { error } = await run("startup crash", scratch);
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
		const { error } = await run("startup plain", scratch);
		expect(attempts(scratch)).toBe(1);
		expect(error?.message).toMatch(
			/^Subagent failed \(startup\): exited with code 2 before its first model turn: No API key for provider\nFull stderr: /,
		);
	});

	it("is no startup failure once a tool ran: reported as an ordinary crash, never retried", async () => {
		const scratch = tmp();
		const { error } = await run("startup after tool", scratch);
		expect(attempts(scratch)).toBe(1);
		expect(error).not.toBeInstanceOf(StartupError);
		expect(error?.message).toMatch(/^Subagent exited with code 1: /);
	});

	it("is not retried when the user stopped it during the delay", async () => {
		const scratch = tmp();
		const controller = new AbortController();
		const id = "a-startup-stop";
		const started = Date.now();
		const pending = runSubagent(
			"startup crash",
			["--session-dir", tmp(), "--session-id", id],
			tmp(),
			undefined,
			{ id, scratch },
			controller.signal,
			() => undefined,
		);
		const failed = pending.then(
			() => new Error("finished"),
			(error: Error) => error,
		);
		await vi.waitFor(() => expect(fs.existsSync(path.join(scratch, "attempts"))).toBe(true));
		await new Promise((resolve) => setTimeout(resolve, 400));
		controller.abort(USER_STOP);
		expect((await failed).message).toBe("Subagent cancelled");
		expect(attempts(scratch)).toBe(1);
		expect(Date.now() - started).toBeLessThan(STARTUP_RETRY_DELAY_MS + 500);
	});
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
