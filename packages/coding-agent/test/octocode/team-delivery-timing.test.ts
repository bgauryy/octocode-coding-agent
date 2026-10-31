import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBashTool } from "../../src/octocode/files/bash.ts";
import { BashJobs } from "../../src/octocode/files/bash-jobs.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { tmp } from "./helpers.ts";
import { gate, liveSession } from "./team-live-session.ts";

/** Delivery latency is bounded by the one-second team tick plus the step that was running; this is the slack for CI. */
const TICK_BUDGET_MS = 3_000;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});

describe.each([
	{ kind: "FYI", replyRequired: false },
	{ kind: "waking request", replyRequired: true },
])("a busy session gets a peer's $kind at its next step", ({ replyRequired }) => {
	it("puts it in the next model request, before the turn ends", async () => {
		const long = gate();
		const live = await liveSession({
			tools: [
				{
					name: "long",
					run: async () => {
						long.entered();
						await long.released;
						return "long done";
					},
				},
				{ name: "quick", run: async () => "quick done" },
			],
		});
		closerFor(live);
		live.faux.setResponses([
			(context) => {
				live.record(context);
				return fauxAssistantMessage([fauxToolCall("long", {})], { stopReason: "toolUse" });
			},
			(context) => {
				live.record(context);
				return fauxAssistantMessage([fauxToolCall("quick", {})], { stopReason: "toolUse" });
			},
			(context) => {
				live.record(context);
				return fauxAssistantMessage([fauxToolCall("quick", {})], { stopReason: "toolUse" });
			},
			(context) => {
				live.record(context);
				return fauxAssistantMessage("finished");
			},
		]);
		const running = live.session.prompt("work");
		await long.started;
		const sentAt = Date.now();
		await live.peer.send(live.id, "MAIL: change of plan", { replyRequired });
		// The tick hands it over while the tool still runs; the tool then ends and the next call must carry it.
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		long.release();
		await running;
		await live.session.waitForIdle();

		expect(live.requests.map((request) => request.mail.length > 0)).toEqual([false, true, true, true]);
		const latency = live.requests[1].at - sentAt;
		expect(latency).toBeLessThan(TICK_BUDGET_MS + 1_500);
		// One copy in the transcript, not one per request.
		expect(live.sessionManager.getBranch().filter((entry) => entry.type === "custom_message")).toHaveLength(1);
	}, 20_000);
});

describe.each([
	{ kind: "FYI", replyRequired: false, yields: false },
	{ kind: "waking request", replyRequired: true, yields: true },
])("a long tool call while a peer's $kind waits", ({ replyRequired, yields }) => {
	// Foreground bash moves to the background when `ctx.hasPendingMessages()` turns true (files/bash/results.ts); any other
	// long tool that wants to yield for a message uses the same signal. Only mail that asks for an answer (or is the
	// user's) counts: an FYI is context, read at the next step without cutting a running command short.
	it("reports a waiting message only when it asks for the agent", async () => {
		const waiting: boolean[] = [];
		const live = await liveSession({
			tools: [
				{
					name: "long",
					run: async (_signal, ctx) => {
						waiting.push(ctx.hasPendingMessages());
						const deadline = Date.now() + (yields ? 5_000 : TICK_BUDGET_MS);
						while (!ctx.hasPendingMessages() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
						waiting.push(ctx.hasPendingMessages());
						return "long done";
					},
				},
			],
		});
		closerFor(live);
		live.faux.setResponses([
			(context) => {
				live.record(context);
				return fauxAssistantMessage([fauxToolCall("long", {})], { stopReason: "toolUse" });
			},
			(context) => {
				live.record(context);
				return fauxAssistantMessage("finished");
			},
		]);
		const running = live.session.prompt("work");
		await vi.waitFor(() => expect(waiting).toHaveLength(1));
		const sentAt = Date.now();
		await live.peer.send(live.id, "MAIL: look at this", { replyRequired });
		await running;
		expect(waiting).toEqual([false, yields]);
		if (yields) expect(Date.now() - sentAt).toBeLessThan(TICK_BUDGET_MS);
		expect(live.requests[1].mail).toHaveLength(1);
	}, 20_000);
});

describe.runIf(process.platform !== "win32")("foreground bash while a peer's mail waits", () => {
	it("moves to the background and lets the turn read the mail in the next request", async () => {
		const jobs = new BashJobs(tmp());
		const live = await liveSession({
			tools: [],
			extra: {
				register: (api) => void registerBashTool(api, new Subcommands(), jobs, () => ({ backgroundAfterSeconds: 0 })),
				names: ["bash"],
			},
		});
		closerFor(live);
		live.faux.setResponses([
			(context) => {
				live.record(context);
				return fauxAssistantMessage([fauxToolCall("bash", { command: "echo going; sleep 8" })], {
					stopReason: "toolUse",
				});
			},
			(context) => {
				live.record(context);
				return fauxAssistantMessage("answering the mail");
			},
		]);
		const started = Date.now();
		const running = live.session.prompt("build");
		await vi.waitFor(() => expect(live.requests).toHaveLength(1));
		await live.peer.send(live.id, "MAIL: stop the build", { replyRequired: true });
		await running;
		expect(Date.now() - started).toBeLessThan(6_000);
		const result = live.sessionManager
			.getBranch()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []));
		expect(JSON.stringify(result)).toContain("A message for you is waiting");
		expect(live.requests[1].mail).toHaveLength(1);
		for (const id of jobs.jobs.keys()) jobs.stop(id, "user");
	}, 30_000);
});

