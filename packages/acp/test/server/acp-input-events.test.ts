import { type ContentBlock, RequestError } from "@agentclientprotocol/sdk";
import type { AssistantMessage } from "@octocodeai/octocode-ai";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai/compat";
import { describe, expect, it } from "vitest";
import { AcpEventProjector, toolContent, toolTitle } from "../../src/server/events.ts";
import { convertPrompt } from "../../src/server/input.ts";
import type { AcpWorkerEvent } from "../../src/host.ts";
import { acpServerHost } from "../../../coding-agent/src/main/acp-host.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5m8AAAAASUVORK5CYII=";

describe("ACP retry notices", () => {
	it("shows a retry wait as a thought, outside the reply, with its numbers in _meta", () => {
		const projector = new AcpEventProjector((summary) => summary);
		const updates = projector.update({
			type: "auto_retry_start",
			attempt: 2,
			maxAttempts: 5,
			delayMs: 1500,
			errorMessage: "503 service unavailable",
		});
		expect(updates).toEqual([
			{
				sessionUpdate: "agent_thought_chunk",
				content: { type: "text", text: "Retrying in 2s (attempt 2 of 5): 503 service unavailable\n" },
				_meta: { "octocode/autoRetry": { attempt: 2, maxAttempts: 5, delayMs: 1500 } },
			},
		]);
		expect(projector.error).toBeUndefined();
		expect(projector.stopReason).toBe("end_turn");
	});
});

describe("ACP prompt conversion", () => {
	it("preserves text, labels resource context, and leaves resource links unfetched", () => {
		expect(
			convertPrompt([
				{ type: "text", text: "Review this" },
				{ type: "resource_link", name: "source", title: "Source file", uri: "file:///does-not-exist.ts" },
				{ type: "resource", resource: { uri: "custom://selection", text: "const answer = 42;" } },
			]),
		).toEqual({
			text: "Review this\n\n[Resource link: Source file]\nURI: file:///does-not-exist.ts\n\n[Embedded resource: custom://selection]\nconst answer = 42;",
		});
	});

	it("converts a supported image without changing its bytes", () => {
		expect(convertPrompt([{ type: "image", mimeType: "image/png", data: PNG }])).toEqual({
			text: "",
			images: [{ type: "image", mimeType: "image/png", data: PNG }],
		});
	});

	it.each([
		{ type: "audio", mimeType: "audio/wav", data: "AAAA" },
		{ type: "resource", resource: { uri: "file:///binary", blob: "AAAA" } },
		{ type: "other" },
		{ type: "image", mimeType: "image/png", data: "invalid!" },
		{ type: "image", mimeType: "image/png", data: "AAAA" },
		{ type: "image", mimeType: "image/jpeg", data: PNG },
		{ type: "image", mimeType: "image/svg+xml", data: PNG },
		{ type: "resource", resource: { uri: "file:///binary", text: "x", blob: "AAAA" } },
	])("rejects unsupported or malformed blocks before dispatch: $type", (block) => {
		expect(() => convertPrompt([{ type: "text", text: "Do not partially dispatch" }, block as ContentBlock])).toThrow(
			RequestError,
		);
	});

	it("rejects oversized encoded images before decoding", () => {
		expect(() => convertPrompt([{ type: "image", mimeType: "image/png", data: "A".repeat(7 * 1024 * 1024) }])).toThrow(
			RequestError,
		);
	});

	it("bounds the number of images in a prompt", () => {
		const images: ContentBlock[] = Array.from({ length: 21 }, () => ({
			type: "image",
			mimeType: "image/png",
			data: PNG,
		}));
		expect(() => convertPrompt(images)).toThrow(RequestError);
	});
});

function assistant(text: string, changes: Partial<AssistantMessage> = {}): AssistantMessage {
	return { ...fauxAssistantMessage(text), ...changes };
}

function delta(contentIndex: number, text: string): AcpWorkerEvent {
	return {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex, delta: text },
	};
}

function textChunk(text: string) {
	return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
}

