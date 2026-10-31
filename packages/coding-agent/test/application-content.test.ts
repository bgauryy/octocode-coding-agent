import { afterEach, expect, it } from "vitest";
import type { ApplicationEvent, ApplicationFrame } from "@octocodeai/octocode-contracts";
import { getApplicationPort, type ApplicationService } from "../src/core/application/index.ts";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { writtenSummary } from "./octocode/fixtures/compaction-summary.ts";

const open: ApplicationService[] = [];
afterEach(() => {
	for (const service of open.splice(0)) service.dispose();
});
function fixture(messages: unknown[] = []) {
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	const calls: unknown[][] = [];
	const session = {
		sessionId: "content-test",
		model: { provider: "test-provider", id: "test-model", name: "Fixture", input: ["text", "image"] },
		messages,
		isStreaming: false,
		subscribe(callback: typeof listener) {
			listener = callback;
			return () => {};
		},
		async prompt(...args: unknown[]) {
			calls.push(args);
		},
		async steer(...args: unknown[]) {
			calls.push(args);
		},
		async followUp(...args: unknown[]) {
			calls.push(args);
		},
	} as unknown as AgentSession;
	const service = getApplicationPort(session);
	open.push(service);
	return { service, session, calls, emit: (event: unknown) => listener?.(event as AgentSessionEvent) };
}
async function snapshot(service: ApplicationService) {
	const connection = service.connect();
	const frame = (await connection[Symbol.asyncIterator]().next()).value as ApplicationFrame;
	connection.close();
	if (frame.type !== "snapshot") throw new Error("Expected snapshot");
	return frame.snapshot;
}
const image = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };

it("refreshes image capabilities when reconnecting after a session change", () => {
	const f = fixture();
	expect(f.service.getSnapshot().model?.input).toEqual(["text", "image"]);
	Object.assign(f.session, {
		sessionId: "text-session",
		model: { provider: "test-provider", id: "text-model", name: "Text", input: ["text"] },
		messages: [],
	});
	expect(f.service.getSnapshot().model?.input).toEqual(["text"]);
	Object.assign(f.session, { sessionId: "unconfigured-session", model: undefined, messages: [] });
	expect(f.service.getSnapshot().model).toBeUndefined();
});

it("preserves ordered model blocks, status, usage and citations in the common stream", async () => {
	const f = fixture();
	const local: ApplicationEvent[] = [];
	f.service.subscribe((event) => local.push(event));
	const connection = f.service.connect();
	const remote = connection[Symbol.asyncIterator]();
	await remote.next();
	const message = {
		role: "assistant",
		timestamp: 1,
		provider: "test-provider",
		model: "test-model",
		responseId: "reply-1",
		stopReason: "error",
		errorMessage: "Provider failed",
		usage: { output: 12 },
		content: [
			{ type: "thinking", thinking: "Visible summary", thinkingSignature: "private-replay-token" },
			{
				type: "text",
				text: "Source",
				annotations: [{ type: "url_citation", url: "https://example.com", title: "Source" }],
			},
			image,
			{ type: "toolCall", id: "call-1", name: "lookup", arguments: { query: "x" } },
			{ type: "text", text: "After" },
		],
	};
	f.emit({ type: "message_end", message });
	const frame = (await remote.next()).value as Extract<ApplicationFrame, { type: "event" }>;
	expect(frame.event).toEqual(local[0]);
	const state = await snapshot(f.service);
	expect(state.messages[0]).toMatchObject({
		status: "failed",
		errorMessage: "Provider failed",
		provider: "test-provider",
		model: "test-model",
		responseId: "reply-1",
		usage: { output: 12 },
	});
	expect(state.messages[0].content?.map((block) => block.type)).toEqual([
		"thinking",
		"text",
		"image",
		"toolCall",
		"text",
	]);
	expect(JSON.stringify(state)).not.toContain("private-replay-token");
	expect(JSON.stringify(state)).not.toContain(image.data);
	const block = state.messages[0].content?.[2];
	if (block?.type !== "image") throw new Error("Expected image");
	expect(f.service.readAsset(block.asset.id)?.data).toBe(image.data);
	connection.close();
});

it("streams reasoning and final corrections even when no text delta arrives", async () => {
	const f = fixture();
	const events: ApplicationEvent[] = [];
	f.service.subscribe((event) => events.push(event));
	f.emit({ type: "message_start", message: { role: "assistant", timestamp: 2, content: [] } });
	f.emit({
		type: "message_update",
		message: { role: "assistant", timestamp: 2, content: [{ type: "thinking", thinking: "Summary" }] },
		assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Summary" },
	});
	expect(events.at(-1)).toMatchObject({ type: "message.delta", content: [{ type: "thinking", text: "Summary" }] });
	f.emit({
		type: "message_end",
		message: { role: "assistant", timestamp: 2, content: [{ type: "text", text: "Corrected" }], stopReason: "aborted" },
	});
	expect((await snapshot(f.service)).messages).toEqual([
		expect.objectContaining({ status: "aborted", text: "Corrected", complete: true }),
	]);
});

