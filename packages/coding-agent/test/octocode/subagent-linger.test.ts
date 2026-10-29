import fs from "node:fs";
import path from "node:path";
import { type CachePreferenceLayer, mergeCachePreferences } from "@octocodeai/octocode-ai/utils/cache-policy";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { BLOCKED_LINGER_SECONDS } from "../../src/octocode/subagents/claim.ts";
import { readParked } from "../../src/octocode/subagents/parked.ts";
import { sessionDir } from "../../src/octocode/shared/home.ts";
import { buildAgentArgs } from "../../src/octocode/subagents/process/session.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import type { AgentProfile } from "../../src/octocode/subagents/profiles.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { fakeCtx, fakePermission, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-host.cjs");
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
	fs.copyFileSync(FIXTURE, path.join(bin, "octocode"));
	process.argv[1] = path.join(bin, "octocode");
});

afterAll(() => {
	process.argv[1] = savedArgv!;
	process.env = savedEnv;
});

function setup(
	mode: "manual" | "workspace" | "full" = "workspace",
	cwd = tmp(),
	profiles = new Map<string, AgentProfile>(),
) {
	const f = fakeHost();
	const team = new Team(f.api);
	const permission = fakePermission(mode);
	const control = registerAgentTool(f.api, () => profiles, team, permission);
	const ctx = fakeCtx({ cwd });
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
	const start = async (task: string, extra: Record<string, unknown> = {}) =>
		(
			await f.tools
				.get("agent")
				.execute("call-1", { task, goal: "linger test", background: true, ...extra }, undefined, undefined, ctx)
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

describe("a profile's linger seconds", () => {
	const profile = (linger?: number): Map<string, AgentProfile> =>
		new Map([
			["watcher", { name: "watcher", description: "", prompt: "Watch.", ...(linger === undefined ? {} : { linger }) }],
		]);
	const run = async (
		setting: string | undefined,
		linger: number | undefined,
		test: (t: ReturnType<typeof setup>) => Promise<void>,
	) => {
		if (setting === undefined) delete process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS;
		else process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS = setting;
		const t = setup("full", tmp(), profile(linger));
		try {
			await test(t);
		} finally {
			await t.control.stopAll();
			t.team.stop();
			delete process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS;
		}
	};

	it("keeps a finished run of that profile reachable although the setting is off, and a message resumes it", async () => {
		await run(undefined, 900, async (t) => {
			const id = await t.start("linger watched", { profile: "watcher" });
			await t.control.settle();
			expect(t.reports()[0]).toContain(`${id} stays reachable for 900 s`);
			expect(await t.team.send(id, "linger follow-up", { replyRequired: false })).toHaveProperty("resumed");
			await t.control.settle();
			expect(t.reports()[1]).toContain("Follow-up from your parent:\nlinger follow-up");
		});
	});

	it("replaces the setting, including with 0 to turn the window off for the profile", async () => {
		await run("60", 900, async (t) => {
			await t.start("linger longer", { profile: "watcher" });
			await t.control.settle();
			expect(t.reports()[0]).toContain("stays reachable for 900 s");
		});
		await run("60", 0, async (t) => {
			await t.start("linger off", { profile: "watcher" });
			await t.control.settle();
			expect(t.reports()[0]).not.toContain("reachable");
		});
	});

	it("still gives a blocked report the blocked window when the profile's is shorter", async () => {
		await run(undefined, 30, async (t) => {
			const id = await t.start("linger blocked on a decision", { profile: "watcher" });
			await t.control.settle();
			expect(t.reports()[0]).toContain(`${id} is blocked and stays resumable for ${BLOCKED_LINGER_SECONDS} s`);
		});
	});
});

describe("a lingering background subagent", () => {
	it("restores a browser child with a per-call visible-mode override", async () => {
		process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS = "60";
		const cwd = tmp();
		const browser: AgentProfile = {
			name: "browser",
			description: "browser",
			prompt: "Browse.",
			tools: "browser,web",
			headless: true,
		};
		const profiles = new Map([["browser", browser]]);
		const first = setup("full", cwd, profiles);
		try {
			const id = await first.start("linger visible", { profile: "browser", headless: false });
			await first.control.settle();
			const saved = JSON.parse(fs.readFileSync(path.join(sessionDir("session-test"), "parked-workers.json"), "utf8"));
			expect(saved[0].run.profile.headless).toBe(false);
			const archive = path.join(saved[0].run.identity.scratch, "session");
			fs.mkdirSync(archive, { recursive: true });
			fs.writeFileSync(path.join(archive, `2026-01-01T00-00-00-000Z_${id}.jsonl`), "{}\n");
			first.team.stop();
			const reopened = setup("full", cwd, profiles);
			try {
				await reopened.f.emit("session_start", {}, reopened.ctx);
				expect(await reopened.team.send(id, "linger visible again", { replyRequired: false })).toHaveProperty(
					"resumed",
				);
				await reopened.control.settle();
				expect(reopened.reports()[0]).toContain("linger visible again");
			} finally {
				await reopened.control.stopAll();
				reopened.team.stop();
			}
		} finally {
			await first.control.stopAll();
			delete process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS;
		}
	}, 30_000);

	it("restores a parked worker for the same session and workspace, then resumes only on an explicit follow-up", async () => {
		process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS = "60";
		const cwd = tmp();
		const first = setup("full", cwd);
		try {
			const id = await first.start("linger before restart");
			await first.control.settle();
			// The RPC fixture reports a conversation but does not write its session file in this scenario.
			const saved = JSON.parse(fs.readFileSync(path.join(sessionDir("session-test"), "parked-workers.json"), "utf8"));
			const archive = path.join(saved[0].run.identity.scratch, "session");
			fs.mkdirSync(archive, { recursive: true });
			const transcript = path.join(archive, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
			fs.writeFileSync(transcript, "{}\n");
			expect(readParked("session-test", cwd).map((entry) => entry.run.identity.id)).toContain(id);
			const registry = path.join(sessionDir("session-test"), "parked-workers.json");
			fs.writeFileSync(registry, JSON.stringify([{ ...saved[0], until: "not a deadline" }]));
			expect(readParked("session-test", cwd)).toEqual([]);
			fs.writeFileSync(registry, JSON.stringify(saved));
			if (process.platform !== "win32") {
				const scratch = saved[0].run.identity.scratch as string;
				const moved = path.join(cwd, "saved-scratch");
				const original = path.join(cwd, "original-session.jsonl");
				fs.renameSync(transcript, original);
				fs.symlinkSync(original, transcript);
				expect(readParked("session-test", cwd)).toEqual([]);
				fs.rmSync(transcript);
				fs.renameSync(original, transcript);
				fs.renameSync(scratch, moved);
				fs.symlinkSync(moved, scratch, "dir");
				expect(readParked("session-test", cwd)).toEqual([]);
				fs.rmSync(scratch);
				fs.renameSync(moved, scratch);
			}
			first.team.stop();
			const reopened = setup("full", cwd);
			try {
				await reopened.f.emit("session_start", {}, reopened.ctx);
				expect(reopened.control.background()).toBe(0);
				expect(await reopened.team.send(id, "linger after restart", { replyRequired: false })).toHaveProperty(
					"resumed",
				);
				await reopened.control.settle();
				expect(reopened.reports()[0]).toContain("linger after restart");
				expect(reopened.reports()[0]).toContain(`--session-id ${id}`);
			} finally {
				await reopened.control.stopAll();
				reopened.team.stop();
			}
		} finally {
			await first.control.stopAll();
			delete process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS;
		}
	}, 30_000);

	it("never saves MCP server configs in the parked record, and resumes with the current servers", async () => {
		process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS = "60";
		const t = setup("full");
		let servers: Record<string, unknown> = { old: { command: "echo", env: { TOKEN: "SECRET-PARKED-123" } } };
		Object.assign(t.f.api, {
			events: { on: () => () => undefined, emit: (_name: string, reply: (added: unknown) => void) => reply(servers) },
		});
		try {
			const id = await t.start("linger with servers");
			await t.control.settle();
			expect(t.reports()[0]).toContain("mcp=old ");
			const text = fs.readFileSync(path.join(sessionDir("session-test"), "parked-workers.json"), "utf8");
			expect(text).not.toContain("SECRET-PARKED-123");
			const saved = (JSON.parse(text) as Array<{ run: { identity: Record<string, unknown> } }>).find(
				(entry) => entry.run.identity.id === id,
			);
			expect(saved?.run.identity).toBeDefined();
			expect(saved?.run.identity).not.toHaveProperty("mcpServers");
			// The session's servers changed since: the continuation gets the current ones, not the ones it started with.
			servers = { fresh: { command: "echo" } };
			expect(await t.team.send(id, "linger again", { replyRequired: false })).toHaveProperty("resumed");
			await t.control.settle();
			expect(t.reports()[1]).toContain("mcp=fresh ");
		} finally {
			await t.control.stopAll();
			t.team.stop();
			delete process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS;
		}
	}, 30_000);

	it("does not reopen a parked worker in a different workspace or after an explicit stop", async () => {
		process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS = "60";
		const cwd = tmp();
		const first = setup("full", cwd);
		try {
			const id = await first.start("linger before stop");
			await first.control.settle();
			const other = setup("full", tmp());
			try {
				await other.f.emit("session_start", {}, other.ctx);
				expect(await other.team.send(id, "wrong workspace", { replyRequired: false })).toHaveProperty("error");
			} finally {
				other.team.stop();
			}
			expect(first.control.stop(id, "parent")).toBeUndefined();
			first.team.stop();
			const reopened = setup("full", cwd);
			try {
				await reopened.f.emit("session_start", {}, reopened.ctx);
				expect(await reopened.team.send(id, "after stop", { replyRequired: false })).toHaveProperty("error");
			} finally {
				reopened.team.stop();
			}
		} finally {
			await first.control.stopAll();
			delete process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS;
		}
	}, 30_000);
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

	it("keeps pending revival single-flight and refuses it after an explicit stop", async () => {
		process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS = "60";
		const t = setup("full");
		try {
			const id = await t.start("linger before decision");
			await t.control.settle();
			t.permission.setMode("manual", t.ctx);
			let answer!: (choice: string) => void;
			const select = vi.spyOn(t.ctx.ui, "select").mockImplementationOnce(
				() =>
					new Promise<string>((resolve) => {
						answer = resolve;
					}),
			);
			const pending = t.team.send(id, "linger awaiting approval", { replyRequired: false });
			await vi.waitFor(() => expect(select).toHaveBeenCalled());
			await expect(t.team.send(id, "linger concurrent", { replyRequired: false })).rejects.toThrow(
				"already awaiting permission",
			);
			expect(t.control.stop(id, "parent")).toBeUndefined();
			answer("Allow once");
			await expect(pending).rejects.toThrow("no longer available");
			expect(t.control.background()).toBe(0);
			select.mockRestore();
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
			expect(updates.some((update) => update.details.stopping === true && update.content[0].text === "stopping…")).toBe(
				true,
			);
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
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));
