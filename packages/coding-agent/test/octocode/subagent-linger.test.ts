import fs from "node:fs";
import path from "node:path";
import { type CachePreferenceLayer, mergeCachePreferences } from "@octocodeai/octocode-ai/utils/cache-policy";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { BLOCKED_LINGER_SECONDS } from "../../src/octocode/subagents/claim.ts";
import { buildAgentArgs } from "../../src/octocode/subagents/process.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { fakeCtx, fakePermission, fakePi } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-pi.cjs");
const savedArgv = process.argv[1];
const savedEnv = { ...process.env };

beforeAll(() => {
	const root = tmp("octocode-agent-linger-");
	for (const key of Object.keys(process.env)) if (key.startsWith("OCTOCODE_")) delete process.env[key];
	Object.assign(process.env, {
		OCTOCODE_HOME: path.join(root, "home"),
		OCTOCODE_AGENT_DB: path.join(root, "team.sqlite"),
	});
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.copyFileSync(FIXTURE, path.join(bin, "pi"));
	process.argv[1] = path.join(bin, "pi");
});

afterAll(() => {
	process.argv[1] = savedArgv!;
	process.env = savedEnv;
});

function setup(mode: "manual" | "workspace" | "full" = "workspace") {
	const f = fakePi();
	const team = new Team(f.pi);
	const permission = fakePermission(mode);
	const control = registerAgentTool(f.pi, () => new Map(), team, permission);
	const ctx = fakeCtx({ cwd: tmp() });
	Object.assign(ctx, {
		model: { provider: "faux", id: "model" },
		modelRegistry: {
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
	return { f, team, control, ctx, reports, start, permission };
}

describe("a background subagent that reported blocked", () => {
	const run = async (setting: string | undefined, test: (t: ReturnType<typeof setup>) => Promise<void>) => {
		if (setting === undefined) delete process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS;
		else process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS = setting;
		const t = setup("full");
		try {
			await test(t);
		} finally {
			await t.control.stopAll();
			t.team.stop();
			delete process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS;
		}
	};

	it("stays resumable for the blocked window with the linger setting at 0, and a message resumes its saved session", async () => {
		await run(undefined, async (t) => {
			const id = await t.start("linger blocked on a decision");
			await t.control.settle();
			expect(t.reports()[0]).toContain(`reported blocked`);
			expect(t.reports()[0]).toContain(
				`${id} is blocked and stays resumable for ${BLOCKED_LINGER_SECONDS} s: answer it with \`agent\` type \`message\` to ${id}`,
			);
			expect(await t.team.send(id, "linger answered: use the second option", { replyRequired: false })).toHaveProperty(
				"resumed",
			);
			await t.control.settle();
			expect(t.reports()).toHaveLength(2);
			expect(t.reports()[1]).toContain("Follow-up from your parent:\nlinger answered: use the second option");
			// The follow-up reported no outcome: with the setting at 0 nothing keeps the run reachable.
			expect(t.reports()[1]).not.toContain("reachable");
			expect(t.reports()[1]).not.toContain("resumable");
		});
	});

	it("releases the saved context when the blocked window ends", async () => {
		delete process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS;
		const t = setup("full");
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		try {
			const id = await t.start("linger blocked once");
			await t.control.settle();
			await vi.advanceTimersByTimeAsync((BLOCKED_LINGER_SECONDS - 1) * 1000);
			expect(t.control.stop(id, "parent")).toBeUndefined();
			const again = await t.start("linger blocked twice");
			await t.control.settle();
			await vi.advanceTimersByTimeAsync(BLOCKED_LINGER_SECONDS * 1000);
			expect(t.control.stop(again, "parent")).toBe(`No background subagent "${again}". None is running.`);
			expect(await t.team.send(again, "linger too late", { replyRequired: false })).toEqual({
				error: expect.stringMatching(/has finished/),
			});
		} finally {
			await t.control.stopAll();
			t.team.stop();
			vi.useRealTimers();
		}
	});

	it("does not keep a run that reported done reachable when the setting is 0", async () => {
		await run(undefined, async (t) => {
			const id = await t.start("linger finished");
			await t.control.settle();
			expect(t.reports()[0]).not.toContain("reachable");
			expect(t.reports()[0]).not.toContain("resumable");
			expect(await t.team.send(id, "linger later", { replyRequired: false })).toEqual({
				error: expect.stringMatching(/has finished/),
			});
		});
	});

	it.each([
		["60", BLOCKED_LINGER_SECONDS],
		["900", 900],
	])("uses the larger of the setting (%s) and the blocked window", async (setting, seconds) => {
		await run(setting, async (t) => {
			const id = await t.start("linger blocked");
			await t.control.settle();
			expect(t.reports()[0]).toContain(`${id} is blocked and stays resumable for ${seconds} s`);
		});
	});
});

describe("a lingering background subagent", () => {
	it("releases expired continuations without waiting for a message to their names", async () => {
		process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS = "1";
		const t = setup("full");
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		try {
			const id = await t.start("linger once");
			await t.control.settle();
			expect(t.reports()[0]).toContain("reachable for 1 s");
			await vi.advanceTimersByTimeAsync(1000);
			// The window ended: nothing lingers and nothing runs, so the stop is refused by name.
			expect(t.control.stop(id, "parent")).toBe(`No background subagent "${id}". None is running.`);
			expect(await t.team.send(id, "linger expired", { replyRequired: false })).toEqual({
				error: expect.stringMatching(/has finished/),
			});
		} finally {
			await t.control.stopAll();
			t.team.stop();
			vi.useRealTimers();
			delete process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS;
		}
	});

	it("renews approval and uses the current parent mode for a continuation", async () => {
		process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS = "60";
		const t = setup("full");
		try {
			const id = await t.start("linger first");
			await t.control.settle();
			expect(t.reports()[0]).toContain("mode=full");
			t.permission.setMode("manual", t.ctx);
			t.ctx.ui.selects.push("Deny", "Allow once");
			await expect(t.team.send(id, "linger denied", { replyRequired: false })).rejects.toThrow("denied");
			expect(t.control.background()).toBe(0);
			expect(await t.team.send(id, "linger approved", { replyRequired: false })).toHaveProperty("resumed");
			await t.control.settle();
			expect(t.reports()).toHaveLength(2);
			expect(t.reports()[1]).toContain("mode=manual grants=file.workspace,shell");
		} finally {
			await t.control.stopAll();
			t.team.stop();
			delete process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS;
		}
	});

	it("does not inherit revoked session grants when it resumes", async () => {
		process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS = "60";
		const t = setup("manual");
		try {
			t.ctx.ui.selects.push("Allow all web requests for this session", "Allow once");
			await t.permission.check(t.ctx, { action: "web", title: "Fetch?", what: ["https://example.com"] });
			const id = await t.start("linger first");
			await t.control.settle();
			expect(t.reports()[0]).toContain("grants=file.workspace,shell,web");
			t.permission.clearGrants();
			t.ctx.ui.selects.push("Allow once");
			await t.team.send(id, "linger again", { replyRequired: false });
			await t.control.settle();
			expect(t.reports()[1]).toContain("mode=manual grants=file.workspace,shell ");
		} finally {
			await t.control.stopAll();
			t.team.stop();
			delete process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS;
		}
	});

	it("cancels a pending continuation approval when grants are revoked and permits a fresh retry", async () => {
		process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS = "60";
		const t = setup("full");
		try {
			const id = await t.start("linger first");
			await t.control.settle();
			t.permission.setMode("manual", t.ctx);
			let answer!: (choice: string) => void;
			const select = vi.spyOn(t.ctx.ui, "select").mockImplementationOnce(
				() =>
					new Promise<string>((resolve) => {
						answer = resolve;
					}),
			);
			const pending = t.team.send(id, "linger stale approval", { replyRequired: false });
			await vi.waitFor(() => expect(select).toHaveBeenCalled());
			t.permission.clearGrants();
			answer("Allow once");
			await expect(pending).rejects.toThrow(/dismissed|abort/i);
			expect(t.control.background()).toBe(0);
			select.mockRestore();
			t.ctx.ui.selects.push("Allow once");
			expect(await t.team.send(id, "linger fresh approval", { replyRequired: false })).toHaveProperty("resumed");
			await t.control.settle();
			expect(t.reports()).toHaveLength(2);
		} finally {
			await t.control.stopAll();
			t.team.stop();
			delete process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS;
		}
	});

	it("stops a running child when permissions tighten, then reauthorizes its continuation", async () => {
		process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS = "60";
		const t = setup("full");
		try {
			const id = await t.start("hang");
			t.permission.setMode("manual", t.ctx);
			await t.control.settle();
			expect(t.control.background()).toBe(0);
			expect(t.f.sent.some((entry) => String(entry.message.content).includes("stopped by a permission change"))).toBe(
				true,
			);
			t.ctx.ui.selects.push("Allow once");
			expect(await t.team.send(id, "linger approved continuation", { replyRequired: false })).toHaveProperty("resumed");
			await t.control.settle();
			expect(t.reports().at(-1)).toContain("mode=manual");
		} finally {
			await t.control.stopAll();
			t.team.stop();
			delete process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS;
		}
	});

	it("names a permission change as what stopped a foreground child, and shows it stopping meanwhile", async () => {
		const t = setup("full");
		try {
			const updates: Array<{ content: Array<{ text: string }>; details: { stopping?: boolean } }> = [];
			const running = t.f.tools
				.get("agent")
				.execute(
					"call-fg",
					{ task: "slow foreground", goal: "foreground" },
					undefined,
					(update: never) => updates.push(update),
					t.ctx,
				);
			// The child ran its first tool: it is up, and the foreground run is registered to be stopped.
			await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0), { timeout: 10_000 });
			t.permission.setMode("manual", t.ctx);
			await expect(running).rejects.toThrow(
				/was stopped by a permission change\. Ask the user before starting it again\./,
			);
			expect(
				updates.some((update) => update.details.stopping === true && update.content[0]!.text === "stopping…"),
			).toBe(true);
		} finally {
			t.team.stop();
		}
	});

	it("never starts a background child for an already-cancelled call", async () => {
		const t = setup("full");
		try {
			await expect(
				t.f.tools
					.get("agent")
					.execute(
						"cancelled",
						{ task: "linger cancelled", goal: "cancelled run", background: true },
						AbortSignal.abort(),
						undefined,
						t.ctx,
					),
			).rejects.toThrow();
			expect(t.control.background()).toBe(0);
			expect(t.f.sent).toHaveLength(0);
		} finally {
			t.team.stop();
		}
	});

	it("can retry a follow-up after another run temporarily fills the capacity", async () => {
		process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS = "60";
		process.env.OCTOCODE_MAX_SUBAGENTS = "1";
		const t = setup();
		try {
			const id = await t.start("linger first");
			await vi.waitFor(() => expect(t.reports()).toHaveLength(1), { timeout: 10_000 });
			const busy = (
				await t.f.tools
					.get("agent")
					.execute("busy", { task: "hang", goal: "occupy slot", background: true }, undefined, undefined, t.ctx)
			).details.id as string;
			await expect(t.team.send(id, "linger follow-up", { replyRequired: false })).rejects.toThrow("limit is 1");
			expect(t.control.stop(busy, "parent")).toBeUndefined();
			await t.control.settle();
			expect(await t.team.send(id, "linger follow-up", { replyRequired: false })).toMatchObject({
				resumed: expect.stringContaining(`Resumed ${id}`),
			});
			await vi.waitFor(() => expect(t.reports()).toHaveLength(2), { timeout: 10_000 });
		} finally {
			await t.control.stopAll();
			t.team.stop();
			delete process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS;
			delete process.env.OCTOCODE_MAX_SUBAGENTS;
		}
	}, 30_000);

	it("saves every child's conversation under its own name, lingering or not: only a lingering one is resumable", () => {
		const args = buildAgentArgs(undefined, undefined, { dir: "/s/session", id: "inky-kraken" });
		expect(args).not.toContain("--no-session");
		expect(args.join(" ")).toContain("--session-dir /s/session --session-id inky-kraken");
	});

	it("continues its own conversation when messaged after it finished, and reports again", async () => {
		process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS = "60";
		try {
			const { team, reports, start } = setup();
			const id = await start("linger first");
			await vi.waitFor(() => expect(reports()).toHaveLength(1), { timeout: 10_000 });
			expect(reports()[0]).toContain(`--session-id ${id}`);
			// The first report says how long it stays reachable.
			expect(reports()[0]).toMatch(/reachable for 60 s/);
			const sent = await team.send(id, "linger second: add the tests", { replyRequired: false });
			expect(sent).toMatchObject({ resumed: expect.stringContaining(`Resumed ${id}`) });
			await vi.waitFor(() => expect(reports()).toHaveLength(2), { timeout: 10_000 });
			expect(reports()[1]).toContain(`--session-id ${id}`);
			expect(reports()[1]).toContain("linger second: add the tests");
			team.stop();
		} finally {
			delete process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS;
		}
	}, 30_000);

	it("ends early on coordinate stop, and is off by default", async () => {
		process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS = "60";
		try {
			const { team, control, reports, start } = setup();
			const id = await start("linger once");
			await vi.waitFor(() => expect(reports()).toHaveLength(1), { timeout: 10_000 });
			expect(control.stop(id, "parent")).toBeUndefined();
			expect(await team.send(id, "linger again", { replyRequired: false })).toEqual({
				error: expect.stringMatching(/has finished/),
			});
			team.stop();
		} finally {
			delete process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS;
		}
		const off = setup();
		const id = await off.start("linger default");
		await vi.waitFor(() => expect(off.reports()).toHaveLength(1), { timeout: 10_000 });
		expect(off.reports()[0]).toContain("--session-dir");
		expect(off.reports()[0]).not.toContain("--no-session");
		expect(await off.team.send(id, "linger again", { replyRequired: false })).toEqual({
			error: expect.stringMatching(/has finished/),
		});
		off.team.stop();
	}, 30_000);
});

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]!] }),
}));
