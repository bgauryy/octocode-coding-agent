import { type AssistantMessage, createAssistantMessageEventStream } from "@octocodeai/octocode-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent, type AgentEvent, type StreamFn } from "../src/index.ts";

function assistant(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

/** Streams one text delta, then ends as aborted once the request's signal aborts, or with `text` when `finish` is set. */
function streamingUntilAbort(options: { finish?: boolean } = {}): StreamFn {
	return (_model, _context, streamOptions) => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const partial = assistant("");
			stream.push({ type: "start", partial });
			const withText = assistant("hi");
			stream.push({ type: "text_delta", contentIndex: 0, delta: "hi", partial: withText });
			if (options.finish) {
				stream.push({ type: "done", reason: "stop", message: withText });
				return;
			}
			const signal = streamOptions?.signal;
			const end = () => stream.push({ type: "error", reason: "aborted", error: assistant("hi", "aborted") });
			if (signal?.aborted) end();
			else signal?.addEventListener("abort", end, { once: true });
		});
		return stream;
	};
}

/** Settles with whether `promise` settled within `ms`: a hung run must fail the test, not time it out. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), ms);
	});
	try {
		return await Promise.race([promise.then(() => true), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

const never = new Promise<void>(() => {});

describe("Agent listeners and abort", () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	beforeEach(() => {
		unhandled.length = 0;
		process.on("unhandledRejection", onUnhandled);
	});
	afterEach(() => {
		process.off("unhandledRejection", onUnhandled);
	});

	it("settles an aborted run whose listener never resolves a streaming delta and ignores the signal", async () => {
		const agent = new Agent({ streamFn: streamingUntilAbort() });
		const types: AgentEvent["type"][] = [];
		let entered!: () => void;
		const inUpdate = new Promise<void>((resolve) => {
			entered = resolve;
		});
		agent.subscribe((event) => {
			if (event.type !== "message_update") return;
			entered();
			return never;
		});
		agent.subscribe((event) => {
			types.push(event.type);
		});

		const run = agent.prompt("hello");
		await inUpdate;
		agent.abort();

		expect(await settlesWithin(run, 1_000)).toBe(true);
		expect(agent.state.isStreaming).toBe(false);
		expect(types.slice(-3)).toEqual(["message_end", "turn_end", "agent_end"]);
		const last = agent.state.messages.at(-1);
		expect(last?.role === "assistant" && last.stopReason).toBe("aborted");
		await settlesWithin(agent.waitForIdle(), 1_000);
		expect(unhandled).toEqual([]);
	});

	it("keeps awaiting every listener in subscription order, one event at a time", async () => {
		const agent = new Agent({ streamFn: streamingUntilAbort({ finish: true }) });
		const log: string[] = [];
		for (const name of ["a", "b"]) {
			agent.subscribe(async (event) => {
				log.push(`${name}:${event.type}:start`);
				await new Promise((resolve) => setTimeout(resolve, name === "a" ? 2 : 0));
				log.push(`${name}:${event.type}:end`);
			});
		}

		await agent.prompt("hello");

		const types = ["agent_start", "turn_start", "message_start", "message_end"];
		types.push("message_start", "message_update", "message_end", "turn_end", "agent_end");
		expect(log).toEqual(types.flatMap((type) => ["a", "b"].flatMap((n) => [`${n}:${type}:start`, `${n}:${type}:end`])));
	});

	it("still waits for a slow listener of a final event after the abort", async () => {
		const agent = new Agent({ streamFn: streamingUntilAbort() });
		let committed = false;
		agent.subscribe(async (event, signal) => {
			if (event.type === "message_update") {
				agent.abort();
				return;
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				expect(signal.aborted).toBe(true);
				await new Promise((resolve) => setTimeout(resolve, 20));
				committed = true;
			}
		});

		await agent.prompt("hello");

		expect(committed).toBe(true);
	});

	it("fails the run when a delta listener rejects before the agent stops waiting, as before", async () => {
		const live = new Agent({ streamFn: streamingUntilAbort({ finish: true }) });
		live.subscribe(async (event) => {
			if (event.type === "message_update") throw new Error("listener failed");
		});
		await live.prompt("hello");
		expect(live.state.errorMessage).toBe("listener failed");

		const aborting = new Agent({ streamFn: streamingUntilAbort() });
		aborting.subscribe(async (event) => {
			if (event.type !== "message_update") return;
			aborting.abort();
			throw new Error("failed while aborting");
		});
		await aborting.prompt("hello");
		expect(aborting.state.errorMessage).toBe("failed while aborting");
	});

	it("lets no listener abandoned by an aborted run change the next run", async () => {
		let runs = 0;
		const finishing = streamingUntilAbort({ finish: true });
		const aborting = streamingUntilAbort();
		const agent = new Agent({ streamFn: (...args) => (++runs === 1 ? aborting : finishing)(...args) });
		let release!: () => void;
		const gate = new Promise<void>((_resolve, reject) => {
			release = () => reject(new Error("late failure"));
		});
		let staleSignal: AbortSignal | undefined;
		const types: AgentEvent["type"][] = [];
		let second = false;
		agent.subscribe((event, signal) => {
			if (!second && event.type === "message_update") {
				staleSignal = signal;
				queueMicrotask(() => agent.abort());
				return gate;
			}
		});
		agent.subscribe((event) => {
			if (second) types.push(event.type);
		});

		expect(await settlesWithin(agent.prompt("first"), 1_000)).toBe(true);

		let secondSignal: AbortSignal | undefined;
		agent.subscribe(async (event, signal) => {
			if (event.type !== "message_update" || !second) return;
			secondSignal = signal;
			release();
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
		second = true;
		await agent.prompt("second");
		expect(runs).toBe(2);

		expect(staleSignal?.aborted).toBe(true);
		expect(secondSignal).toBeDefined();
		expect(secondSignal).not.toBe(staleSignal);
		expect(secondSignal?.aborted).toBe(false);
		expect(agent.state.errorMessage).toBeUndefined();
		expect(agent.state.isStreaming).toBe(false);
		expect(types).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_update",
			"message_end",
			"turn_end",
			"agent_end",
		]);
		const last = agent.state.messages.at(-1);
		expect(last?.role === "assistant" && last.stopReason).toBe("stop");
		expect(unhandled).toEqual([]);
	});
});
