import type { ApplicationFrame, ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { expect, it } from "vitest";
import { ApplicationProjection } from "../src/app/live/model.ts";
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
it("updates and clears model input capabilities without changing the transcript", () => {
	const stream = new ApplicationStream();
	stream.accept(frame(0, { type: "snapshot", snapshot }));
	const model = { provider: "custom", id: "vision", name: "Vision", input: ["text", "image"] };
	expect(stream.accept(frame(1, { type: "event", event: { type: "session.model", model } }))).toBe("applied");
	expect(stream.snapshot?.model).toEqual(model);
	expect(stream.snapshot?.messages).toEqual([]);
	expect(stream.accept(frame(2, { type: "event", event: { type: "session.model" } }))).toBe("applied");
	expect(stream.snapshot?.model).toBeUndefined();
});
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
it("accepts an explicit coalesced range only for an authoritative full-text delta", () => {
	const stream = new ApplicationStream();
	stream.accept(
		frame(0, {
			type: "snapshot",
			snapshot: { ...snapshot, messages: [{ id: "message-a", role: "assistant", text: "", complete: false }] },
		}),
	);
	expect(
		stream.accept(
			frame(3, {
				type: "event",
				fromSequence: 1,
				event: { type: "message.delta", messageId: "message-a", delta: "", text: "whole text" },
			}),
		),
	).toBe("applied");
	expect(stream.snapshot?.messages[0].text).toBe("whole text");
	expect(stream.accept(frame(5, { type: "event", fromSequence: 4, event: { type: "run.started", runId: "r" } }))).toBe(
		"resync",
	);
});
it("rejects missing, regressive, partial, cross-session and cross-epoch coalesced ranges", () => {
	const initial = () => {
		const stream = new ApplicationStream();
		stream.accept(
			frame(2, {
				type: "snapshot",
				snapshot: { ...snapshot, messages: [{ id: "m", role: "assistant", text: "", complete: false }] },
			}),
		);
		return stream;
	};
	const event = { type: "message.delta", messageId: "m", delta: "", text: "whole" };
	expect(initial().accept(frame(5, { type: "event", fromSequence: 4, event }))).toBe("resync");
	expect(initial().accept(frame(5, { type: "event", fromSequence: 2, event }))).toBe("resync");
	expect(initial().accept(frame(5, { type: "event", fromSequence: 3, event: { ...event, text: undefined } }))).toBe(
		"resync",
	);
	expect(initial().accept(frame(5, { type: "event", fromSequence: 3, event }, "new-epoch"))).toBe("resync");
	expect(
		initial().accept({
			...frame(5, { type: "event", fromSequence: 3, event }),
			cursor: { sessionId: "old", epoch: "epoch-a", sequence: 5 },
		}),
	).toBe("ignored");
	expect(initial().accept(frame(5, { type: "event", fromSequence: -1, event }))).toBe("invalid");
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
		{ toolCallId: "tool-a", order: 0, toolName: "read", text: "denied", status: "failed" },
	]);
	expect(stream.snapshot?.status).toBe("retrying");
});
it("tracks the dialog a session waits on, and drops it when the dialog closes, not when the run settles", () => {
	const stream = new ApplicationStream();
	stream.accept(frame(0, { type: "snapshot", snapshot: { ...snapshot, streaming: true, runId: "r" } }));
	const awaiting = { kind: "approval", title: "Run bash?" };
	expect(stream.accept(frame(1, { type: "event", event: { type: "session.awaiting", awaiting } }))).toBe("applied");
	expect(stream.snapshot?.awaiting).toEqual(awaiting);
	stream.accept(frame(2, { type: "event", event: { type: "session.awaiting" } }));
	expect(stream.snapshot?.awaiting).toBeUndefined();
	stream.accept(frame(3, { type: "event", event: { type: "session.awaiting", awaiting } }));
	// A background subagent's dialog outlives the run; the host publishes the close of any dialog that ended with it.
	stream.accept(frame(4, { type: "event", event: { type: "run.settled", runId: "r", aborted: true } }));
	expect(stream.snapshot?.awaiting).toEqual(awaiting);
	stream.accept(frame(5, { type: "event", event: { type: "session.awaiting" } }));
	expect(stream.snapshot?.awaiting).toBeUndefined();
});
it("follows the session phase: a run that settled with a background child stays waiting until the phase is final", () => {
	const stream = new ApplicationStream();
	stream.accept(frame(0, { type: "snapshot", snapshot: { ...snapshot, streaming: true, runId: "r" } }));
	const waiting = { state: "waiting", agents: 1, queued: 0, bash: 0, external: 0 };
	expect(
		stream.accept(frame(1, { type: "event", event: { type: "session.phase", phase: waiting, jobStartedAt: 3 } })),
	).toBe("applied");
	stream.accept(frame(2, { type: "event", event: { type: "run.settled", runId: "r", aborted: false } }));
	expect(stream.snapshot).toMatchObject({ streaming: false, phase: waiting, jobStartedAt: 3 });
	stream.accept(frame(3, { type: "event", event: { type: "session.phase", phase: { state: "done" } } }));
	expect(stream.snapshot?.phase).toEqual({ state: "done" });
	expect(stream.snapshot?.jobStartedAt).toBeUndefined();
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
		{ toolCallId: "t", order: 0, toolName: "bash", hint: "npm test", text: "3 passed", status: "completed" },
	]);
});
it("shows a tool's latest progress and drops it, with earlier result assets, when the result arrives", () => {
	const stream = new ApplicationStream();
	stream.accept(frame(0, { type: "snapshot", snapshot }));
	const tool = (sequence: number, event: Record<string, unknown>) =>
		stream.accept(frame(sequence, { type: "event", event: { toolCallId: "t", toolName: "mcp__s__slow", ...event } }));
	tool(1, { type: "tool.started" });
	const full = { id: "tool:t:data", mimeType: "application/json", size: 9000 };
	tool(2, { type: "tool.progress", text: "half", content: [], full, progress: { progress: 2, total: 4 } });
	expect(stream.snapshot?.tools?.[0]).toMatchObject({ status: "running", full, progress: { progress: 2, total: 4 } });
	tool(3, { type: "tool.completed", text: "done", content: [{ id: "b", type: "text", text: "done" }] });
	const completed = stream.snapshot?.tools?.[0];
	expect(completed).toMatchObject({ status: "completed", text: "done" });
	expect(completed?.full).toBeUndefined();
	expect(completed?.progress).toBeUndefined();
});
it("keeps live tool calls between the surrounding messages through progress and completion", () => {
	const stream = new ApplicationStream();
	stream.accept(
		frame(0, {
			type: "snapshot",
			snapshot: {
				...snapshot,
				messages: [{ id: "before", role: "assistant", text: "Before", complete: true, order: 0 }],
			},
		}),
	);
	stream.accept(
		frame(1, {
			type: "event",
			event: { type: "tool.started", toolCallId: "t", toolName: "bash", hint: "npm test" },
		}),
	);
	stream.accept(
		frame(2, {
			type: "event",
			event: {
				type: "message.completed",
				message: { id: "after", role: "assistant", text: "After", complete: true, order: 2 },
			},
		}),
	);
	for (const [sequence, event] of [
		[3, { type: "tool.progress", toolCallId: "t", toolName: "bash", text: "running" }],
		[4, { type: "tool.completed", toolCallId: "t", toolName: "bash", text: "done" }],
	] as const) {
		stream.accept(frame(sequence, { type: "event", event }));
		expect(stream.snapshot?.tools?.[0]).toMatchObject({ order: 1, toolCallId: "t" });
	}
	expect(new ApplicationProjection().update(stream.snapshot, 5).map((item) => item.text.split("\n")[0])).toEqual([
		"Before",
		"bash",
		"After",
	]);
});
it("retains a snapshot tool's order when a replayed progress event arrives", () => {
	const stream = new ApplicationStream();
	stream.accept(
		frame(0, {
			type: "snapshot",
			snapshot: { ...snapshot, tools: [{ toolCallId: "t", toolName: "bash", text: "", status: "running", order: 7 }] },
		}),
	);
	stream.accept(
		frame(1, {
			type: "event",
			event: { type: "tool.progress", toolCallId: "t", toolName: "bash", text: "running" },
		}),
	);
	expect(stream.snapshot?.tools?.[0].order).toBe(7);
});
it("uses the host's exact tool order when retained history has gaps", () => {
	const stream = new ApplicationStream();
	stream.accept(
		frame(0, {
			type: "snapshot",
			snapshot: {
				...snapshot,
				messages: [{ id: "recent", role: "assistant", text: "Recent", complete: true, order: 40 }],
			},
		}),
	);
	stream.accept(
		frame(1, {
			type: "event",
			event: {
				type: "tool.started",
				toolCallId: "t",
				toolName: "bash",
				order: 91,
			},
		}),
	);
	stream.accept(
		frame(2, {
			type: "event",
			event: {
				type: "tool.completed",
				toolCallId: "t",
				toolName: "bash",
				text: "done",
				order: 91,
			},
		}),
	);
	expect(stream.snapshot?.tools?.[0].order).toBe(91);
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
