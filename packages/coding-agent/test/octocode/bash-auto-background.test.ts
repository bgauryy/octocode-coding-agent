import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { registerBashTool } from "../../src/octocode/files/bash.ts";
import { BashJobs } from "../../src/octocode/files/bash-jobs.ts";
import { BACKGROUND_AFTER_ENV, backgroundAfterSeconds, foregroundPlan } from "../../src/octocode/files/bash/auto.ts";
import type { ShellSettings } from "../../src/octocode/files/bash-jobs/shell.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { createHarness, getMessageText } from "../suite/harness.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const posix = process.platform !== "win32";

const until = async (check: () => boolean, ms = 10_000) => {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
};

const setup = (shell: ShellSettings) => {
	const { api, tools, sent } = fakeHost();
	const jobs = new BashJobs(tmp());
	registerBashTool(api, new Subcommands(), jobs, () => shell);
	const ctx = fakeCtx({ cwd: tmp() });
	return { tool: tools.get("bash"), jobs, sent, ctx };
};

afterEach(() => {
	delete process.env[BACKGROUND_AFTER_ENV];
});

describe("the background threshold", () => {
	it("takes the environment first, then the setting, then 90 seconds; 0 turns it off", () => {
		expect(backgroundAfterSeconds(undefined, {})).toBe(90);
		expect(backgroundAfterSeconds(30, {})).toBe(30);
		expect(backgroundAfterSeconds(30, { [BACKGROUND_AFTER_ENV]: "5" })).toBe(5);
		expect(backgroundAfterSeconds(30, { [BACKGROUND_AFTER_ENV]: "0" })).toBe(0);
		expect(backgroundAfterSeconds(30, { [BACKGROUND_AFTER_ENV]: "soon" })).toBe(30);
		expect(backgroundAfterSeconds(-4, {})).toBe(90);
	});

	it("applies unless the call waits on purpose, runs sleep, or sets a shorter deadline itself", () => {
		const plan = (params: Parameters<typeof foregroundPlan>[0], setting = 90) => foregroundPlan(params, setting, {});
		expect(plan({ command: "yarn test" })).toMatchObject({ timeout: 90, auto: true, movable: true });
		expect(plan({ command: "yarn test", timeout: 3000 })).toMatchObject({ timeout: 90, auto: true });
		expect(plan({ command: "yarn test", timeout: 3000, background: false })).toMatchObject({
			timeout: 3000,
			auto: false,
			deliberate: true,
		});
		expect(plan({ command: "yarn test", timeout: 30 })).toMatchObject({ deliberate: false });
		expect(plan({ command: "yarn test", background: false })).toMatchObject({ timeout: 90, auto: true });
		expect(plan({ command: "yarn test", timeout: 30 })).toMatchObject({ timeout: 30, auto: false });
		expect(plan({ command: "sleep 200" })).toMatchObject({ timeout: 900, auto: false, movable: false });
		expect(plan({ command: "yarn test" }, 0)).toMatchObject({ timeout: 900, auto: false });
	});
});

