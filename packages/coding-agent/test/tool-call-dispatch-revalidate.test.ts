import { describe, expect, it } from "vitest";
import { dispatchToolCall } from "../src/core/features/runner/emit-events.ts";
import { SessionBus } from "../src/core/features/bus/session-bus.ts";
import type { RunnerHost } from "../src/core/features/runner/types.ts";
import type { ToolCallEvent, ToolCallEventResult } from "../src/core/features/types.ts";

type Handler = (event: ToolCallEvent) => Promise<ToolCallEventResult | undefined>;

/** One feature per handler, in load order, as the session bus reads them. */
function host(...handlers: Handler[]): RunnerHost {
	const features = handlers.map((handler) => ({ handlers: new Map([["tool_call", [handler]]]) }));
	return {
		extensions: features,
		bus: new SessionBus(features as never),
		createContext: () => ({}),
		assertActive: () => undefined,
	} as unknown as RunnerHost;
}

const event: ToolCallEvent = { type: "tool_call", toolCallId: "t1", toolName: "bash", input: { command: "echo" } };

describe("tool_call dispatch keeps execute-time checks", () => {
	it("keeps an earlier handler's check when a later handler returns its own result", async () => {
		const result = await dispatchToolCall(
			host(
				async () => ({ revalidate: async () => ({ block: true, reason: "reserved by a peer" }) }),
				async () => ({ reason: "later handler" }),
			),
			event,
		);
		expect(result?.block).toBeUndefined();
		expect(result?.reason).toBe("later handler");
		expect(await result?.revalidate?.()).toEqual({ block: true, reason: "reserved by a peer" });
	});

	it("runs every check in order and stops at the first refusal", async () => {
		const ran: string[] = [];
		const result = await dispatchToolCall(
			host(
				async () => ({
					revalidate: async () => {
						ran.push("first");
						return undefined;
					},
				}),
				async () => ({
					revalidate: async () => {
						ran.push("second");
						return { block: true, reason: "stale" };
					},
				}),
				async () => ({
					revalidate: async () => {
						ran.push("third");
						return undefined;
					},
				}),
			),
			event,
		);
		expect(await result?.revalidate?.()).toEqual({ block: true, reason: "stale" });
		expect(ran).toEqual(["first", "second"]);
	});

	it("returns a block at once, without later handlers", async () => {
		let later = false;
		const result = await dispatchToolCall(
			host(
				async () => ({ block: true, reason: "denied" }),
				async () => {
					later = true;
					return undefined;
				},
			),
			event,
		);
		expect(result).toEqual({ block: true, reason: "denied" });
		expect(later).toBe(false);
	});

	it("returns no result when no handler returns one", async () => {
		expect(
			await dispatchToolCall(
				host(async () => undefined),
				event,
			),
		).toBeUndefined();
	});
});
