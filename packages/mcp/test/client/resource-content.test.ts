import { describe, expect, it } from "vitest";
import { validateCallToolResult } from "../../src/client/client/results.ts";
import { McpError } from "../../src/client/protocol/jsonrpc.ts";

const content = (...blocks: unknown[]) => validateCallToolResult({ content: blocks }).content;

describe("tool result resources", () => {
	it("shows an embedded text resource whole, after its URI and type", () => {
		const text = "line 1\nline 2\n".repeat(2000);
		expect(content({ type: "resource", resource: { uri: "file:///a.md", mimeType: "text/markdown", text } })).toEqual([
			{ type: "text", text: `[resource file:///a.md (text/markdown)]\n${text}` },
		]);
	});

	it("passes an image blob as an image and names any other blob without its base64", () => {
		expect(
			content(
				{ type: "resource", resource: { uri: "file:///a.png", mimeType: "image/png", blob: "aW1n" } },
				{ type: "resource", resource: { uri: "file:///a.bin", mimeType: "application/zip", blob: "AAECAw==" } },
				{ type: "resource", resource: { uri: "file:///b", blob: "AAE=" } },
			),
		).toEqual([
			{ type: "image", data: "aW1n", mimeType: "image/png" },
			{ type: "text", text: "[resource file:///a.bin (application/zip, 4 bytes of binary data, not shown)]" },
			{ type: "text", text: "[resource file:///b (unknown type, 2 bytes of binary data, not shown)]" },
		]);
	});

	it("describes a resource link with what the server says about it", () => {
		expect(
			content({
				type: "resource_link",
				uri: "file:///src/main.rs",
				name: "main.rs",
				title: "Entry point",
				description: "Primary application entry point",
				mimeType: "text/x-rust",
				size: 120,
			}),
		).toEqual([
			{
				type: "text",
				text: "[resource link file:///src/main.rs]\nname: main.rs\ntitle: Entry point\ndescription: Primary application entry point\nmimeType: text/x-rust\nsize: 120 bytes",
			},
		]);
	});

	it.each([
		{ type: "resource" },
		{ type: "resource", resource: { text: "no uri" } },
		{ type: "resource", resource: { uri: "x://a" } },
		{ type: "resource", resource: { uri: "x://a", mimeType: 1, text: "t" } },
		{ type: "resource_link", uri: "x://a" },
		{ type: "resource_link", uri: "x://a", name: "a", size: "big" },
	])("rejects a malformed resource block %#", (block) => {
		expect(() => content(block)).toThrow("Invalid MCP tool content");
	});
});

describe("tool result isError", () => {
	it.each(["true", 1, null, {}])("rejects a non-boolean isError (%j) as a protocol error", (isError) => {
		expect(() => validateCallToolResult({ content: [], isError })).toThrow(McpError);
	});

	it("keeps a boolean isError and allows it absent", () => {
		expect(validateCallToolResult({ content: [], isError: true }).isError).toBe(true);
		expect(validateCallToolResult({ content: [] })).not.toHaveProperty("isError");
	});
});