it("reconstructs tool identity, structured results and attachments from persisted history", async () => {
	const messages = [
		{ role: "user", timestamp: 1, content: [image] },
		{
			role: "assistant",
			timestamp: 2,
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "screen", name: "screenshot", arguments: { window: 7 } }],
		},
		{
			role: "toolResult",
			timestamp: 3,
			toolCallId: "screen",
			toolName: "screenshot",
			content: [image],
			structuredContent: { width: 640 },
			details: { source: "display" },
			isError: false,
			durationMs: 42,
		},
	];
	const first = fixture(messages);
	const before = await snapshot(first.service);
	const restored = fixture(JSON.parse(JSON.stringify(messages)));
	const after = await snapshot(restored.service);
	expect(after).toEqual(before);
	expect(after.tools).toEqual([
		expect.objectContaining({
			toolCallId: "screen",
			arguments: { window: 7 },
			structuredContent: { width: 640 },
			details: { source: "display" },
			durationMs: 42,
			status: "completed",
			messageId: after.messages[1].id,
			content: [expect.objectContaining({ type: "image" })],
		}),
	]);
});

it("keeps the complete text behind an explicit asset and pages older history", async () => {
	const full = `IMPORTANT PREFIX\n${"x".repeat(70000)}\nIMPORTANT END`;
	const f = fixture(
		Array.from({ length: 80 }, (_, timestamp) => ({
			role: "user",
			timestamp,
			content: timestamp === 0 ? full : `message-${timestamp}`,
		})),
	);
	const state = await snapshot(f.service);
	expect(state.messages.length).toBeLessThanOrEqual(50);
	const latest = f.service.history({ limit: 50 });
	expect(latest.hasMore).toBe(true);
	const older = f.service.history({ before: latest.before, limit: 50 });
	expect(older.hasMore).toBe(false);
	expect(older.messages).toHaveLength(30);
	const block = older.messages[0].content?.[0];
	if (block?.type !== "text" || !block.full) throw new Error("Expected full text reference");
	expect(f.service.readAsset(block.full.id)?.data).toBe(full);
	expect(block.text).toContain("Full content available");
});

it("accepts image-only prompts and queue commands, and rejects expired attachment authority", async () => {
	const f = fixture();
	const asset = f.service.uploadAsset({ mimeType: image.mimeType, data: image.data });
	for (const action of ["prompt", "steer", "followUp"] as const)
		await f.service.execute({ id: action, sessionId: f.session.sessionId, action, text: "", attachments: [asset.id] });
	await Promise.resolve();
	expect(f.calls).toEqual([
		["", { images: [image] }],
		["", [image]],
		["", [image]],
	]);
	await expect(
		f.service.execute({ id: "empty", sessionId: f.session.sessionId, action: "prompt", text: "" }),
	).rejects.toThrow("Invalid application command");
	Object.defineProperty(f.session, "sessionId", { value: "another-session" });
	expect(f.service.readAsset(asset.id)).toBeUndefined();
	await expect(
		f.service.execute({
			id: "expired",
			sessionId: f.session.sessionId,
			action: "prompt",
			text: "",
			attachments: [asset.id],
		}),
	).rejects.toThrow("unavailable");
});

it("detaches mutable provider objects from published frames and bounds oversized arguments", async () => {
	const f = fixture();
	const events: ApplicationEvent[] = [];
	f.service.subscribe((event) => events.push(event));
	const args = { path: "original" };
	const details = { rows: ["original"] };
	f.emit({ type: "tool_execution_start", toolCallId: "mutable", toolName: "read", args });
	f.emit({
		type: "tool_execution_update",
		toolCallId: "mutable",
		toolName: "read",
		args,
		partialResult: { content: [], details },
	});
	args.path = "changed";
	details.rows.push("changed");
	expect(events[0]).toMatchObject({ arguments: { path: "original" } });
	expect(events[1]).toMatchObject({ details: { rows: ["original"] } });
	f.emit({
		type: "tool_execution_start",
		toolCallId: "large",
		toolName: "file",
		args: { content: "x".repeat(300000) },
	});
	const large = events.at(-1);
	expect(JSON.stringify(large).length).toBeLessThan(64000);
	if (large?.type !== "tool.started" || !large.full) throw new Error("Expected full tool data");
	expect(JSON.parse(f.service.readAsset(large.full.id)!.data).arguments.content).toHaveLength(300000);
});

