import type {
	ApplicationFrame,
	ApplicationMessage,
	ApplicationSnapshot,
	ApplicationTool,
} from "@octocodeai/octocode-contracts";
import { afterEach, expect, it, vi } from "vitest";
import {
	ApplicationProjection,
	EventInterner,
	latestProgress,
	mergeEvents,
	settleToolStarts,
} from "../src/app/live/model.ts";
import { ApplicationStream } from "../src/application-stream.ts";

const frame = (sequence: number, body: Record<string, unknown>, sessionId = "s"): ApplicationFrame =>
	({ protocolVersion: 1, cursor: { sessionId, epoch: "e", sequence }, at: sequence, ...body }) as ApplicationFrame;
const event = (sequence: number, value: Record<string, unknown>) => frame(sequence, { type: "event", event: value });

/** 199 completed messages of `size` characters, 49 linked tool calls, and one assistant message still streaming. */
function transcript(size: number, sessionId = "s"): ApplicationSnapshot {
	const messages: ApplicationMessage[] = [];
	const tools: ApplicationTool[] = [];
	for (let i = 0; i < 200; i++) {
		const text = i === 199 ? "" : `${i} `.repeat(size / 4).padEnd(size, ".");
		const call = i >= 150 && i < 199 ? `t${i}` : undefined;
		messages.push({
			id: `m${i}`,
			role: i % 2 ? "assistant" : "user",
			text,
			complete: i !== 199,
			order: i * 2,
			timestamp: i,
			content: [
				{ id: `m${i}:0`, type: "text", text },
				...(call ? [{ id: `m${i}:1`, type: "toolCall" as const, toolCallId: call, name: "bash", arguments: {} }] : []),
			],
		});
		if (call) tools.push({ toolCallId: call, toolName: "bash", text: "ok", status: "completed", order: i * 2 + 1 });
	}
	return {
		sessionId,
		messages,
		tools,
		streaming: true,
		runId: "r",
		steering: [],
		followUp: [],
		receipts: [],
		capabilities: [],
	};
}

/** Snapshot, deltas, a tool update, a reconnect snapshot of the same content, a completion, then a session switch. */
function frames(): ApplicationFrame[] {
	const list = [frame(0, { type: "snapshot", snapshot: transcript(400) })];
	let length = 0;
	for (const word of ["Hel", "lo ", "world"]) {
		list.push(
			event(list.length, { type: "message.delta", messageId: "m199", delta: word, block: { index: 0, length } }),
		);
		length += word.length;
	}
	list.push(
		event(list.length, {
			type: "tool.progress",
			toolCallId: "t160",
			toolName: "bash",
			text: "partial",
			parentToolCallId: "t150",
		}),
	);
	const reconnect = transcript(400);
	reconnect.messages[199] = { ...reconnect.messages[199], text: "Hello world" };
	reconnect.messages[199].content = [{ id: "m199:0", type: "text", text: "Hello world" }];
	list.push(frame(list.length, { type: "snapshot", snapshot: reconnect }));
	list.push(
		event(list.length, { type: "message.delta", messageId: "m199", delta: "!", block: { index: 0, length: 11 } }),
	);
	list.push(
		event(list.length, {
			type: "message.completed",
			message: { ...reconnect.messages[199], text: "Hello world!", complete: true, content: undefined },
		}),
	);
	list.push(event(list.length, { type: "run.settled", runId: "r", aborted: false }));
	list.push(frame(0, { type: "snapshot", snapshot: transcript(40, "other") }, "other"));
	return list;
}

afterEach(() => vi.restoreAllMocks());

it("projects exactly what a projection rebuilding every row from fresh objects would", () => {
	const stream = new ApplicationStream();
	const incremental = new ApplicationProjection();
	const rebuilt = new ApplicationProjection();
	for (const [index, value] of frames().entries()) {
		expect([index, stream.accept(value)]).toEqual([index, "applied"]);
		const shared = incremental.update(stream.snapshot, stream.at);
		// A structured clone shares no object with earlier frames, so every row is rebuilt and compared.
		const fresh = rebuilt.update(structuredClone(stream.snapshot), stream.at);
		expect(shared).toEqual(fresh);
		expect(incremental.run).toEqual(rebuilt.run);
	}
});

it("keeps per-frame serialization proportional to the streamed message on a 2 MB transcript", () => {
	const stream = new ApplicationStream();
	const projection = new ApplicationProjection();
	const interner = new EventInterner();
	const publish = () => {
		const projected = projection.update(stream.snapshot, stream.at);
		const merged = mergeEvents({ sessionId: "s", agents: [], traffic: [], events: [], receipts: [] }, projected, "s");
		return interner.intern(latestProgress(settleToolStarts(merged.events)));
	};
	stream.accept(frame(0, { type: "snapshot", snapshot: transcript(5_000) }));
	expect(JSON.stringify(stream.snapshot).length).toBeGreaterThan(2_000_000);
	const before = publish();
	const stringify = JSON.stringify;
	let serialized = 0;
	vi.spyOn(JSON, "stringify").mockImplementation((...args: Parameters<typeof JSON.stringify>) => {
		const text = stringify(...args);
		serialized += text?.length ?? 0;
		return text;
	});
	expect(
		stream.accept(
			event(1, { type: "message.delta", messageId: "m199", delta: "token", block: { index: 0, length: 0 } }),
		),
	).toBe("applied");
	const after = publish();
	// Only the streaming row is rebuilt; every other row keeps its object, so memoized cards skip rendering.
	expect(after.filter((row, index) => row !== before[index]).map((row) => row.text)).toEqual(["token"]);
	expect(serialized).toBeLessThan(10_000);
});

it("keeps one visible root when tool parents form a cycle, so the group never vanishes", () => {
	const tool = (toolCallId: string, parentToolCallId?: string, order = 0): ApplicationTool => ({
		toolCallId,
		toolName: "bash",
		text: "ok",
		status: "completed",
		order,
		...(parentToolCallId ? { parentToolCallId } : {}),
	});
	const snapshot = {
		sessionId: "s",
		messages: [],
		// `a` and `b` are each other's parent, `s` is its own, `c` hangs off the cycle, and `k` under the ordinary root `r`.
		tools: [
			tool("b", "a", 1),
			tool("a", "b", 2),
			tool("s", "s", 3),
			tool("c", "a", 4),
			tool("r", undefined, 5),
			tool("k", "r", 6),
		],
	} as unknown as ApplicationSnapshot;
	const events = new ApplicationProjection().update(snapshot, 1);
	const roots = events.filter((item) => item.tool && !item.embedded).map((item) => item.tool!.toolCallId);
	const nested = events.filter((item) => item.tool && item.embedded).map((item) => item.tool!.toolCallId);
	expect(roots.sort()).toEqual(["a", "r", "s"]);
	expect(nested.sort()).toEqual(["b", "c", "k"]);
});