describe("ACP event projection", () => {
	it("shows visible external messages without exposing hidden extension context", () => {
		const projector = new AcpEventProjector(acpServerHost.compactionSummaryText);
		const message = {
			role: "custom" as const,
			customType: "octocode-external",
			content: "External client: hello",
			display: true,
			timestamp: 1,
		};
		// Text from a child, a peer or an API client is agent-side content, never the user's words.
		expect(projector.update({ type: "message_end", message })).toEqual([
			{
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: message.content },
				_meta: { "octocode/customType": "octocode-external" },
			},
		]);
		expect(projector.update({ type: "message_end", message: { ...message, display: false } })).toEqual([]);
	});

	it("reconciles streamed text independently for each block and hides all thinking", () => {
		const projector = new AcpEventProjector(acpServerHost.compactionSummaryText);
		projector.update({ type: "message_start", message: assistant("") });
		expect(projector.update(delta(0, "Hello"))).toEqual([textChunk("Hello")]);
		expect(
			projector.update({
				type: "message_update",
				assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "private" },
			}),
		).toEqual([]);
		expect(projector.update(delta(2, "Second"))).toEqual([textChunk("Second")]);
		const final = assistant("", {
			content: [
				{ type: "text", text: "Hello world" },
				{ type: "thinking", thinking: "private" },
				{ type: "text", text: "Second block" },
			],
		});
		expect(projector.update({ type: "message_end", message: final })).toEqual([
			textChunk(" world"),
			textChunk(" block"),
		]);
		expect(projector.update({ type: "message_end", message: final })).toEqual([]);
	});

	it("emits complete nonstreamed text and resets tracking for the next assistant message", () => {
		const projector = new AcpEventProjector(acpServerHost.compactionSummaryText);
		expect(projector.update({ type: "message_end", message: assistant("One") })).toEqual([textChunk("One")]);
		projector.update({ type: "message_start", message: assistant("") });
		expect(projector.update({ type: "message_end", message: assistant("Two") })).toEqual([textChunk("Two")]);
	});

	it("does not duplicate a final snapshot that diverges from streamed text", () => {
		const projector = new AcpEventProjector(acpServerHost.compactionSummaryText);
		projector.update(delta(0, "Streamed"));
		expect(projector.update({ type: "message_end", message: assistant("Rewritten final") })).toEqual([]);
	});

	it.each([
		["length", "max_tokens"],
		["aborted", "cancelled"],
		["stop", "end_turn"],
		["toolUse", "end_turn"],
	] as const)("maps assistant stop reason %s to %s", (stopReason, expected) => {
		const projector = new AcpEventProjector(acpServerHost.compactionSummaryText);
		projector.update({ type: "message_end", message: assistant("", { stopReason }) });
		expect(projector.stopReason).toBe(expected);
	});

	it("retains generation failures until retry is scheduled, then accepts the retried result", () => {
		const projector = new AcpEventProjector(acpServerHost.compactionSummaryText);
		projector.update({
			type: "message_end",
			message: assistant("", { stopReason: "error", errorMessage: "provider unavailable" }),
		});
		expect(projector.error).toBe("provider unavailable");
		projector.update({ type: "agent_end", willRetry: true });
		expect(projector.error).toBeUndefined();
		projector.update({ type: "message_start", message: assistant("") });
		projector.update({ type: "message_end", message: assistant("Recovered") });
		projector.update({ type: "agent_end", willRetry: false });
		expect(projector.error).toBeUndefined();
		expect(projector.stopReason).toBe("end_turn");
	});

	it("preserves a command failure after its dispatched model work completes", () => {
		const projector = new AcpEventProjector(acpServerHost.compactionSummaryText);
		projector.update({
			type: "extension_error",
			event: "command",
			error: "ACP owns session selection",
		});
		projector.update({ type: "message_start", message: assistant("") });
		projector.update({ type: "message_end", message: assistant("Earlier dispatched work completed") });
		expect(projector.error).toBe("ACP owns session selection");
	});

	it("projects tool status and bounded text without raw output or binary details", () => {
		const projector = new AcpEventProjector(acpServerHost.compactionSummaryText);
		expect(
			projector.update({
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "bash",
				args: { command: "test" },
			}),
		).toEqual([
			{
				sessionUpdate: "tool_call",
				toolCallId: "call-1",
				title: "bash",
				name: "bash",
				kind: "execute",
				status: "in_progress",
			},
		]);
		const updates = projector.update({
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "bash",
			args: {},
			partialResult: {
				content: [
					{ type: "text", text: "x".repeat(30_000) },
					{ type: "image", data: "secret-binary" },
				],
				details: { secret: "private" },
			},
		});
		const json = JSON.stringify(updates);
		expect(json).toContain("Tool output truncated for ACP");
		expect(json.length).toBeLessThan(16_300);
		expect(json).not.toContain("secret");
		expect(json).not.toContain("rawOutput");
		expect(
			projector.update({
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "bash",
				result: { content: [{ type: "text", text: "failed" }] },
				isError: true,
			}),
		).toEqual([
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "call-1",
				status: "failed",
				content: [{ type: "content", content: { type: "text", text: "failed" } }],
			},
		]);
	});

	it("announces a tool that ended before a start event and marks success completed", () => {
		const projector = new AcpEventProjector(acpServerHost.compactionSummaryText);
		expect(
			projector.update({
				type: "tool_execution_end",
				toolCallId: "call-2",
				toolName: "read",
				result: {},
				isError: false,
			}),
		).toEqual([
			{
				sessionUpdate: "tool_call",
				toolCallId: "call-2",
				title: "read",
				name: "read",
				kind: "other",
				status: "in_progress",
			},
			{ sessionUpdate: "tool_call_update", toolCallId: "call-2", status: "completed", content: [] },
		]);
	});

	it("titles a tool call with its reason on one line, as the terminal's reason row does", () => {
		const projector = new AcpEventProjector(acpServerHost.compactionSummaryText);
		const args = { command: "npm test", reason: "Run the focused\ntests\u0007 now" };
		expect(projector.update({ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args })).toEqual([
			{
				sessionUpdate: "tool_call",
				toolCallId: "c",
				title: "bash: Run the focused tests now",
				name: "bash",
				kind: "execute",
				status: "in_progress",
			},
		]);
		// A one-word reason says no more than the name; a missing or non-text one is left out.
		expect(toolTitle("file", { reason: "Edit" })).toBe("file");
		expect(toolTitle("file", { reason: 3 })).toBe("file");
		expect(toolTitle("file")).toBe("file");
		expect(toolTitle("web", { reason: "x ".repeat(600) })).toHaveLength(512);
	});
});

