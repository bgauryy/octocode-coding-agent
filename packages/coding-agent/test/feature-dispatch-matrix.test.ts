/**
 * Dispatch rules of the session events that no other test pins: who sees a live compaction event, when `user_input`
 * stops, which cache-warming answer wins, what `message_end` refuses, and how `tool_call_discarded` contains failures.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { FeatureHost } from "../src/core/features/runner.ts";
import type {
	SessionActions,
	ContextActions,
	FeatureRegister,
	SessionBeforeCompactEvent,
} from "../src/core/features/types.ts";
import type { FeatureOwner } from "../src/core/source-info.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createFeatureRuntime, loadFeatureFromFactory } from "./helpers/features.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

let cwd: string;
beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-dispatch-matrix-"));
});
afterEach(() => {
	fs.rmSync(cwd, { recursive: true, force: true });
});

/** A runner over `features`, registered in order, whose context reports `signal`; errors are collected. */
async function compose(
	features: Array<{ owner: FeatureOwner; register: FeatureRegister }>,
	signal?: AbortSignal,
): Promise<{ runner: FeatureHost; errors: Array<{ event: string; error: string }> }> {
	const runtime = createFeatureRuntime();
	const eventBus = createEventBus();
	const records = [];
	for (const [index, feature] of features.entries()) {
		records.push(await loadFeatureFromFactory(feature.register, cwd, eventBus, runtime, `<f${index}>`, feature.owner));
	}
	const runner = new FeatureHost(
		records,
		runtime,
		cwd,
		SessionManager.inMemory(),
		await createInMemoryModelRegistry(AuthStorage.inMemory()),
	);
	runner.bindCore({} as SessionActions, { getSignal: () => signal } as ContextActions);
	const errors: Array<{ event: string; error: string }> = [];
	runner.onError((error) => errors.push({ event: error.event, error: error.error }));
	return { runner, errors };
}

const compactEvent = (): SessionBeforeCompactEvent =>
	({
		type: "session_before_compact",
		preparation: { tokensBefore: 10, firstKeptEntryId: "a" },
		branchEntries: [{ id: "a" }],
		customInstructions: undefined,
		signal: new AbortController().signal,
	}) as unknown as SessionBeforeCompactEvent;

describe("session_before_compact", () => {
	it("hands a non-native handler a copy and ignores its result; the native handler gets the live event", async () => {
		const event = compactEvent();
		let nativeSaw: unknown;
		const { runner } = await compose([
			{
				owner: "builtin",
				register: (api) =>
					void api.bus.on("session_before_compact", (seen) => {
						(seen.preparation as { tokensBefore: number }).tokensBefore = 99;
						(seen.branchEntries as unknown[]).push({ id: "b" });
						return { cancel: true };
					}),
			},
			{
				owner: "native",
				register: (api) =>
					void api.bus.on("session_before_compact", (seen) => {
						nativeSaw = seen;
						return undefined;
					}),
			},
		]);
		const result = await runner.emit(event);
		expect(result).toBeUndefined();
		expect(nativeSaw).toBe(event);
		expect((event.preparation as { tokensBefore: number }).tokensBefore).toBe(10);
		expect(event.branchEntries).toHaveLength(1);
	});

	it("returns the native handler's cancel at once", async () => {
		const order: string[] = [];
		const { runner } = await compose([
			{
				owner: "native",
				register: (api) => {
					api.bus.on("session_before_compact", () => {
						order.push("first");
						return { cancel: true };
					});
					api.bus.on("session_before_compact", () => {
						order.push("second");
					});
				},
			},
		]);
		expect(await runner.emit(compactEvent())).toEqual({ cancel: true });
		expect(order).toEqual(["first"]);
	});
});

describe("user_input", () => {
	it("joins every handler's context and blocks when any handler blocks", async () => {
		const { runner } = await compose([
			{
				owner: "builtin",
				register: (api) => void api.bus.on("user_input", () => ({ additionalContext: ["one"] })),
			},
			{
				owner: "native",
				register: (api) => {
					api.bus.on("user_input", () => ({ block: true, additionalContext: ["two"] }));
					api.bus.on("user_input", () => ({ additionalContext: ["three"] }));
				},
			},
		]);
		const result = await runner.emitUserInput({ type: "user_input", text: "hi" } as never);
		expect(result).toEqual({ block: true, additionalContext: ["one", "two", "three"] });
	});

	it("stops before the next handler once the run's signal is aborted, keeping what was collected", async () => {
		const controller = new AbortController();
		const ran: string[] = [];
		const { runner } = await compose(
			[
				{
					owner: "native",
					register: (api) => {
						api.bus.on("user_input", () => {
							ran.push("first");
							controller.abort();
							return { additionalContext: ["kept"] };
						});
						api.bus.on("user_input", () => {
							ran.push("second");
						});
					},
				},
			],
			controller.signal,
		);
		const result = await runner.emitUserInput({ type: "user_input", text: "hi" } as never);
		expect(ran).toEqual(["first"]);
		expect(result).toEqual({ additionalContext: ["kept"] });
	});

	it("reports a throwing handler and runs the next", async () => {
		const { runner, errors } = await compose([
			{
				owner: "native",
				register: (api) => {
					api.bus.on("user_input", () => {
						throw new Error("boom");
					});
					api.bus.on("user_input", () => ({ additionalContext: ["after"] }));
				},
			},
		]);
		const result = await runner.emitUserInput({ type: "user_input", text: "hi" } as never);
		expect(result.additionalContext).toEqual(["after"]);
		expect(errors).toEqual([{ event: "user_input", error: "boom" }]);
	});
});