it("rejects reads and uploads from a previously bound session before exposing the new session", () => {
	const f = fixture();
	const asset = f.service.uploadAsset({ mimeType: image.mimeType, data: image.data }, "content-test");
	Object.defineProperty(f.session, "sessionId", { value: "private-session" });
	Object.defineProperty(f.session, "messages", { value: [{ role: "user", content: "PRIVATE CONTENT", timestamp: 1 }] });
	expect(() => f.service.history({ sessionId: "content-test" })).toThrow("Session changed");
	expect(() => f.service.readAsset(asset.id, "content-test")).toThrow("Session changed");
	expect(() => f.service.uploadAsset({ mimeType: image.mimeType, data: image.data }, "content-test")).toThrow(
		"Session changed",
	);
	expect(f.service.history({ sessionId: "private-session" }).messages[0].text).toBe("PRIVATE CONTENT");
});

it("replaces the canonical transcript when context changes inside the same session", async () => {
	const f = fixture([{ role: "user", content: "OLD BRANCH", timestamp: 1 }]);
	const events: ApplicationEvent[] = [];
	f.service.subscribe((event) => events.push(event));
	const connection = f.service.connect();
	const iterator = connection[Symbol.asyncIterator]();
	await iterator.next();
	Object.defineProperty(f.session, "messages", { value: [{ role: "user", content: "NEW BRANCH", timestamp: 2 }] });
	f.emit({ type: "session_context_changed" });
	expect(events).toEqual([
		expect.objectContaining({
			type: "session.reset",
			messages: [expect.objectContaining({ text: "NEW BRANCH" })],
			tools: [],
		}),
	]);
	expect((await iterator.next()).value).toMatchObject({ type: "resync" });
	expect((await snapshot(f.service)).messages).toEqual([expect.objectContaining({ text: "NEW BRANCH" })]);
	expect(JSON.stringify(f.service.history())).not.toContain("OLD BRANCH");
	connection.close();
});

it("retains streaming state when a display projector changes and does not expose hidden messages", async () => {
	const f = fixture();
	f.emit({
		type: "message_start",
		message: { role: "assistant", content: [{ type: "text", text: "Working" }], stopReason: "stop", timestamp: 1 },
	});
	f.service.setToolOutputProjector(() => "preview");
	expect((await snapshot(f.service)).messages[0]).toMatchObject({
		complete: false,
		status: "streaming",
		text: "Working",
	});
	f.emit({
		type: "message_end",
		message: {
			role: "custom",
			customType: "hidden",
			display: false,
			content: "Hidden",
			details: { hint: "extension" },
			timestamp: 2,
		},
	});
	f.emit({ type: "message_end", message: { role: "system", content: "Internal policy", timestamp: 3 } });
	const state = await snapshot(f.service);
	expect(state.messages[1]).toMatchObject({ display: false, details: { hint: "extension" } });
	expect(state.messages[2]).toMatchObject({ display: false });
});

it("reports unavailable content without resync loops and continues streaming later messages", async () => {
	const f = fixture([{ role: "user", content: "Existing message", timestamp: 1 }]);
	const events: ApplicationEvent[] = [];
	f.service.subscribe((event) => events.push(event));
	const connection = f.service.connect();
	const iterator = connection[Symbol.asyncIterator]();
	await iterator.next();
	f.emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "x".repeat(33 * 1024 * 1024) }],
			timestamp: 2,
			stopReason: "stop",
		},
	});
	expect(events).toEqual([
		expect.objectContaining({
			type: "application.error",
			code: "content-unavailable",
			message: expect.stringContaining("original remains in the session"),
		}),
	]);
	expect((await iterator.next()).value).toMatchObject({ type: "event", event: { type: "application.error" } });
	f.emit({
		type: "message_end",
		message: { role: "assistant", content: "Later message", timestamp: 3, stopReason: "stop" },
	});
	const state = await snapshot(f.service);
	expect(state.messages.map((message) => message.text)).toEqual(["Existing message", "Later message"]);
	expect(state.errors).toHaveLength(1);
	expect(state.messages[1].status).toBe("completed");
	connection.close();
});

it("returns an unavailable block when historical image normalization exceeds capacity", () => {
	const f = fixture();
	const message = {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "image", mimeType: "image/png", data: Buffer.alloc(33 * 1024 * 1024).toString("base64") }],
	};
	const normalized = f.service.normalizeMessage(message, "large-image");
	expect(normalized).toMatchObject({
		id: "large-image",
		role: "assistant",
		status: "completed",
		complete: true,
		content: [{ type: "unsupported", providerType: "content-unavailable" }],
	});
	expect(JSON.stringify(normalized).length).toBeLessThan(1000);
});

it("shows a compaction summary as the terminal does, not as written for the model", async () => {
	const summary = writtenSummary();
	const f = fixture([{ role: "compactionSummary", summary, tokensBefore: 5000, timestamp: 1 }]);
	const frame = await snapshot(f.service);
	const text = JSON.stringify(frame);
	expect(text).toContain("Compacted 5,000 tokens");
	expect(text).toContain("Fix the login bug");
	expect(text).not.toContain("user-message");
	expect(text).not.toContain("## Recovery");
});
