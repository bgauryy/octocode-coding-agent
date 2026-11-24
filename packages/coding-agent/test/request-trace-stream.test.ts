import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type SimpleStreamOptions,
} from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { withRequestTrace } from "../src/core/agent-session/request-trace.ts";

const message = (): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text: "ok" }],
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
	timestamp: Date.now(),
});

describe("withRequestTrace", () => {
	it("resolves the result of a provider stream that ends with end(result) and no done event", async () => {
		const final = message();
		const stream = withRequestTrace({}, () => {
			const source = createAssistantMessageEventStream();
			queueMicrotask(() => source.end(final));
			return source;
		});
		await expect(stream.result()).resolves.toBe(final);
	});

	it("keeps runtime throughput when it stamps the described payload layers", async () => {
		const final = message();
		final.requestTrace = {
			layers: [],
			throughput: {
				model: "m",
				priority: "foreground",
				gateWaitMs: 3,
				estimatedInputTokens: 10,
				estimatedAdmissionTokens: 20,
				actualTokens: 2,
			},
		};
		const stream = withRequestTrace(
			{ sessionId: "throughput-merge", onPayload: undefined as SimpleStreamOptions["onPayload"] },
			(options) => {
				const source = createAssistantMessageEventStream();
				queueMicrotask(async () => {
					await options.onPayload?.({ messages: [{ role: "user", content: "hello" }] }, {
						api: "anthropic-messages",
					} as never);
					source.push({ type: "done", reason: "stop", message: final });
					source.end(final);
				});
				return source;
			},
		);
		await expect(stream.result()).resolves.toBe(final);
		expect(final.requestTrace?.layers).toHaveLength(1);
		expect(final.requestTrace?.throughput).toMatchObject({ gateWaitMs: 3, actualTokens: 2 });
	});

	it("passes a done event through with its result", async () => {
		const final = message();
		const stream = withRequestTrace({}, () => {
			const source = createAssistantMessageEventStream();
			queueMicrotask(() => source.push({ type: "done", reason: "stop", message: final }));
			return source;
		});
		const events = [];
		for await (const event of stream) events.push(event.type);
		expect(events).toEqual(["done"]);
		await expect(stream.result()).resolves.toBe(final);
	});
});