describe("a context-only notice during a long tool", () => {
	it("is read at the next step and does not make a running tool yield", async () => {
		const long = gate();
		const seen: boolean[] = [];
		const live = await liveSession({
			tools: [
				{
					name: "long",
					run: async (_signal, ctx) => {
						long.entered();
						await long.released;
						seen.push(ctx.hasPendingMessages());
						return "long done";
					},
				},
			],
		});
		closerFor(live);
		live.faux.setResponses([
			(context) => {
				live.record(context);
				return fauxAssistantMessage([fauxToolCall("long", {})], { stopReason: "toolUse" });
			},
			(context) => {
				live.record(context);
				return fauxAssistantMessage("finished");
			},
		]);
		const running = live.session.prompt("work");
		await long.started;
		// The subagent "done" notice (subagents/handoff.ts) and team notices are sent this way.
		live.api.sendMessage(
			{ customType: "notice-test", content: "MAIL: a child finished", display: false, details: {} },
			{ triggerTurn: false, deliverAs: "steer" },
		);
		long.release();
		await running;
		expect(seen).toEqual([false]);
		expect(live.requests.map((request) => request.mail.length)).toEqual([0, 1]);
	}, 20_000);
});

describe("a background report (follow-up) during a long tool", () => {
	it("waits for the end of the run and does not make a running tool yield", async () => {
		const long = gate();
		const seen: boolean[] = [];
		const live = await liveSession({
			tools: [
				{
					name: "long",
					run: async (_signal, ctx) => {
						long.entered();
						await long.released;
						seen.push(ctx.hasPendingMessages());
						return "long done";
					},
				},
			],
		});
		closerFor(live);
		live.faux.setResponses([
			(context) => {
				live.record(context);
				return fauxAssistantMessage([fauxToolCall("long", {})], { stopReason: "toolUse" });
			},
			(context) => {
				live.record(context);
				return fauxAssistantMessage("finished");
			},
			(context) => {
				live.record(context);
				return fauxAssistantMessage("read the report");
			},
		]);
		const running = live.session.prompt("work");
		await long.started;
		live.api.sendMessage(
			{ customType: "report-test", content: "MAIL: job finished", display: true, details: { id: "j1" } },
			{ deliverAs: "followUp", triggerTurn: true },
		);
		long.release();
		await running;
		await live.session.waitForIdle();
		expect(seen).toEqual([false]);
		// Read only after the run's last step (the follow-up starts one more).
		expect(live.requests.map((request) => request.mail.length)).toEqual([0, 0, 1]);
	}, 20_000);
});

describe("an idle session", () => {
	it("is woken by a request that wants a reply, within a tick", async () => {
		const live = await liveSession({ tools: [] });
		closerFor(live);
		live.faux.setResponses([
			(context) => {
				live.record(context);
				return fauxAssistantMessage("on it");
			},
		]);
		const sentAt = Date.now();
		await live.peer.send(live.id, "MAIL: please answer", { replyRequired: true });
		await vi.waitFor(() => expect(live.requests).toHaveLength(1), { timeout: TICK_BUDGET_MS });
		expect(live.requests[0].mail).toHaveLength(1);
		expect(live.requests[0].at - sentAt).toBeLessThan(TICK_BUDGET_MS);
	}, 20_000);

	it("is not woken by an FYI, which the model reads with the next user prompt", async () => {
		const live = await liveSession({ tools: [] });
		closerFor(live);
		live.faux.setResponses([
			(context) => {
				live.record(context);
				return fauxAssistantMessage("hello");
			},
		]);
		await live.peer.send(live.id, "MAIL: just so you know", { replyRequired: false });
		// Two ticks: the FYI reached the transcript (display only) without starting a turn.
		await vi.waitFor(
			() => expect(live.sessionManager.getBranch().filter((entry) => entry.type === "custom_message")).toHaveLength(1),
			{ timeout: TICK_BUDGET_MS },
		);
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		expect(live.requests).toHaveLength(0);
		await live.session.prompt("hi");
		expect(live.requests).toHaveLength(1);
		expect(live.requests[0].mail).toHaveLength(1);
	}, 20_000);
});

function closerFor(live: { close(): Promise<void> }) {
	closers.push(() => live.close());
}
