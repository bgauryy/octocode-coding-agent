import type { ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { expect, it } from "vitest";
import { ApplicationStream } from "@octocodeai/octocode-projections";
import { requestHistory, retainEvicted } from "../src/app/live/history-window.ts";

const snapshot: ApplicationSnapshot = {
	sessionId: "session-a",
	messages: [],
	streaming: false,
	steering: [],
	followUp: [],
	receipts: [],
	capabilities: ["prompt", "abort"],
};

/** A stream fed `count` tool calls, each a tool row (even order) and its result message (odd order). */
function feed(stream: ApplicationStream, from: number, count: number, sequence: { next: number }) {
	const send = (event: Record<string, unknown>) =>
		stream.accept({
			protocolVersion: 1,
			cursor: { sessionId: "session-a", epoch: "epoch-a", sequence: sequence.next },
			at: sequence.next++,
			type: "event",
			event,
		});
	for (let i = from; i < from + count; i++) {
		const tool = { toolCallId: `t${i}`, toolName: "read", order: 2 * i };
		expect(send({ type: "tool.started", ...tool })).toBe("applied");
		expect(send({ type: "tool.completed", ...tool, text: `read ${i}` })).toBe("applied");
		const message = { id: `m${i}`, role: "toolResult", text: `read ${i}`, complete: true, toolCallId: `t${i}` };
		expect(send({ type: "message.completed", message: { ...message, order: 2 * i + 1 } })).toBe("applied");
	}
}

function start(tools?: ApplicationSnapshot["tools"]) {
	const stream = new ApplicationStream();
	stream.accept({
		protocolVersion: 1,
		cursor: { sessionId: "session-a", epoch: "epoch-a", sequence: 0 },
		at: 0,
		type: "snapshot",
		snapshot: tools ? { ...snapshot, tools } : snapshot,
	});
	return { stream, sequence: { next: 1 } };
}

/** Tool calls in `ids` at or after `first` that `shown` lacks: a history page before `first` returns only older ones. */
const unreachable = (count: number, first: number, shown: Set<string>) =>
	Array.from({ length: count }, (_, i) => `t${i}`).filter((id, i) => 2 * i >= first && !shown.has(id));

it("keeps every tool at or after the first live message", () => {
	const { stream, sequence } = start();
	feed(stream, 0, 80, sequence);
	const live = stream.snapshot!;
	expect(live.messages).toHaveLength(80);
	const shown = new Set(live.tools?.map((tool) => tool.toolCallId));
	expect(unreachable(80, live.messages[0].order!, shown)).toEqual([]);
});

it("stays bounded, and every tool it drops moves into the loaded history with its message", () => {
	const { stream, sequence } = start();
	feed(stream, 0, 150, sequence);
	let history = requestHistory(undefined, stream.snapshot!.messages[0]?.id);
	const previous = stream.snapshot!;
	feed(stream, 150, 150, sequence);
	const live = stream.snapshot!;
	history = retainEvicted({ ...history, limit: 1000 }, previous, live);

	expect(live.messages.length).toBeLessThanOrEqual(200);
	expect(live.tools?.length).toBeLessThanOrEqual(200);
	const first = live.messages[0].order!;
	const calls = new Set(live.messages.map((message) => message.toolCallId));
	expect(live.tools?.filter((tool) => tool.order! < first && !calls.has(tool.toolCallId))).toEqual([]);
	// What the live window dropped since the history was opened is in the history, or still live.
	const shown = new Set([...(live.tools ?? []), ...history.tools].map((tool) => tool.toolCallId));
	expect(unreachable(300, previous.messages[0].order!, shown)).toEqual([]);
});

it("keeps a tool without an order live or in the loaded history once the cap is passed", () => {
	// An older host's snapshot: its tools carry no order, so no history page could return them later.
	const legacy = ["u0", "u1", "u2"].map((id) => ({
		toolCallId: id,
		toolName: "read",
		text: `legacy ${id}`,
		status: "completed" as const,
	}));
	const { stream, sequence } = start(legacy);
	let history = requestHistory(undefined, undefined);
	const previous = stream.snapshot!;
	feed(stream, 0, 250, sequence);
	const live = stream.snapshot!;
	history = retainEvicted({ ...history, limit: 1000 }, previous, live);

	expect(live.tools?.filter((tool) => tool.order !== undefined).length).toBeLessThanOrEqual(200);
	const shown = new Set([...(live.tools ?? []), ...history.tools].map((tool) => tool.toolCallId));
	expect(legacy.map((tool) => tool.toolCallId).filter((id) => !shown.has(id))).toEqual([]);
	const first = live.messages[0].order!;
	expect(unreachable(250, first, new Set(live.tools?.map((tool) => tool.toolCallId)))).toEqual([]);
});
