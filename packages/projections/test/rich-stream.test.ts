import type { ApplicationContentBlock, ApplicationFrame, ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { expect, it } from "vitest";
import { ApplicationProjection, ApplicationStream } from "../src/index.ts";

const snapshot: ApplicationSnapshot = {
	sessionId: "s",
	messages: [],
	tools: [],
	streaming: false,
	steering: [],
	followUp: [],
	receipts: [],
	capabilities: [],
};
const frame = (sequence: number, body: Record<string, unknown>): ApplicationFrame =>
	({ protocolVersion: 1, cursor: { sessionId: "s", epoch: "e", sequence }, at: sequence, ...body }) as ApplicationFrame;
const content: ApplicationContentBlock[] = [
	{ id: "reason", type: "thinking", text: "Summary" },
	{ id: "image", type: "image", asset: { id: "asset", mimeType: "image/png", size: 1 } },
	{ id: "text", type: "text", text: "Answer", annotations: [{ type: "url_citation", url: "https://example.com" }] },
];

it("preserves complete block updates and tool metadata across replay and final replacement", () => {
	const stream = new ApplicationStream();
	stream.accept(frame(0, { type: "snapshot", snapshot }));
	stream.accept(
		frame(1, {
			type: "event",
			event: {
				type: "message.started",
				message: { id: "m", role: "assistant", text: "", content: [], status: "streaming", complete: false },
			},
		}),
	);
	stream.accept(
		frame(2, { type: "event", event: { type: "message.delta", messageId: "m", delta: "", text: "Answer", content } }),
	);
	expect(stream.snapshot?.messages[0].content).toEqual(content);
	stream.accept(
		frame(3, {
			type: "event",
			event: {
				type: "tool.started",
				toolCallId: "t",
				toolName: "inspect",
				arguments: { path: "actual.ts" },
				parentToolCallId: "parent",
				messageId: "m",
			},
		}),
	);
	stream.accept(
		frame(4, {
			type: "event",
			event: {
				type: "tool.completed",
				toolCallId: "t",
				toolName: "inspect",
				content: [content[1]],
				structuredContent: { records: [1] },
				details: { status: "ok" },
				durationMs: 17,
				usage: { input: 10 },
				failed: false,
			},
		}),
	);
	expect(stream.snapshot?.tools?.[0]).toMatchObject({
		content: [content[1]],
		arguments: { path: "actual.ts" },
		parentToolCallId: "parent",
		messageId: "m",
		structuredContent: { records: [1] },
		details: { status: "ok" },
		durationMs: 17,
		usage: { input: 10 },
	});
	stream.accept(
		frame(5, {
			type: "event",
			event: {
				type: "message.completed",
				message: {
					id: "m",
					role: "assistant",
					text: "Answer",
					content,
					status: "failed",
					complete: true,
					errorMessage: "Interrupted by provider",
					usage: { output: 3 },
				},
			},
		}),
	);
	const reconnected = new ApplicationStream();
	reconnected.accept(frame(5, { type: "snapshot", snapshot: stream.snapshot }));
	expect(reconnected.snapshot).toEqual(stream.snapshot);
	const original = new ApplicationProjection().update(stream.snapshot, 5);
	const restored = new ApplicationProjection().update(reconnected.snapshot, 5);
	expect(restored).toEqual(original);
	expect(restored.find((event) => event.message?.id === "m")?.message).toMatchObject({
		status: "failed",
		errorMessage: "Interrupted by provider",
		content,
	});
});

it("does not treat unchanged preview text as unchanged rich content", () => {
	const projection = new ApplicationProjection();
	const first = projection.update(
		{ ...snapshot, messages: [{ id: "m", role: "assistant", text: "", content: [content[1]], complete: false }] },
		1,
	);
	const second = projection.update(
		{
			...snapshot,
			messages: [
				{ id: "m", role: "assistant", text: "", content: [{ ...content[1], id: "new-image" }], complete: false },
			],
		},
		2,
	);
	expect(second[0].id).toBe(first[0].id);
	expect(second[0].at).toBe(first[0].at);
	expect(second[0]).not.toBe(first[0]);
	expect(second[0].message?.content?.[0].id).toBe("new-image");
});

it("replaces the transcript on a same-session branch reset", () => {
	const stream = new ApplicationStream();
	stream.accept(
		frame(0, {
			type: "snapshot",
			snapshot: {
				...snapshot,
				messages: [{ id: "old", role: "assistant", text: "Old branch", complete: true }],
				tools: [{ toolCallId: "old-tool", toolName: "read", text: "old", status: "completed" }],
			},
		}),
	);
	const messages = [{ id: "new", role: "user", text: "New branch", complete: true }];
	expect(stream.accept(frame(1, { type: "event", event: { type: "session.reset", messages, tools: [] } }))).toBe(
		"applied",
	);
	expect(stream.snapshot?.messages).toEqual(messages);
	expect(stream.snapshot?.tools).toEqual([]);
	expect(stream.cursor?.sequence).toBe(1);
});

it("retains hidden context in state without displaying it in the conversation", () => {
	const events = new ApplicationProjection().update(
		{
			...snapshot,
			messages: [
				{ id: "system", role: "system", text: "System policy", complete: true, display: false },
				{ id: "context", role: "custom", text: "Internal context", complete: true, display: false },
				{ id: "legacy", role: "custom", text: "Legacy hidden context", complete: true },
				{ id: "shown", role: "custom", text: "Public notice", complete: true, display: true },
			],
		},
		1,
	);
	expect(events.map((event) => event.text)).toEqual(["Public notice"]);
});

it("retains bounded content errors without interrupting subsequent messages and clears them on reset", () => {
	const stream = new ApplicationStream();
	stream.accept(frame(0, { type: "snapshot", snapshot }));
	for (let sequence = 1; sequence <= 12; sequence++)
		expect(
			stream.accept(
				frame(sequence, {
					type: "event",
					event: {
						type: "application.error",
						id: `error-${sequence}`,
						code: "content-unavailable",
						message: "Attachment could not be retained",
					},
				}),
			),
		).toBe("applied");
	expect(stream.snapshot?.errors).toHaveLength(10);
	expect(stream.snapshot?.errors?.[0].id).toBe("error-3");
	stream.accept(
		frame(13, {
			type: "event",
			event: {
				type: "message.completed",
				message: { id: "next", role: "assistant", text: "Next answer", complete: true },
			},
		}),
	);
	const events = new ApplicationProjection().update(stream.snapshot, 13);
	expect(events.find((event) => event.message)?.text).toBe("Next answer");
	expect(events.filter((event) => event.type === "application.error")).toHaveLength(10);
	stream.accept(frame(14, { type: "event", event: { type: "session.reset", messages: [], tools: [] } }));
	expect(stream.snapshot?.errors).toEqual([]);
	const errors = [
		{
			type: "application.error",
			id: "restoration",
			code: "content-unavailable",
			message: "History attachment unavailable",
		},
	];
	stream.accept(frame(15, { type: "event", event: { type: "session.reset", messages: [], tools: [], errors } }));
	expect(stream.snapshot?.errors).toEqual(errors);
});
