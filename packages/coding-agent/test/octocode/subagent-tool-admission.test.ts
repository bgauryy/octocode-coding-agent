import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { renderPrompt } from "../../src/core/prompt-template.ts";
import { type AgentRuns, claimRun, MAX_SUBAGENTS_ENV, Slots } from "../../src/octocode/subagents/claim.ts";
import { meteredBilling, rendered, theme } from "./fake-host.ts";
import { refused, setup, useScriptedChild } from "./subagent-tool-harness.ts";

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));

useScriptedChild();

const ONE_AT_A_TIME = { maxSubagents: 1, lingerSeconds: 0 };

describe("agent tool with a scripted child", () => {
	let s: ReturnType<typeof setup>;
	beforeEach(() => {
		s = setup();
	});

	it("names why a profile was refused at load when the unknown profile is that one", async () => {
		refused.set(
			"blind",
			'Profile "blind" removes agent with excludeTools. Remove it from the profile\'s excludeTools.',
		);
		try {
			await expect(s.run({ task: "x", profile: "blind" })).rejects.toThrow(
				/Unknown profile "blind"\. Available: researcher, browser\n"blind" was refused when profiles loaded: Profile "blind" removes agent/,
			);
			// A name that was never a profile file gets no reason.
			await expect(s.run({ task: "x", profile: "nope" })).rejects.not.toThrow(/refused/);
		} finally {
			refused.clear();
		}
	});

	it("refuses unknown profiles and makes runs over the limit wait for a slot", async () => {
		await expect(s.run({ task: "x", profile: "nope" })).rejects.toThrow(
			/Unknown profile "nope". Available: researcher, browser/,
		);
		s = setup(undefined, true, ONE_AT_A_TIME);
		try {
			const controller = new AbortController();
			const first = s.run({ task: "slow one" }, controller.signal);
			// The second waits, and its row says why; a third gives up its wait when its turn is aborted.
			const updates: Array<{ content: Array<{ text: string }>; details: { status: string } }> = [];
			const second = s.run({ task: "report" }, undefined, (update) => updates.push(update as never));
			const gaveUp = new AbortController();
			const third = s.run({ task: "report" }, gaveUp.signal);
			await vi.waitFor(() =>
				expect(updates[0]).toMatchObject({
					content: [{ text: "waiting for a slot (1 running)" }],
					details: { status: "waiting" },
				}),
			);
			const waiting = rendered(
				s.agent.renderResult(updates[0], { isPartial: true, expanded: false }, theme, {
					args: { task: "report" },
					isError: false,
				}),
			);
			expect(waiting).toContain("waiting for a slot (1 running)");
			gaveUp.abort();
			await expect(third).rejects.toThrow("Cancelled while waiting for a subagent slot.");
			controller.abort();
			await expect(first).rejects.toThrow("Subagent cancelled");
			// The slot the cancelled run gave back starts the waiting one.
			await expect(second).resolves.toMatchObject({ details: { status: "done" } });
		} finally {
			s = setup();
		}
		await expect(s.run({ task: "report" })).resolves.toMatchObject({ details: { status: "done" } });
	});

	describe("background calls past the limit", () => {
		beforeEach(() => {
			s = setup(undefined, true, ONE_AT_A_TIME);
		});

		it("return at once with an id and a queued status, and run first come first served", async () => {
			const first = await s.run({ task: "slow one", background: true });
			expect(first.content[0].text).toMatch(/^Started /);
			// Far past the limit, as a batch fans out: every call returns without waiting for a slot.
			const queued = await Promise.all(
				[1, 2, 3].map(() => s.run({ task: "report from the background", background: true })),
			);
			for (const result of queued) {
				expect(result.content[0].text).toMatch(
					/^Queued [a-z]+-[a-z]+ \(general\) in the background: \d+ subagents are ahead of it or running, and it starts when a slot frees\./,
				);
				expect(result.details).toMatchObject({ status: "background", queued: true });
				expect(result.details.id).toBeTruthy();
			}
			expect(s.control.background()).toBe(4);
			expect(new Set(queued.map((result) => result.details.id)).size).toBe(3);
			// Nothing of a queued run started: its slot is still taken.
			expect(s.sent).toHaveLength(0);

			expect(s.control.stop(first.details.id, "user")).toBeUndefined();
			await s.control.settle();
			const reported = s.sent.map((entry) => entry.message.details?.id);
			expect(reported).toEqual(expect.arrayContaining(queued.map((result) => result.details.id)));
			expect(s.control.background()).toBe(0);
		}, 30_000);

		it("gives up a queued run on a stop without touching a slot, and survives the end of its turn", async () => {
			const first = await s.run({ task: "slow one", background: true });
			const turn = new AbortController();
			const queued = await s.run({ task: "report from the background", background: true }, turn.signal);
			const stopped = await s.run({ task: "report from the background", background: true });
			// The turn that made the call ends: a queued run is the session's, not the turn's.
			turn.abort();
			expect(s.control.stop(stopped.details.id, "user")).toBeUndefined();
			await vi.waitFor(() => expect(s.sent.map((entry) => entry.message.details?.id)).toContain(stopped.details.id));
			expect(s.control.background()).toBe(2);
			expect(s.control.stop(first.details.id, "user")).toBeUndefined();
			await s.control.settle();
			const report = s.sent.find((entry) => entry.message.details?.id === queued.details.id);
			expect(report?.message.details).toMatchObject({ status: "done" });
			// Every slot came back: the next run starts at once.
			const next = await s.run({ task: "report from the background", background: true });
			expect(next.content[0].text).toMatch(/^Started /);
			await s.control.settle();
		}, 30_000);

		it("still makes a foreground call wait, its row saying why", async () => {
			const first = await s.run({ task: "slow one", background: true });
			const updates: Array<{ details: { status: string } }> = [];
			const foreground = s.run({ task: "report" }, undefined, (update) => updates.push(update as never));
			await vi.waitFor(() => expect(updates[0]).toMatchObject({ details: { status: "waiting" } }));
			expect(s.control.stop(first.details.id, "user")).toBeUndefined();
			await expect(foreground).resolves.toMatchObject({ details: { status: "done" } });
		}, 30_000);
	});

	it("tells a resumed session about a child recorded as running that ended with it, once and without a turn", async () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "agent",
					toolCallId: "c1",
					content: [{ type: "text", text: "Started gone-1" }],
					details: { id: "gone-1", profile: "general", goal: "work", status: "background", runId: "r1", startedAt: 1 },
				},
			},
		];
		s.ctx.sessionManager.getEntries = () => entries as never;
		await s.emit("session_start", { type: "session_start", reason: "resume" }, s.ctx);
		const notes = s.sent.filter((entry) => String(entry.message.content).startsWith("[Resume]"));
		expect(notes).toHaveLength(1);
		expect(notes[0]).toMatchObject({
			message: { display: false, content: expect.stringContaining("gone-1 (general") },
			options: { triggerTurn: false },
		});
		// A new session has no record of it: only a resume or a restart is told.
		s.sent.length = 0;
		await s.emit("session_start", { type: "session_start", reason: "new" }, s.ctx);
		expect(s.sent.filter((entry) => String(entry.message.content).startsWith("[Resume]"))).toHaveLength(0);
	});

	describe("the opt-in subagents limits", () => {
		const limit = (subagents: { maxChildren?: number; maxCost?: number }) => {
			const settings = s.api.settings.get();
			vi.spyOn(s.api.settings, "get").mockReturnValue({ ...settings, subagents });
		};

		it("starts anything with no limit configured", async () => {
			const ids: string[] = [];
			for (let i = 0; i < 3; i++) {
				const result = await s.run({ task: "report" });
				expect(result.isError).not.toBe(true);
				expect(result.details.status).toBe("done");
				ids.push(result.details.id);
			}
			expect(new Set(ids).size).toBe(3);
		});

		it("refuses past maxChildren with the running total, leaving what runs alone", async () => {
			limit({ maxChildren: 1 });
			const running = await s.run({ task: "slow one", background: true });
			await expect(s.run({ task: "report" })).rejects.toThrow(
				new RegExp(
					`started 1 subagents, and subagents\\.maxChildren is 1\\. Running now, and left running: ${running.details.id}`,
				),
			);
			expect(s.control.background()).toBe(1);
			expect(s.control.stop(running.details.id, "user")).toBeUndefined();
			await s.control.settle();
		}, 30_000);

		it("counts children started by one batch, not only those already recorded", async () => {
			limit({ maxChildren: 2 });
			const results = await Promise.allSettled([1, 2, 3].map(() => s.run({ task: "report", background: true })));
			expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
			expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
			await s.control.settle();
		}, 30_000);

		it("refuses past maxCost with the session's total, counting what a running child spent", async () => {
			limit({ maxCost: 0.5 });
			s.ctx.sessionManager.getEntries = () =>
				[
					{
						type: "message",
						message: {
							role: "assistant",
							provider: "faux",
							model: "model",
							usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.75 } },
						},
					},
				] as never;
			await expect(s.run({ task: "report" })).rejects.toThrow(/spent \$0\.75, and subagents\.maxCost is \$0\.50/);
		});

		it("counts money only: $1.24 metered and $3.10 a plan paid for start a child under maxCost 2 (RFC V8)", async () => {
			limit({ maxCost: 2 });
			const reply = (provider: string, total: number) => ({
				type: "message",
				message: {
					role: "assistant",
					provider,
					model: "model",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total } },
				},
			});
			s.ctx.sessionManager.getEntries = () => [reply("faux", 1.24), reply("codex", 3.1)] as never;
			const billing = vi
				.spyOn(s.ctx.modelRegistry, "getProviderBilling")
				.mockImplementation((provider: string) => (provider === "codex" ? "plan" : "metered"));
			try {
				const result = await s.run({ task: "report" });
				expect(result.isError).not.toBe(true);
				expect(result.details.status).toBe("done");
				// The same spend all metered is past the limit.
				billing.mockImplementation(() => "metered");
				await expect(s.run({ task: "report" })).rejects.toThrow(/spent \$4\.34, and subagents\.maxCost is \$2\.00/);
			} finally {
				billing.mockRestore();
			}
		});

		it("tells the user once per limit and value, as a notice line and a spend_limit notice", async () => {
			const notices: unknown[] = [];
			s.flat.events = {
				on: () => () => undefined,
				emit: (name: string, data: unknown) => void (name === "octocode:user-notice" && notices.push(data)),
			};
			const entries: unknown[] = [
				{
					type: "message",
					message: {
						role: "assistant",
						provider: "faux",
						model: "model",
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.75 } },
					},
				},
			];
			s.ctx.sessionManager.getEntries = () => entries as never;
			const lines = () => s.entries.filter((entry) => entry.customType === "octocode-notice-line");
			limit({ maxCost: 0.5 });
			await expect(s.run({ task: "report" })).rejects.toThrow(/subagents\.maxCost is \$0\.50/);
			await expect(s.run({ task: "report" })).rejects.toThrow(/subagents\.maxCost is \$0\.50/);
			const line =
				"Subagent refused: this session has spent $0.75, past the subagents.maxCost limit ($0.50). Raise it to start more.";
			expect(lines().map((entry) => entry.data)).toEqual([{ kind: "spend_limit", key: "maxCost=0.5", text: line }]);
			expect(notices).toEqual([{ type: "spend_limit", title: "Octocode: subagent limit reached", message: line }]);
			// A resumed session reads its own line and stays quiet; a raised limit that is reached again is news.
			entries.push({ type: "custom", customType: "octocode-notice-line", data: lines()[0].data });
			limit({ maxCost: 0.7 });
			await expect(s.run({ task: "report" })).rejects.toThrow(/subagents\.maxCost is \$0\.70/);
			expect(lines()).toHaveLength(2);
			expect(notices).toHaveLength(2);
		});
	});

	it("ends a report with a notice when the run took delegated cost past a multiple of the session's own, once", async () => {
		// The session itself spent half a cent; each scripted child costs one cent.
		s.ctx.sessionManager.getEntries = () =>
			[
				{
					type: "message",
					message: {
						role: "assistant",
						provider: "faux",
						model: "model",
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.005 } },
					},
				},
			] as never;
		const first = await s.run({ task: "echo cost" });
		expect(first.isError).not.toBe(true);
		const costNote = renderPrompt("notices/subagents/cost.md", {
			once: false,
			multiple: 2,
			delegated: "≈$0.01",
			own: "≈$<0.01",
		});
		expect(first.content[0].text).toContain(costNote);
		// The entries still show no child: the same multiple is not named again.
		const second = await s.run({ task: "echo cost" });
		expect(second.isError).not.toBe(true);
		expect(second.content[0].text).not.toContain(costNote);
	});

	it("lets a child whose step a team interrupt stopped continue with the message, not end as cancelled", async () => {
		const result = await s.run({ task: "interrupted" });
		expect(result.isError).toBeUndefined();
		expect(result.details).toMatchObject({ status: "done", outcome: "done" });
		expect(result.content[0].text).not.toContain("cancelled");
	});

	it("gives the slot and the name back when setup throws after the run is claimed", async () => {
		process.env[MAX_SUBAGENTS_ENV] = "1";
		const { channels: events } = s.api;
		const registry = s.ctx.modelRegistry;
		// Within one 2 s window: a leaked slot makes the next run wait forever instead.
		const within = <T>(work: Promise<T>) =>
			Promise.race([
				work,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("waited for a leaked slot")), 2_000)),
			]);
		try {
			// After claimRun: reading the session's added MCP servers fails.
			Object.assign(s.api, {
				channels: {
					...events,
					emit: () => {
						throw new Error("event bus broke");
					},
				},
			});
			await expect(s.run({ task: "report" })).rejects.toThrow("event bus broke");
			expect(s.control.running()).toEqual([]);
			Object.assign(s.api, { channels: events });
			// Inside claimRun, after the name is taken: the child model's cache policy cannot be read.
			Object.assign(s.ctx, {
				modelRegistry: {
					...meteredBilling,
					...registry,
					getCachePolicy: () => {
						throw new Error("settings broke");
					},
				},
			});
			await expect(s.run({ task: "report" })).rejects.toThrow("settings broke");
			expect(s.control.running()).toEqual([]);
			// The name it took is given back too, so it is not listed as running or avoided by later names.
			const runs = { api: s.api, team: s.team, running: new Map(), slots: new Slots() } as unknown as AgentRuns;
			const plan = { profile: undefined, route: { model: "faux/model" } };
			expect(() => claimRun(runs, plan, { goal: "g" }, s.ctx)).toThrow("settings broke");
			expect([...runs.running.keys()]).toEqual([]);
			Object.assign(s.ctx, { modelRegistry: registry });
			await expect(within(s.run({ task: "report" }))).resolves.toMatchObject({ details: { status: "done" } });
		} finally {
			Object.assign(s.api, { channels: events });
			Object.assign(s.ctx, { modelRegistry: registry });
			delete process.env[MAX_SUBAGENTS_ENV];
		}
	});
});