describe.runIf(posix)("a foreground command past the threshold", () => {
	it("moves to the background, names the job and log, and reports its exit later like any background job", async () => {
		const { tool, jobs, sent, ctx } = setup({ backgroundAfterSeconds: 1 });
		const started = Date.now();
		const result = await tool.execute("t1", { command: "echo before; sleep 3; echo after" }, undefined, undefined, ctx);
		expect(Date.now() - started).toBeLessThan(2_900);
		const job = jobs.jobs.get("bash-1")!;
		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toMatch(/^before\n\nDid not finish within 1s; moved to the background as bash-1/);
		expect(result.content[0].text).toContain("background: false with a timeout");
		expect(result.details).toMatchObject({ job: "bash-1", log: job.log, moved: true });
		expect(sent).toHaveLength(0);
		await until(() => sent.length === 1);
		expect(sent[0].message.content).toMatch(/bash-1 finished after [34]s[\s\S]*before\nafter$/);
		expect(sent[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		expect(jobs.jobs.size).toBe(0);
	});

	it("waits in the foreground when the call sets background: false with a timeout", async () => {
		const { tool, jobs, ctx } = setup({ backgroundAfterSeconds: 1 });
		const result = await tool.execute(
			"t1",
			{ command: "echo f; sleep 2; echo finished", background: false, timeout: 20 },
			undefined,
			undefined,
			ctx,
		);
		expect(result.content[0].text).toMatch(/^\[exit 0 · [\d.]+s · 2 lines · 11 B\]\nf\nfinished\n$/);
		expect(jobs.jobs.size).toBe(0);
	});

	it("stops a deliberate wait at its own timeout instead of moving it to the background", async () => {
		const { tool, jobs, sent, ctx } = setup({ backgroundAfterSeconds: 1 });
		const message = await tool
			.execute("t1", { command: "echo f; sleep 30", background: false, timeout: 1 }, undefined, undefined, ctx)
			.catch((error: Error) => error.message);
		expect(message).toMatch(/^\[timed out after 1s · [\s\S]*f[\s\S]*a longer timeout, or with background: true/);
		expect(jobs.jobs.size).toBe(0);
		expect(sent).toHaveLength(0);
	});

	it("follows OCTOCODE_BASH_BACKGROUND_AFTER_SECONDS over the setting, in both directions", async () => {
		process.env[BACKGROUND_AFTER_ENV] = "1";
		const on = setup({ backgroundAfterSeconds: 0 });
		const moved = await on.tool.execute("t1", { command: "echo on; sleep 3" }, undefined, undefined, on.ctx);
		expect(moved.content[0].text).toMatch(/moved to the background as bash-1/);
		await on.jobs.stopAll("session end");
		process.env[BACKGROUND_AFTER_ENV] = "0";
		const off = setup({ backgroundAfterSeconds: 1 });
		const waited = await off.tool.execute(
			"t2",
			{ command: "echo off; sleep 2; echo waited" },
			undefined,
			undefined,
			off.ctx,
		);
		expect(waited.content[0].text).toMatch(/^\[exit 0 · [\d.]+s · 2 lines · 11 B\]\noff\nwaited\n$/);
		expect(off.jobs.jobs.size).toBe(0);
	});

	it("leaves a sleep to its own deadline", async () => {
		const { tool, jobs, ctx } = setup({ backgroundAfterSeconds: 1 });
		const result = await tool.execute("t1", { command: "sleep 2" }, undefined, undefined, ctx);
		expect(result.content[0].text).toMatch(/^\[exit 0 · [\d.]+s · no output\]$/);
		expect(jobs.jobs.size).toBe(0);
	});
});

describe.runIf(posix)("a user message queued during a foreground command", () => {
	it("moves the command to the background at once, whatever the threshold", async () => {
		const { tool, jobs, sent, ctx } = setup({ backgroundAfterSeconds: 0 });
		let pending = false;
		ctx.hasPendingMessages = () => pending;
		setTimeout(() => {
			pending = true;
		}, 200);
		const started = Date.now();
		const result = await tool.execute("t1", { command: "echo going; sleep 3; echo gone" }, undefined, undefined, ctx);
		expect(Date.now() - started).toBeLessThan(2_900);
		expect(result.content[0].text).toMatch(
			/^going\n\nA message for you is waiting, so this command \(running \d+s?\) moved to the background as bash-1/,
		);
		expect(result.details).toMatchObject({ job: "bash-1", moved: true });
		await until(() => sent.length === 1);
		expect(sent[0].message.content).toMatch(/bash-1 finished[\s\S]*going\ngone$/);
		expect(jobs.jobs.size).toBe(0);
	});

	it("does not move a command that finishes quickly, even with a message waiting", async () => {
		const { tool, jobs, ctx } = setup({ backgroundAfterSeconds: 0 });
		ctx.hasPendingMessages = () => true;
		const result = await tool.execute("t1", { command: "echo quick" }, undefined, undefined, ctx);
		expect(result.content[0].text).toMatch(/^\[exit 0 · [\d.]+s · 1 line · 6 B\]\nquick\n$/);
		expect(jobs.jobs.size).toBe(0);
	});

	it("lets the turn go on to answer the message while the command keeps running", async () => {
		const root = tmp();
		const manager = SessionManager.create(root, path.join(root, "sessions"));
		const jobs = new BashJobs(tmp());
		const harness = await createHarness({
			sessionManager: manager,
			extensionFactories: [
				(api) => void registerBashTool(api, new Subcommands(), jobs, () => ({ backgroundAfterSeconds: 0 })),
			],
		});
		await harness.session.bindExtensions({});
		let secondRequest: string[] = [];
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo working; sleep 30" })], { stopReason: "toolUse" }),
			(context) => {
				secondRequest = context.messages.map((message) => getMessageText(message));
				return fauxAssistantMessage("the command runs in the background");
			},
		]);
		try {
			const turn = harness.session.prompt("build it");
			await until(() => harness.session.isStreaming);
			await new Promise((resolve) => setTimeout(resolve, 400));
			await harness.session.steer("status?");
			const started = Date.now();
			await turn;
			expect(Date.now() - started).toBeLessThan(10_000);
			expect(secondRequest.some((text) => text.includes("moved to the background as bash-1"))).toBe(true);
			expect(secondRequest.some((text) => text.includes("status?"))).toBe(true);
			expect(jobs.running()).toHaveLength(1);
			expect(fs.existsSync(jobs.jobs.get("bash-1")!.log)).toBe(true);
		} finally {
			await jobs.stopAll("session end");
			harness.cleanup();
		}
	});
});
