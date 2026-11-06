import { expect, it } from "vitest";
import { Value } from "typebox/value";
import { ApplicationContentBlockSchema, applicationContentText, returnedPurpose } from "../src/content.ts";
import { ApplicationCommandSchema, applicationCommandFingerprint, parseApplicationFrame } from "../src/application.ts";

it("round trips ordered rich content and explicit failures through application frames", () => {
	const content = [
		{
			id: "m:0",
			type: "text",
			text: "Source",
			annotations: [{ type: "url_citation", url: "https://example.com", startIndex: 0, endIndex: 6 }],
		},
		{ id: "m:1", type: "thinking", text: "Summary", redacted: false },
		{ id: "m:2", type: "image", asset: { id: "asset", mimeType: "image/png", size: 10 } },
		{ id: "m:3", type: "toolCall", toolCallId: "t", name: "read", arguments: { path: "file.ts" } },
		{ id: "m:4", type: "unsupported", providerType: "future_format", text: "A future format" },
	];
	const frame = {
		protocolVersion: 1,
		cursor: { sessionId: "s", epoch: "e", sequence: 1 },
		at: 1,
		type: "event",
		event: {
			type: "message.completed",
			message: {
				id: "m",
				role: "assistant",
				text: "Source",
				complete: true,
				content,
				status: "failed",
				errorMessage: "Provider failed",
				usage: { input: 10 },
			},
		},
	};
	expect(parseApplicationFrame(JSON.parse(JSON.stringify(frame)))).toEqual(frame);
	expect(Value.Check(ApplicationContentBlockSchema, { id: "bad", type: "image", data: "raw" })).toBe(false);
});

it("accepts attachment references and binds idempotency to attachment identity", () => {
	const command = { id: "request", sessionId: "s", action: "prompt" as const, text: "", attachments: ["asset-a"] };
	expect(Value.Check(ApplicationCommandSchema, command)).toBe(true);
	expect(Value.Check(ApplicationCommandSchema, { ...command, attachments: [] })).toBe(false);
	expect(Value.Check(ApplicationCommandSchema, { ...command, path: "/private/file" })).toBe(false);
	expect(applicationCommandFingerprint(command)).not.toBe(
		applicationCommandFingerprint({ ...command, attachments: ["asset-b"] }),
	);
});

it("gives text-only consumers a visible fallback for non-text content", () => {
	expect(
		applicationContentText([
			{ id: "a", type: "image", asset: { id: "i", mimeType: "image/png", size: 10 } },
			{ id: "b", type: "thinking", text: "", redacted: true },
			{ id: "c", type: "unsupported", providerType: "future", text: "" },
		]),
	).toBe("[Image: image/png]\n[Reasoning redacted]\n[Unsupported content: future]");
});

it("reads an external call's purpose only from the data its result returns", () => {
	expect(returnedPurpose({ content: [], structuredContent: { mainGoal: " find the parser ", reason: "x" } })).toBe(
		"find the parser",
	);
	expect(returnedPurpose({ results: [{ index: 0, data: { reasoning: "why this row" } }] })).toBe("why this row");
	expect(returnedPurpose({ results: [{ reason: "row reason" }] })).toBe("row reason");
	expect(returnedPurpose({ content: [], structuredContent: { results: [{ data: { files: [] } }] } })).toBeUndefined();
	expect(returnedPurpose({ mainGoal: "  " })).toBeUndefined();
	expect(returnedPurpose("text")).toBeUndefined();
	expect(returnedPurpose(undefined)).toBeUndefined();
});
