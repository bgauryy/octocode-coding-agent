import { describe, expect, it } from "vitest";
import { registerStallRecorder, STALL_ENTRY, STALL_MS } from "../../src/octocode/profiler/stalls.ts";
import { asSetup } from "./fake-host.ts";

function recorder() {
	const handlers = new Map<string, (event: unknown) => Promise<void>>();
	const entries: Array<{ type: string; data: Record<string, unknown> }> = [];
	registerStallRecorder(
		asSetup({
			on: (name: string, handler: (event: unknown) => Promise<void>) => void handlers.set(name, handler),
			appendEntry: (type: string, data: Record<string, unknown>) => void entries.push({ type, data }),
		}) as never,
	);
	const emit = (name: string, event: unknown = {}) => handlers.get(name)!(event);
	return { emit, entries };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function block(ms: number): void {
	const end = performance.now() + ms;
	while (performance.now() < end) {
		// Synchronous work: the event loop cannot run timers.
	}
}

describe("event-loop stall recorder", () => {
	it("records a blocked window after the run ends, naming the phase that closed it", async () => {
		const { emit, entries } = recorder();
		await emit("agent_start");
		await pause(60);
		block(STALL_MS + 150);
		await pause(60);
		await emit("tool_execution_end", { toolName: "bash" });
		expect(entries).toEqual([]);
		await pause(60);
		await emit("message_end", { message: { role: "assistant" } });
		await emit("agent_end");
		// Written after the run's end handling, not inside it.
		expect(entries).toEqual([]);
		await new Promise((resolve) => setImmediate(resolve));
		expect(entries).toHaveLength(1);
		expect(entries[0].type).toBe(STALL_ENTRY);
		expect(entries[0].data).toMatchObject({ version: 1, during: "tool bash" });
		expect(entries[0].data.maxMs).toBeGreaterThanOrEqual(STALL_MS);
		expect(entries[0].data.at as number).toBeGreaterThanOrEqual(entries[0].data.from as number);
	});

	it("records nothing for a run without a long delay, nor for nested tool calls", async () => {
		const { emit, entries } = recorder();
		await emit("agent_start");
		await pause(80);
		await emit("tool_execution_end", { toolName: "read", parentToolCallId: "outer" });
		await emit("message_end", { message: { role: "assistant" } });
		await emit("agent_end");
		await new Promise((resolve) => setImmediate(resolve));
		expect(entries).toEqual([]);
	});

	it("records a block during a compaction that runs after the run ended, then stops watching", async () => {
		const { emit, entries } = recorder();
		await emit("agent_start");
		await pause(40);
		await emit("message_end", { message: { role: "assistant" } });
		await emit("agent_end");
		// The threshold compaction after the run: outside the run's window.
		await emit("session_before_compact");
		await pause(60);
		block(STALL_MS + 150);
		await pause(60);
		await emit("session_compact");
		expect(entries).toEqual([]);
		await new Promise((resolve) => setImmediate(resolve));
		expect(entries).toHaveLength(1);
		expect(entries[0].data).toMatchObject({ during: "compaction" });
		// Watching ended with the compaction: a later block between runs is not recorded.
		block(STALL_MS + 50);
		await emit("agent_start");
		await emit("agent_end");
		await new Promise((resolve) => setImmediate(resolve));
		expect(entries).toHaveLength(1);
	});
});