describe("ACP tool content", () => {
	it("keeps a bash result's status line and the end of its output when it exceeds the limit", () => {
		const header = "[exit 1 · 4.2s · 3,000 lines · 96 KB · trimmed: first 120 + last 478 lines]";
		const body = Array.from({ length: 3000 }, (_, index) => `line ${index} some padding text here`).join("\n");
		const [item] = toolContent({ content: [{ type: "text", text: `${header}\n${body}\nerror: the final failure` }] });
		const text = (item as { content: { text: string } }).content.text;
		expect(text.startsWith(header)).toBe(true);
		expect(text.endsWith("error: the final failure")).toBe(true);
		expect(text).toMatch(/\[Tool output truncated for ACP: \d+ characters omitted\.\]/);
		expect(text.length).toBeLessThanOrEqual(16_000);
	});

	it("passes a result within the limit through unchanged", () => {
		expect(toolContent({ content: [{ type: "text", text: "[exit 0 · 0.1s · 1 line · 3 B]\nhi" }] })).toEqual([
			{ type: "content", content: { type: "text", text: "[exit 0 · 0.1s · 1 line · 3 B]\nhi" } },
		]);
	});
});

describe("ACP tool calls from the host's display", () => {
	it("titles, kinds, locates and fills a call from its display", () => {
		const projector = new AcpEventProjector((summary) => summary);
		const display = {
			title: "File",
			summary: "edit src/a.ts · 1 edit",
			reason: "Fix the parser",
			kind: "edit" as const,
			locations: [{ path: "src/a.ts" }],
			blocks: [],
		};
		expect(
			projector.update({ type: "tool_execution_start", toolCallId: "f", toolName: "file", args: {}, display }),
		).toEqual([
			{
				sessionUpdate: "tool_call",
				toolCallId: "f",
				title: "File(edit src/a.ts · 1 edit): Fix the parser",
				name: "file",
				kind: "edit",
				status: "in_progress",
				locations: [{ path: "src/a.ts" }],
			},
		]);
		const done = {
			...display,
			outcome: { text: "Applied" },
			blocks: [{ type: "text" as const, text: "a.ts +1 -0" }],
		};
		const [update] = projector.update({
			type: "tool_execution_end",
			toolCallId: "f",
			toolName: "file",
			result: { content: [{ type: "text", text: "raw model text" }] },
			isError: false,
			display: done,
		});
		expect(update).toMatchObject({
			sessionUpdate: "tool_call_update",
			status: "completed",
			locations: [{ path: "src/a.ts" }],
		});
		const content = JSON.stringify(update);
		expect(content).toContain("⎿ Applied");
		expect(content).not.toContain("raw model text");
	});
});
