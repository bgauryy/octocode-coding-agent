import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { stopConfirmation } from "../../src/octocode/permission/stop-confirm.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { fakeCtx, fakePermission, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-host.cjs");
const savedArgv = process.argv[1];
const savedEnv = { ...process.env };

beforeAll(() => {
	const root = tmp("octocode-stop-confirm-");
	for (const key of Object.keys(process.env)) if (key.startsWith("OCTOCODE_")) delete process.env[key];
	Object.assign(process.env, {
		OCTOCODE_HOME: path.join(root, "home"),
		OCTOCODE_AGENT_DB: path.join(root, "team.sqlite"),
	});
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.copyFileSync(FIXTURE, path.join(bin, "octocode"));
	process.argv[1] = path.join(bin, "octocode");
});

afterAll(() => {
	process.argv[1] = savedArgv!;
	process.env = savedEnv;
});

function setup(hasUI = true) {
	const f = fakeHost();
	const team = new Team(f.api);
	const permission = fakePermission("workspace");
	const control = registerAgentTool(f.api, () => new Map(), team, permission);
	permission.setConfirmStop(stopConfirmation(() => control.running(), false));
	const ctx = fakeCtx({ cwd: tmp(), hasUI });
	team.start(ctx);
	const asked: string[] = [];
	const confirm = ctx.ui.confirm;
	ctx.ui.confirm = async (title: string, message: string) => {
		asked.push(`${title}: ${message}`);
		return confirm(title, message);
	};
	const start = async (goal: string) =>
		(
			await f.tools
				.get("agent")
				.execute("call", { task: "slow work", goal, background: true }, undefined, undefined, ctx)
		).details as { id: string; activity: string[] };
	const stops = () =>
		f.sent.map((entry) => String(entry.message.content)).filter((text) => text.includes("stopped by"));
	return { f, team, permission, control, ctx, asked, start, stops };
}

describe("a narrowing permission change with running agents", () => {
	it("asks once, naming both agents; declining keeps the mode and the runs", async () => {
		const t = setup();
		try {
			const [a, b] = [await t.start("first job"), await t.start("second job")];
			t.ctx.ui.confirms.push(false);
			expect(await t.permission.cycle(t.ctx)).toBe(false);
			expect(t.asked).toEqual([
				`Running agents: Switching to manual stops 2 running agents (${a.id}, ${b.id}). Continue?`,
			]);
			expect(t.permission.mode).toBe("workspace");
			expect(t.control.background()).toBe(2);
			expect(t.stops()).toEqual([]);
		} finally {
			await t.control.stopAll();
			t.team.stop();
		}
	});

	it("stops every run once confirmed; each stop report names the reason, last activity and changed files", async () => {
		const t = setup();
		try {
			const runs = [await t.start("first job"), await t.start("second job")];
			await vi.waitFor(() => expect(runs.every((run) => run.activity.length > 0)).toBe(true), { timeout: 10_000 });
			t.team.join();
			t.team.editLog()!.record(runs[0].id, "file", [path.join(t.ctx.cwd, "src", "a.ts")]);
			t.ctx.ui.confirms.push(true);
			expect(await t.permission.cycle(t.ctx)).toBe(true);
			expect(t.permission.mode).toBe("manual");
			await t.control.settle();
			expect(t.control.background()).toBe(0);
			const [first, second] = runs.map((run) => t.stops().find((text) => text.includes(`subagent ${run.id} `)) ?? "");
			for (const report of [first, second]) {
				expect(report).toContain("stopped by a permission change");
				expect(report).toContain("Last activity: → bash sleep 60");
			}
			expect(first).toContain("Changed files (1): src/a.ts");
			expect(second).toContain("Changed files: none recorded");
		} finally {
			await t.control.stopAll();
			t.team.stop();
		}
	});

	it("applies at once with no one to ask, and never asks without running agents or when widening", async () => {
		const headless = setup(false);
		try {
			await headless.start("job");
			expect(await headless.permission.chooseMode("manual", headless.ctx)).toBe(true);
			expect(headless.permission.mode).toBe("manual");
			expect(headless.asked).toEqual([]);
			await headless.control.settle();
			expect(headless.stops()).toHaveLength(1);
		} finally {
			await headless.control.stopAll();
			headless.team.stop();
		}
		const idle = setup();
		try {
			await idle.start("job");
			expect(await idle.permission.chooseMode("full", idle.ctx)).toBe(true);
			expect(idle.control.background()).toBe(1);
			await idle.control.stopAll();
			expect(await idle.permission.chooseMode("manual", idle.ctx)).toBe(true);
			expect(idle.permission.mode).toBe("manual");
			expect(idle.asked).toEqual([]);
		} finally {
			await idle.control.stopAll();
			idle.team.stop();
		}
	});
});

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));
