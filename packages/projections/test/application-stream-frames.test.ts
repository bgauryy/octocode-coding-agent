import type { ApplicationFrame, ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { describe, expect, it } from "vitest";
import { ApplicationStream } from "../src/application-stream.ts";

const base: ApplicationSnapshot = {
	sessionId: "s",
	messages: [{ id: "m1", role: "assistant", text: "Hello", complete: false }],
	streaming: false,
	steering: [],
	followUp: [],
	receipts: [],
	capabilities: ["prompt"],
};
function frame(sequence: number, body: Record<string, unknown>, epoch = "e", sessionId = "s"): ApplicationFrame {
	return { protocolVersion: 1, cursor: { sessionId, epoch, sequence }, at: sequence * 10, ...body } as ApplicationFrame;
}
function event(sequence: number, value: Record<string, unknown>): ApplicationFrame {
	return frame(sequence, { type: "event", event: value });
}
function started(snapshot: ApplicationSnapshot = base): ApplicationStream {
	const stream = new ApplicationStream();
	expect(stream.accept(frame(0, { type: "snapshot", snapshot }))).toBe("applied");
	return stream;
}

describe("ApplicationStream frame handling", () => {
	it("rejects a snapshot whose session differs from its cursor and leaves state untouched", () => {
		const stream = new ApplicationStream();
		expect(stream.accept(frame(0, { type: "snapshot", snapshot: { ...base, sessionId: "other" } }))).toBe("invalid");
		expect(stream.snapshot).toBeUndefined();
		expect(stream.cursor).toBeUndefined();
	});

	it("an event before any snapshot asks for a resync", () => {
		expect(new ApplicationStream().accept(event(1, { type: "run.started", runId: "r" }))).toBe("resync");
	});

	it("a resync frame clears the cursor but keeps the last snapshot visible", () => {
		const stream = started();
		expect(stream.accept(frame(1, { type: "resync", reason: "overflow" }))).toBe("resync");
		expect(stream.cursor).toBeUndefined();
		expect(stream.snapshot?.messages[0].text).toBe("Hello");
	});

	it("resumed at the current sequence is ignored; resumed elsewhere forces a resync", () => {
		const stream = started();
		expect(stream.accept(frame(0, { type: "resumed" }))).toBe("ignored");
		expect(stream.cursor?.sequence).toBe(0);
		expect(stream.accept(frame(3, { type: "resumed" }))).toBe("resync");
		expect(stream.cursor).toBeUndefined();
	});

	it("records the frame time and cursor of each applied event", () => {
		const stream = started();
		stream.accept(event(1, { type: "run.started", runId: "r" }));
		expect(stream.at).toBe(10);
		expect(stream.cursor).toEqual({ sessionId: "s", epoch: "e", sequence: 1 });
	});

	it("does not alias the frame's message and receipt arrays", () => {
		const snapshot = { ...base, messages: [...base.messages], receipts: [] as ApplicationSnapshot["receipts"] };
		const stream = started(snapshot);
		snapshot.messages.push({ id: "late", role: "user", text: "x", complete: true });
		snapshot.receipts.push({ id: "late", status: "accepted" });
		expect(stream.snapshot?.messages.map((message) => message.id)).toEqual(["m1"]);
		expect(stream.snapshot?.receipts).toEqual([]);
	});
});

describe("ApplicationStream event reducers", () => {
	it("a delta for an unknown message forces a resync without applying it", () => {
		const stream = started();
		expect(stream.accept(event(1, { type: "message.delta", messageId: "missing", delta: "x" }))).toBe("resync");
		expect(stream.snapshot?.messages).toEqual(base.messages);
	});

	it("a delta carrying full text replaces the message text instead of appending", () => {
		const stream = started();
		stream.accept(event(1, { type: "message.delta", messageId: "m1", delta: " world" }));
		expect(stream.snapshot?.messages[0].text).toBe("Hello world");
		stream.accept(event(2, { type: "message.delta", messageId: "m1", delta: "ignored", text: "Replaced" }));
		expect(stream.snapshot?.messages[0].text).toBe("Replaced");
	});

	it("authoritative replacement clears an old full-content asset and omitted rich content", () => {
		const full = { id: "old", mimeType: "application/json", size: 1 };
		const content = [{ id: "b", type: "text" as const, text: "Old" }];
		const stream = started({ ...base, messages: [{ ...base.messages[0], content, full }] });
		stream.accept(event(1, { type: "message.delta", messageId: "m1", delta: "", text: "New", content }));
		expect(stream.snapshot?.messages[0].full).toBeUndefined();
		expect(stream.snapshot?.messages[0].content).toEqual(content);
		stream.accept(event(2, { type: "message.delta", messageId: "m1", delta: "", text: "Plain" }));
		expect(stream.snapshot?.messages[0]).toMatchObject({ text: "Plain" });
		expect(stream.snapshot?.messages[0].content).toBeUndefined();
	});

	it("text-only appends preserve existing content and its asset", () => {
		const full = { id: "old", mimeType: "application/json", size: 1 };
		const content = [{ id: "b", type: "text" as const, text: "Old" }];
		const stream = started({ ...base, messages: [{ ...base.messages[0], content, full }] });
		stream.accept(event(1, { type: "message.delta", messageId: "m1", delta: " world" }));
		expect(stream.snapshot?.messages[0]).toMatchObject({ text: "Hello world", content, full });
	});

	it("run.started marks streaming with the run id and run.settled clears both", () => {
		const stream = started();
		stream.accept(event(1, { type: "run.started", runId: "r1" }));
		expect(stream.snapshot).toMatchObject({ streaming: true, runId: "r1" });
		stream.accept(event(2, { type: "run.settled", runId: "r1", aborted: false }));
		expect(stream.snapshot?.streaming).toBe(false);
		expect(stream.snapshot?.runId).toBeUndefined();
	});

	it("queue.changed replaces the steering and follow-up queues", () => {
		const stream = started({ ...base, steering: ["old"], followUp: ["old"] });
		stream.accept(event(1, { type: "queue.changed", steering: ["s1", "s2"], followUp: [] }));
		expect(stream.snapshot).toMatchObject({ steering: ["s1", "s2"], followUp: [] });
	});

	it("tool.completed with failed records a failed tool and keeps previous text when none is sent", () => {
		const stream = started();
		stream.accept(event(1, { type: "tool.started", toolCallId: "t", toolName: "bash" }));
		stream.accept(event(2, { type: "tool.progress", toolCallId: "t", toolName: "bash", text: "partial" }));
		stream.accept(event(3, { type: "tool.completed", toolCallId: "t", toolName: "bash", failed: true }));
		expect(stream.snapshot?.tools).toEqual([
			{ toolCallId: "t", order: 0, toolName: "bash", text: "partial", status: "failed" },
		]);
	});

	it("infers a new tool's order after the highest ordered message", () => {
		const stream = started({ ...base, messages: [{ ...base.messages[0], order: 4 }] });
		stream.accept(event(1, { type: "tool.started", toolCallId: "t", toolName: "read" }));
		expect(stream.snapshot?.tools?.[0].order).toBe(5);
	});

	it("caps retained messages at 200, tools at 200 and receipts at 100, keeping the newest", () => {
		const stream = started({ ...base, messages: [] });
		let sequence = 0;
		for (let index = 0; index < 205; index++)
			stream.accept(
				event(++sequence, {
					type: "message.started",
					message: { id: `m${index}`, role: "assistant", text: "", complete: false },
				}),
			);
		for (let index = 0; index < 205; index++)
			stream.accept(event(++sequence, { type: "tool.started", toolCallId: `t${index}`, toolName: "read" }));
		for (let index = 0; index < 105; index++)
			stream.accept(event(++sequence, { type: "command.receipt", receipt: { id: `r${index}`, status: "accepted" } }));
		expect(stream.snapshot?.messages).toHaveLength(200);
		expect(stream.snapshot?.messages[0].id).toBe("m5");
		expect(stream.snapshot?.tools).toHaveLength(200);
		expect(stream.snapshot?.tools?.[0].toolCallId).toBe("t5");
		expect(stream.snapshot?.receipts).toHaveLength(100);
		expect(stream.snapshot?.receipts[0].id).toBe("r5");
	});

	it("acceptReceipt does nothing before a snapshot and replaces a pending receipt with its final one", () => {
		const empty = new ApplicationStream();
		empty.acceptReceipt({ id: "r", status: "completed" });
		expect(empty.snapshot).toBeUndefined();

		const stream = started();
		stream.acceptReceipt({ id: "r", status: "accepted" });
		stream.acceptReceipt({ id: "r", status: "failed", message: "no" });
		expect(stream.snapshot?.receipts).toEqual([{ id: "r", status: "failed", message: "no" }]);
	});
});
