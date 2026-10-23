import type { ApplicationFrame, ApplicationSnapshot } from "@octocodeai/octocode-contacts";
import { expect, it } from "vitest";
import { ApplicationStream } from "../src/application-stream.ts";

const snapshot: ApplicationSnapshot = {
	sessionId: "session-a",
	messages: [],
	streaming: false,
	steering: [],
	followUp: [],
	receipts: [],
	capabilities: ["prompt", "abort"],
};
const frame = (
	sequence: number,
	body: Pick<ApplicationFrame, "type"> & Record<string, unknown>,
	epoch = "epoch-a",
): ApplicationFrame =>
	({
		protocolVersion: 1,
		cursor: { sessionId: "session-a", epoch, sequence },
		at: sequence,
		...body,
	}) as ApplicationFrame;
it("applies partial output once and replaces it with authoritative final content", () => {
	const stream = new ApplicationStream();
	stream.accept(frame(0, { type: "snapshot", snapshot }));
	stream.accept(
		frame(1, {
			type: "event",
			event: { type: "message.started", message: { id: "message-a", role: "assistant", text: "", complete: false } },
		}),
	);
	const delta = frame(2, { type: "event", event: { type: "message.delta", messageId: "message-a", delta: "Partial" } });
	expect(stream.accept(delta)).toBe("applied");
	expect(stream.accept(delta)).toBe("ignored");
	expect(stream.snapshot?.messages[0].text).toBe("Partial");
	stream.accept(
		frame(3, {
			type: "event",
			event: {
				type: "message.completed",
				message: { id: "message-a", role: "assistant", text: "Final text", complete: true },
			},
		}),
	);
	expect(stream.snapshot?.messages).toEqual([
		{ id: "message-a", role: "assistant", text: "Final text", complete: true },
	]);
});
it("stops at a sequence gap and requires a snapshot before applying more deltas", () => {
	const stream = new ApplicationStream();
	stream.accept(frame(4, { type: "snapshot", snapshot }));
	expect(stream.accept(frame(6, { type: "event", event: { type: "run.started", runId: "run-a" } }))).toBe("resync");
	expect(stream.cursor).toBeUndefined();
	expect(stream.accept(frame(7, { type: "event", event: { type: "run.started", runId: "run-a" } }))).toBe("resync");
	expect(stream.snapshot?.streaming).toBe(false);
	expect(
		stream.accept(frame(7, { type: "snapshot", snapshot: { ...snapshot, streaming: true, runId: "run-a" } })),
	).toBe("applied");
	expect(stream.snapshot?.streaming).toBe(true);
});
it("resynchronizes restarted epochs, ignores stale sessions, and rejects malformed input", () => {
	const stream = new ApplicationStream();
	stream.accept(frame(4, { type: "snapshot", snapshot }));
	expect(stream.accept(frame(5, { type: "event", event: { type: "run.started", runId: "run-a" } }, "epoch-b"))).toBe(
		"resync",
	);
	stream.accept(frame(0, { type: "snapshot", snapshot }, "epoch-b"));
	expect(
		stream.accept({
			...frame(1, { type: "event", event: { type: "run.started", runId: "run-old" } }),
			cursor: { sessionId: "old-session", epoch: "old", sequence: 1 },
		}),
	).toBe("ignored");
	expect(
		stream.accept({
			...frame(1, { type: "event", event: { type: "message.delta", messageId: "message-a", delta: 42 } }),
		}),
	).toBe("invalid");
});
it("reconciles receipts by request ID without treating late acceptance as completion", () => {
	const stream = new ApplicationStream();
	stream.accept(frame(0, { type: "snapshot", snapshot }));
	stream.accept(
		frame(1, { type: "event", event: { type: "command.receipt", receipt: { id: "request-a", status: "completed" } } }),
	);
	stream.acceptReceipt({ id: "request-a", status: "accepted" });
	expect(stream.snapshot?.receipts).toEqual([{ id: "request-a", status: "completed" }]);
});
it("restores tools from a snapshot, updates progress, and retains retry status", () => {
	const stream = new ApplicationStream();
	stream.accept(
		frame(0, {
			type: "snapshot",
			snapshot: {
				...snapshot,
				tools: [{ toolCallId: "tool-a", toolName: "read", text: "opening", status: "running" }],
			},
		}),
	);
	stream.accept(
		frame(1, {
			type: "event",
			event: { type: "tool.progress", toolCallId: "tool-a", toolName: "read", text: "file content" },
		}),
	);
	stream.accept(
		frame(2, {
			type: "event",
			event: { type: "tool.completed", toolCallId: "tool-a", toolName: "read", text: "denied", failed: true },
		}),
	);
	stream.accept(frame(3, { type: "event", event: { type: "session.status", status: "retrying" } }));
	expect(stream.snapshot?.tools).toEqual([
		{ toolCallId: "tool-a", toolName: "read", text: "denied", status: "failed" },
	]);
	expect(stream.snapshot?.status).toBe("retrying");
});
it("keeps a tool call's hint after progress and completion replace its text", () => {
	const stream = new ApplicationStream();
	stream.accept(frame(0, { type: "snapshot", snapshot }));
	stream.accept(
		frame(1, { type: "event", event: { type: "tool.started", toolCallId: "t", toolName: "bash", hint: "npm test" } }),
	);
	stream.accept(
		frame(2, { type: "event", event: { type: "tool.progress", toolCallId: "t", toolName: "bash", text: "1/3" } }),
	);
	stream.accept(
		frame(3, { type: "event", event: { type: "tool.completed", toolCallId: "t", toolName: "bash", text: "3 passed" } }),
	);
	expect(stream.snapshot?.tools).toEqual([
		{ toolCallId: "t", toolName: "bash", hint: "npm test", text: "3 passed", status: "completed" },
	]);
});
it("invalidates the old cursor when the host switches sessions", () => {
	const stream = new ApplicationStream();
	stream.accept(frame(2, { type: "snapshot", snapshot }));
	expect(
		stream.accept({
			protocolVersion: 1,
			cursor: { sessionId: "session-b", epoch: "epoch-b", sequence: 0 },
			at: 3,
			type: "resync",
			reason: "session-changed",
		}),
	).toBe("resync");
	expect(stream.cursor).toBeUndefined();
});