describe("cache_warming_decision", () => {
	it("keeps the event's action when no handler answers, else the last answer wins", async () => {
		const event = { type: "cache_warming_decision", action: "warm" } as never;
		const quiet = await compose([
			{ owner: "native", register: (api) => void api.bus.on("cache_warming_decision", () => {}) },
		]);
		expect(await quiet.runner.emitCacheWarmingDecision(event)).toBe("warm");

		const { runner, errors } = await compose([
			{
				owner: "builtin",
				register: (api) => void api.bus.on("cache_warming_decision", () => ({ action: "skip" }) as never),
			},
			{
				owner: "native",
				register: (api) => {
					api.bus.on("cache_warming_decision", () => ({ action: "stop" }) as never);
					api.bus.on("cache_warming_decision", () => {
						throw new Error("late");
					});
				},
			},
		]);
		expect(await runner.emitCacheWarmingDecision(event)).toBe("stop");
		expect(errors).toEqual([{ event: "cache_warming_decision", error: "late" }]);
	});
});

describe("message_end", () => {
	const user = (text: string) => ({ role: "user", content: text, timestamp: 1 }) as AgentMessage;

	it("chains replacements, refuses one with another role and reports it", async () => {
		const seen: string[] = [];
		const { runner, errors } = await compose([
			{
				owner: "native",
				register: (api) => {
					api.bus.on("message_end", () => ({ message: user("edited") }));
					api.bus.on("message_end", () => ({ message: { role: "assistant", content: [] } as unknown as AgentMessage }));
					api.bus.on("message_end", (event) => {
						seen.push((event.message as { content: string }).content);
					});
				},
			},
		]);
		const result = await runner.emitMessageEnd({ type: "message_end", message: user("original") });
		expect(result).toEqual(user("edited"));
		expect(seen).toEqual(["edited"]);
		expect(errors).toEqual([
			{ event: "message_end", error: "message_end handlers must return a message with the same role" },
		]);
	});

	it("returns undefined when no handler replaces the message", async () => {
		const { runner } = await compose([
			{ owner: "native", register: (api) => void api.bus.on("message_end", () => {}) },
		]);
		expect(await runner.emitMessageEnd({ type: "message_end", message: user("same") })).toBeUndefined();
	});
});

describe("tool_call_discarded", () => {
	it("runs every handler synchronously, in order, and swallows a failure", async () => {
		const ran: string[] = [];
		const { runner, errors } = await compose([
			{
				owner: "builtin",
				register: (api) =>
					void api.bus.on("tool_call_discarded", (event) => {
						ran.push(`builtin:${event.toolCallId}`);
						throw new Error("cleanup failed");
					}),
			},
			{
				owner: "native",
				register: (api) =>
					void api.bus.on("tool_call_discarded", (event) => {
						ran.push(`native:${event.toolCallId}`);
					}),
			},
		]);
		runner.toolCallDiscarded("t1");
		expect(ran).toEqual(["builtin:t1", "native:t1"]);
		expect(errors).toEqual([]);
	});
});

describe("handler order", () => {
	it("runs buckets in feature order, so an earlier feature's late subscription still runs before later features", async () => {
		const ran: string[] = [];
		let late: (() => void) | undefined;
		const { runner } = await compose([
			{
				owner: "builtin",
				register: (api) => {
					late = () => api.bus.on("agent_start", () => void ran.push("first-late"));
					api.bus.on("agent_start", () => void ran.push("first"));
				},
			},
			{ owner: "native", register: (api) => void api.bus.on("agent_start", () => void ran.push("second")) },
		]);
		late?.();
		await runner.emit({ type: "agent_start" } as never);
		expect(ran).toEqual(["first", "first-late", "second"]);
	});
});
