import fs from "node:fs";
import path from "node:path";
import { type CachePreferenceLayer, mergeCachePreferences } from "@octocodeai/octocode-ai/utils/cache-policy";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { BLOCKED_LINGER_SECONDS, reachableSeconds } from "../../src/octocode/subagents/claim.ts";
import type * as Parked from "../../src/octocode/subagents/parked.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { fakeCtx, fakePermission, fakeHost, meteredBilling } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-host.cjs");
const savedArgv = process.argv[1];
const savedEnv = { ...process.env };
const parked = vi.hoisted(() => ({ failWrites: false }));

vi.mock("../../src/octocode/subagents/parked.ts", async (original) => {
	const real = await original<typeof Parked>();
	return {
		...real,
		writeParked: (...args: Parameters<typeof real.writeParked>) => {
			if (parked.failWrites) throw new Error("ENOSPC: no space left on device");
			return real.writeParked(...args);
		},
	};
});

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));

beforeAll(() => {
	const root = tmp("octocode-agent-linger-asks-");
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

function setup() {
	const cwd = tmp();
	const f = fakeHost();
	const team = new Team(f.api);
	const control = registerAgentTool(f.api, () => new Map(), team, fakePermission("full"));
	const ctx = fakeCtx({ cwd });
	Object.assign(ctx, {
		model: { provider: "faux", id: "model" },
		modelRegistry: {
			...meteredBilling,
			getAvailable: () => [],
			find: () => undefined,
			getCachePolicy: (_model: unknown, settings: readonly CachePreferenceLayer[] = []) =>
				mergeCachePreferences(settings),
		},
	});
	team.start(ctx);
	const reports = () => f.sent.map((entry) => String(entry.message.content)).filter((text) => text.includes("LINGER"));
	const start = async (task: string) =>
		(
			await f.tools
				.get("agent")
				.execute("call-1", { task, goal: "linger test", background: true }, undefined, undefined, ctx)
		).details.id as string;
	const finish = async () => {
		await control.stopAll();
		team.stop();
	};
	return { cwd, team, control, ctx, reports, start, finish };
}

describe("reachableSeconds with an unanswered ask", () => {
	it("gives the blocked window whatever outcome was reported, and never shortens a longer setting", () => {
		for (const outcome of [undefined, "done", "partial", "failed"] as const)
			expect(reachableSeconds(outcome, {}, undefined, true)).toBe(BLOCKED_LINGER_SECONDS);
		expect(reachableSeconds("done", {}, undefined, false)).toBe(0);
		expect(reachableSeconds("done", {}, 900, true)).toBe(900);
	});
});

describe("a background subagent that ended with an unanswered replyRequired ask to its parent", () => {
	it("stays resumable with the linger setting at 0, and the parent's reply resumes it", async () => {
		delete process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS;
		const t = setup();
		const store = TeamStore.open(t.cwd, process.env.OCTOCODE_AGENT_DB);
		try {
			const id = await t.start("linger asking");
			const ask = store.send(id, [t.team.id!], "which option?", { replyRequired: true }).id!;
			await t.control.settle();
			expect(t.reports()[0]).toContain("Asks to its coordinator: 1 ask (1 unanswered)");
			expect(t.reports()[0]).toContain(
				`${id} is waiting for your reply to its question and stays resumable for ${BLOCKED_LINGER_SECONDS} s`,
			);
			expect(await t.team.send(id, "linger use the second", { replyRequired: false, replyTo: ask })).toHaveProperty(
				"resumed",
			);
			await t.control.settle();
			expect(t.reports()).toHaveLength(2);
			expect(t.reports()[1]).toMatch(/Message #[1-9]\d* from your coordinator [\s\S]*linger use the second/);
			// The follow-up asked nothing: with the setting at 0 nothing keeps the run reachable.
			expect(t.reports()[1]).not.toContain("resumable");
		} finally {
			store.close();
			await t.finish();
		}
	}, 30_000);

	it("does not linger when it asked nothing", async () => {
		delete process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS;
		const t = setup();
		try {
			const id = await t.start("linger quiet");
			await t.control.settle();
			expect(t.reports()[0]).not.toContain("resumable");
			expect(await t.team.send(id, "linger late", { replyRequired: false })).toEqual({
				error: expect.stringMatching(/has finished/),
			});
		} finally {
			await t.finish();
		}
	}, 30_000);
});

describe("a parked record that cannot be written", () => {
	it("keeps the child's report and the in-memory window, tells the user once, and never throws from the window timer", async () => {
		process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS = "60";
		parked.failWrites = true;
		const t = setup();
		const uncaught = vi.fn();
		process.on("uncaughtException", uncaught);
		try {
			const id = await t.start("linger kept");
			await t.control.settle();
			const [report] = t.reports();
			expect(report).toContain("LINGER");
			expect(report).toContain(`${id} stays reachable for 60 s`);
			expect(report).not.toContain("stopped");
			expect(t.ctx.ui.notes.filter((note) => note.message.includes("ENOSPC"))).toHaveLength(1);
			// The in-memory window works: a message resumes the child.
			expect(await t.team.send(id, "linger again", { replyRequired: false })).toHaveProperty("resumed");
			await t.control.settle();
			expect(t.reports()).toHaveLength(2);
			// A window that expires while writes fail does not throw out of its timer.
			vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
			const again = await t.start("linger expiring");
			await t.control.settle();
			await vi.advanceTimersByTimeAsync(61_000);
			expect(uncaught).not.toHaveBeenCalled();
			expect(await t.team.send(again, "linger too late", { replyRequired: false })).toEqual({
				error: expect.stringMatching(/has finished/),
			});
		} finally {
			vi.useRealTimers();
			process.off("uncaughtException", uncaught);
			parked.failWrites = false;
			delete process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS;
			await t.finish();
		}
	}, 30_000);
});
