import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/index.ts";
import { sendMessage } from "../../src/octocode/api/bridge/send.ts";
import { EventLog } from "../../src/octocode/api/events.ts";
import { SendReceipts } from "../../src/octocode/api/receipts.ts";
import { gate, liveSession } from "./team-live-session.ts";

/** Delivery latency is bounded by the one-second team tick plus the step that was running; this is the slack for CI. */
const TICK_BUDGET_MS = 3_000;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});

const CHILD = { OCTOCODE_AGENT_ID: "general-c1c1c1", OCTOCODE_PARENT_ID: "main-9a9a9a" };

/** A headless subagent (print mode: nobody to talk to) of `parent`, running the same scripted steps as a main session. */
const child = (tools: Parameters<typeof liveSession>[0]["tools"]) =>
	liveSession({ tools, mode: "print", env: CHILD, peerId: CHILD.OCTOCODE_PARENT_ID });

describe("a subagent", () => {
	it("reads its parent's message at its next step while a long tool runs", async () => {
		const long = gate();
		const live = await child([
			{
				name: "long",
				run: async () => {
					long.entered();
					await long.released;
					return "long done";
				},
			},
		]);
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
		expect(live.id).toBe(CHILD.OCTOCODE_AGENT_ID);
		const running = live.session.prompt("work");
		await long.started;
		const sentAt = Date.now();
		await live.peer.send(live.id, "MAIL: use the other API", { replyRequired: false });
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		long.release();
		await running;
		expect(live.requests.map((request) => request.mail.length)).toEqual([0, 1]);
		expect(live.requests[1].at - sentAt).toBeLessThan(TICK_BUDGET_MS + 1_500);
	}, 20_000);

	it("stops its running tool for its parent's interrupt and reads the message in the next request", async () => {
		const long = gate();
		let aborted = false;
		const live = await child([
			{
				name: "long",
				run: async (signal) => {
					long.entered();
					await new Promise<void>((resolve) => {
						signal?.addEventListener("abort", () => resolve(), { once: true });
						void long.released.then(resolve);
					});
					aborted = signal?.aborted === true;
					return "stopped";
				},
			},
		]);
		closerFor(live);
		live.faux.setResponses([
			(context) => {
				live.record(context);
				return fauxAssistantMessage([fauxToolCall("long", {})], { stopReason: "toolUse" });
			},
			(context) => {
				live.record(context);
				return fauxAssistantMessage("redirected");
			},
		]);
		const running = live.session.prompt("work");
		await long.started;
		const sentAt = Date.now();
		const sent = await live.peer.send(live.id, "MAIL: stop and do this instead", { interrupt: true });
		expect(sent).toMatchObject({ sent: [live.id] });
		await vi.waitFor(() => expect(live.requests.length).toBeGreaterThanOrEqual(2), { timeout: TICK_BUDGET_MS });
		long.release();
		await running;
		await live.session.waitForIdle();
		expect(aborted).toBe(true);
		expect(live.requests.at(-1)!.mail).toHaveLength(1);
		expect(live.requests.at(-1)!.at - sentAt).toBeLessThan(TICK_BUDGET_MS);
	}, 20_000);

	it("reads a sibling's message at its next step", async () => {
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
			],
			mode: "print",
			env: CHILD,
			peerEnv: () => ({ OCTOCODE_AGENT_ID: "general-e3e3e3", OCTOCODE_PARENT_ID: CHILD.OCTOCODE_PARENT_ID }),
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
		const sent = await live.peer.send(live.id, "MAIL: I changed the schema", { replyRequired: false });
		expect(sent).toMatchObject({ sent: [live.id] });
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		long.release();
		await running;
		expect(live.requests.map((request) => request.mail.length)).toEqual([0, 1]);
	}, 20_000);

	it("reaches its parent at the parent's next step, whether a report notice or a message", async () => {
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
			],
			peerEnv: (parent) => ({ OCTOCODE_AGENT_ID: "general-d2d2d2", OCTOCODE_PARENT_ID: parent }),
		});
		closerFor(live);
		live.faux.setResponses([
			(context) => {
				live.record(context);
				return fauxAssistantMessage([fauxToolCall("long", {})], { stopReason: "toolUse" });
			},
			(context) => {
				live.record(context);
				return fauxAssistantMessage("read it");
			},
		]);
		const running = live.session.prompt("work");
		await long.started;
		const sentAt = Date.now();
		await live.peer.send(live.id, "MAIL: found the cause", { replyRequired: false });
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		long.release();
		await running;
		expect(live.requests.map((request) => request.mail.length)).toEqual([0, 1]);
		expect(live.requests[1].at - sentAt).toBeLessThan(TICK_BUDGET_MS + 1_500);
	}, 20_000);
});

describe("an external client (API message.send, the inbound side of the octocode transport)", () => {
	it("steers a busy agent: the message is in the next model request, not at the end of the turn", async () => {
		const long = gate();
		let ctx: ExtensionContext | undefined;
		const live = await liveSession({
			tools: [
				{
					name: "long",
					run: async (_signal, toolCtx) => {
						ctx = toolCtx;
						long.entered();
						await long.released;
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
				return fauxAssistantMessage([fauxToolCall("long", {})], { stopReason: "toolUse" });
			},
			(context) => {
				live.record(context);
				return fauxAssistantMessage("finished");
			},
		]);
		const receipts = new SendReceipts();
		receipts.follow(live.session.sessionManager.getSessionId());
		const host = {
			pi: live.pi,
			agents: { list: () => [], deliverable: (text: string) => text },
			operations: {},
			receipts,
			log: new EventLog(),
			session: () => ctx!,
			guardSession: () => undefined,
			nextId: () => "x1",
			audit: () => undefined,
		} as unknown as Parameters<typeof sendMessage>[0];
		const running = live.session.prompt("work");
		await long.started;
		const accepted = await sendMessage(host, { text: "MAIL: from the ci bot", from: "ci bot" });
		expect(accepted).toEqual({ id: "x1", queued: "steer" });
		long.release();
		await vi.waitFor(() => expect(live.requests.length).toBeGreaterThanOrEqual(2));
		expect(live.requests[1].mail).toHaveLength(1);
		await running;
	}, 20_000);
});

function closerFor(live: { close(): Promise<void> }) {
	closers.push(() => live.close());
}
