import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	describePayloadLayers,
	type Model,
	type SimpleStreamOptions,
} from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { withRequestTrace } from "../src/core/agent-session/request-trace.ts";
import { decodeSessionRecords, encodeSessionLines } from "../src/core/session-manager/codec.ts";

/**
 * Every request of a session resends the whole conversation, so its trace has one layer per message so far. Holding each
 * trace as its own array makes the session hold the square of its request count in array slots; the traces of a live or
 * read-back session share their layers instead, so what they retain grows with the request count.
 */

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

const model = { api: "anthropic-messages" } as Model<"anthropic-messages">;

const answer = (step: number): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text: `answer ${step}` }],
	api: "anthropic-messages",
	provider: "test",
	model: "m",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: step,
});

/** The payload of each request of a session whose every turn adds a tool result and an answer; the newest is marked. */
function payloads(requests: number): Record<string, unknown>[] {
	const wire: Record<string, unknown>[] = [];
	const out: Record<string, unknown>[] = [];
	for (let step = 0; step < requests; step++) {
		wire.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${step}`, content: `out ${step}` }] });
		const last = wire.length - 1;
		const messages = wire.map((message, index) =>
			index === last
				? { ...message, content: [{ ...(message.content as object[])[0], cache_control: { type: "ephemeral" } }] }
				: message,
		);
		out.push({
			tools: [{ name: "bash", input_schema: { type: "object" } }],
			system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
			messages,
		});
		wire.push({ role: "assistant", content: [{ type: "tool_use", id: `t${step + 1}`, name: "bash", input: {} }] });
	}
	return out;
}

let sessions = 0;

/** The assistant messages of a session's requests, each traced by `withRequestTrace` as a provider stream reports it. */
async function liveSession(requests: Record<string, unknown>[]): Promise<AssistantMessage[]> {
	const sessionId = `memory-${sessions++}`;
	const messages: AssistantMessage[] = [];
	for (const [step, payload] of requests.entries()) {
		const stream = withRequestTrace<SimpleStreamOptions>({ sessionId }, (options) => {
			const source = createAssistantMessageEventStream();
			void (async () => {
				await options.onPayload?.(payload, model);
				source.push({ type: "done", reason: "stop", message: answer(step) });
			})();
			return source;
		});
		messages.push(await stream.result());
	}
	return messages;
}

const entries = (messages: AssistantMessage[]) =>
	messages.map((message, i) => ({ type: "message", id: `e${i}`, parentId: i ? `e${i - 1}` : null, message }));

/**
 * Collects garbage once nothing of the current job holds a weak reference's target. A second collection finishes what
 * the first left to sweep, which `heapUsed` would otherwise still count: the bytes an earlier build dropped.
 */
async function collect(): Promise<void> {
	for (let pass = 0; pass < 2; pass++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		gc();
	}
}

/** How many conversations `withRequestTrace` keeps (its `MEMO_CONVERSATIONS`), each with its last trace and memo. */
const KEPT_CONVERSATIONS = 8;

/**
 * Fills the bounded caches with small entries, so what a measured build leaves there (or an earlier one left) is not
 * counted: the conversations `withRequestTrace` keeps with one-request sessions, whose ids are new each time, and the
 * cache of rebuilt layer arrays with short ones. Otherwise an earlier session's chain, still kept by its conversation
 * when a measurement starts, is freed during it.
 */
let short: AssistantMessage[] | undefined;
async function flushCaches(): Promise<void> {
	for (let session = 0; session < KEPT_CONVERSATIONS; session++) await liveSession(payloads(1));
	short ??= await liveSession(payloads(40));
	for (const message of short) expect(message.requestTrace!.layers.length).toBeGreaterThan(0);
}

/** Heap bytes `build` leaves reachable from what it returns, after collecting garbage. */
async function retained(build: () => Promise<unknown>): Promise<number> {
	await flushCaches();
	await collect();
	const before = process.memoryUsage().heapUsed;
	const kept = await build();
	await flushCaches();
	await collect();
	const after = process.memoryUsage().heapUsed;
	expect(kept).toBeDefined();
	return after - before;
}

describe("request traces in memory", () => {
	it("describe each request as it was sent", async () => {
		const requests = payloads(40);
		const live = await liveSession(requests);
		const fresh = requests.map((payload) => JSON.stringify(describePayloadLayers("anthropic-messages", payload)));
		expect(live.map((message) => JSON.stringify(message.requestTrace))).toEqual(fresh);
		const loaded = decodeSessionRecords(encodeSessionLines(entries(live)).lines.map((line) => JSON.parse(line)));
		expect(loaded.map((entry) => JSON.stringify(entry.message.requestTrace))).toEqual(fresh);
	});

	it("do not keep a layer array per message", async () => {
		const live = await liveSession(payloads(60));
		const first = new WeakRef(live[0].requestTrace!.layers);
		for (const message of live) expect(message.requestTrace!.layers.length).toBeGreaterThan(0);
		await collect();
		expect(first.deref()).toBeUndefined();
		expect(live[0].requestTrace!.layers.length).toBe(3);
	});

	it("retain memory linear in the request count, live and read back", async () => {
		const small = payloads(500);
		const large = payloads(1000);
		const live = async (requests: Record<string, unknown>[]) => retained(() => liveSession(requests));
		const lines = async (requests: Record<string, unknown>[]) =>
			encodeSessionLines(entries(await liveSession(requests))).lines;
		const [smallLines, largeLines] = [await lines(small), await lines(large)];
		const loaded = async (stored: string[]) =>
			retained(async () => decodeSessionRecords(stored.map((line) => JSON.parse(line))));

		// Twice the requests: twice the memory when traces share their layers, four times when each holds an array.
		expect((await live(large)) / (await live(small))).toBeLessThan(2.6);
		expect((await loaded(largeLines)) / (await loaded(smallLines))).toBeLessThan(2.6);
	});
});
