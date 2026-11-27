import "../mcp-host.ts";
import { octocodeToolDefinition } from "../../../mcp/test/mcp-preset-tool-fixture.ts";
import os from "node:os";
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sanitizeJson } from "../../../mcp/src/sanitize.ts";
import { toToolResult } from "../../../mcp/src/tool-result.ts";
import { TEXT_MAX_CHARS } from "../../src/utils/output-budget.ts";
import { noisyPng, pixelSize } from "./helpers.ts";
afterEach(() => vi.unstubAllEnvs());
describe("Octocode tool results and rendering", () => {
	const tool = {
		name: "localFetch",
		description: " Read files ",
		inputSchema: { type: "object" as const },
		annotations: { readOnlyHint: true, title: "x" },
	};
	const binding = {
		namespace: { name: "mcp__octocode" },
		call: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	};

	it("applies the generic path's name and schema rules to the server's tools", () => {
		const odd = octocodeToolDefinition({ name: "odd-tool.v2", inputSchema: {} }, binding);
		expect(odd.name).toBe("mcp__octocode__odd_tool_v2");
		expect(odd.parameters).toMatchObject({ type: "object", properties: {} });
		expect(octocodeToolDefinition(tool, binding).name).toBe("mcp__octocode__localFetch");
		const long = octocodeToolDefinition({ name: "x".repeat(80), inputSchema: { type: "object" } }, binding);
		expect(long.name.length).toBeLessThanOrEqual(64);
	});

	it("gives a page over 20 KB to the model whole: no cut, no marker, non-ASCII intact", async () => {
		const page = `${"- row: héllo wörld — 日本語\n".repeat(1_100)}  next:\n    continueChars: { charOffset: 20000 }\n${"- last row ✓\n".repeat(300)}`;
		expect(Buffer.byteLength(page)).toBeGreaterThan(40 * 1024);
		expect(page.length).toBeLessThan(TEXT_MAX_CHARS);
		const result = await toToolResult(
			"localFetch",
			{
				content: [
					{ type: "text", text: page },
					{ type: "image", data: "aW1n", mimeType: "image/png" },
				],
			},
			false,
		);
		expect(result.content).toEqual([
			{ type: "text", text: page },
			{ type: "image", data: "aW1n", mimeType: "image/png" },
		]);
		expect(result).not.toHaveProperty("structuredContent");
		expect(result).not.toHaveProperty("isError");
	});

	it("spills text over the budget to a file and replaces an oversized image by a note naming its file", async () => {
		const huge = `${"- row: some repository text\n".repeat(12_000)}tail line`;
		expect(Buffer.byteLength(huge)).toBeGreaterThan(300_000);
		const bigImage = "A".repeat(700_000);
		const result = await toToolResult(
			"localSearch",
			{
				content: [
					{ type: "text", text: huge },
					{ type: "image", data: bigImage, mimeType: "image/png" },
					{ type: "image", data: "aW1n", mimeType: "image/png" },
				],
			},
			false,
		);
		const [text, dropped, kept] = result.content as Array<{ type: string; text?: string; data?: string }>;
		expect(text.text!.length).toBeLessThanOrEqual(TEXT_MAX_CHARS);
		expect(text.text).toContain("tail line");
		const textFile = /Full output: (\S+?); search/.exec(text.text!)?.[1];
		expect(fs.readFileSync(textFile!.replace(/^~/, os.homedir()), "utf8")).toBe(huge);
		expect(textFile).toMatch(/mcp_localSearch/);
		expect(dropped).toMatchObject({ type: "text" });
		const imageFile = /Saved to (\S+?)\.\]/.exec(dropped.text!)?.[1];
		expect(fs.statSync(imageFile!).size).toBe(Buffer.from(bigImage, "base64").length);
		expect(kept).toEqual({ type: "image", data: "aW1n", mimeType: "image/png" });
	});

	it("turns other blocks into text, an empty error into a message, and keeps structuredContent only when declared", async () => {
		const linked = await toToolResult("t", { content: [{ type: "audio", data: "", mimeType: "audio/wav" }] }, false);
		expect(linked.content).toHaveLength(1);
		expect(linked.content[0]).toMatchObject({ type: "text" });
		expect(await toToolResult("t", { content: [], isError: true }, false)).toMatchObject({
			isError: true,
			content: [{ type: "text", text: "t failed without a message." }],
		});
		const structured = { content: [{ type: "text" as const, text: "{}" }], structuredContent: { a: 1 } };
		expect((await toToolResult("t", structured, true)).structuredContent).toEqual({ a: 1 });
		expect(await toToolResult("t", structured, false)).not.toHaveProperty("structuredContent");
	});

	// The Octocode server answers with one JSON text block and no separate structured copy.
	it("takes structuredContent from a lone JSON text block when the server sends none", async () => {
		const rows = { results: [{ index: 0, data: { content: "1\tone\u202e\n", totalLines: 1 } }] };
		const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
		const derived = await toToolResult("localFetch", text(JSON.stringify(rows)), true);
		expect(derived.structuredContent).toEqual({
			results: [{ index: 0, data: { content: "1\tone\\u{202e}\n", totalLines: 1 } }],
		});
		expect(derived.isError).toBeUndefined();
		expect(await toToolResult("localFetch", text(JSON.stringify(rows)), false)).not.toHaveProperty("structuredContent");
		for (const other of [text("not json"), text("[1]"), { content: [...text("{}").content, ...text("{}").content] }])
			expect(await toToolResult("localFetch", other, true)).not.toHaveProperty("structuredContent");
		// Too large to keep: no structured copy and no error; the text is capped and saved as any long text is.
		const huge = await toToolResult("localFetch", text(JSON.stringify({ a: "x".repeat(TEXT_MAX_CHARS) })), true);
		expect(huge).not.toHaveProperty("structuredContent");
		expect(huge.isError).toBeUndefined();
		expect(huge.details).toMatchObject({ outputTruncated: true });
	});

	it("gives every Octocode tool the host's shared exposure", () => {
		for (const exposure of ["direct", "hidden"] as const)
			for (const name of ["localFetch", "ghSearchCode", "artifactSearch"])
				expect(octocodeToolDefinition({ ...tool, name }, { ...binding, exposure }).exposure).toBe(exposure);
	});

	it("resizes an oversized image to the active model's image limit and keeps the coordinate note", async () => {
		const original = noisyPng(512);
		const image = { type: "image" as const, data: original.toString("base64"), mimeType: "image/png" };
		const run = async (limits?: { maxWidth: number; maxHeight: number }) => {
			const out = await toToolResult("t", { content: [image] }, false, limits);
			return {
				shown: out.content.find((part) => part.type === "image")!,
				note: out.content.find((part) => part.type === "text")!.text,
			};
		};
		const small = await run({ maxWidth: 120, maxHeight: 90 });
		expect(pixelSize(small.shown.data)).toEqual({ width: 90, height: 90 });
		expect(small.note).toContain("original 512x512, displayed at 90x90");
		expect(fs.readFileSync(/Original saved to (\S+?\.png)\./.exec(small.note)![1])).toEqual(original);
		// Without a limit only the byte budget applies, which this image fits.
		const unknown = await run();
		expect(pixelSize(unknown.shown.data)).toEqual({ width: 512, height: 512 });
		expect(
			(await toToolResult("t", { content: [image] }, false, { maxWidth: 60, maxHeight: 60 })).content.map(
				(part) => part.type,
			),
		).toEqual(["image", "text"]);
	}, 120_000); // CPU-bound wasm resize: seconds alone, several times that on a loaded machine
});

describe("Octocode result size budgets", () => {
	const fileOf = (shown: string) =>
		fs.readFileSync(/Full output: (\S+?); search/.exec(shown)![1].replace(/^~/, os.homedir()), "utf8");
	/** A page like the server's: rows, then the `next` continuation at the very end. */
	const page = (bytes: number, mark: string) =>
		`${"- row: some repository text\n".repeat(Math.ceil(bytes / 28))}next:\n  continueChars: { charOffset: ${mark} }\n`;
	const shown = (result: Awaited<ReturnType<typeof toToolResult>>) => (result.content[0] as { text: string }).text;

	it.each([
		["BMP text", "日".repeat(50_000)],
		["astral text", "😀".repeat(25_000)],
		["short lines", "x\n".repeat(25_000)],
	])("passes a character-bounded page of %s whole", async (_name, body) => {
		const full = `${body}\nnext:\n  continueChars: { charOffset: 50000 }\n`;
		expect(shown(await toToolResult("localFetch", { content: [{ type: "text", text: full }] }, false))).toBe(full);
	});

	it("keeps the character cap above a server page plus its header", () => {
		expect(TEXT_MAX_CHARS).toBeGreaterThan(50_100);
		expect(TEXT_MAX_CHARS).toBeLessThanOrEqual(64_000);
	});

	it("passes a server page of 50,052 bytes (the largest measured) whole", async () => {
		const full = `${"x".repeat(50_000)}\n${"y".repeat(51)}`;
		expect(Buffer.byteLength(full)).toBe(50_052);
		expect(shown(await toToolResult("localFetch", { content: [{ type: "text", text: full }] }, false))).toBe(full);
	});

	it("spills a part over the cap whole: the preview keeps the tail where `next` lives and names the file holding all of it", async () => {
		const huge = page(120_000, "777");
		const result = await toToolResult("localSearch", { content: [{ type: "text", text: huge }] }, false);
		const text = shown(result);
		expect(text.length).toBeLessThanOrEqual(TEXT_MAX_CHARS);
		expect(text).toContain("continueChars: { charOffset: 777 }");
		expect(text).toMatch(/\[… \d+ lines omitted …\]/);
		expect(fileOf(text)).toBe(huge);
	});

	it("reports an oversized structured result as an error and saves complete JSON", async () => {
		const value = { required: "x".repeat(TEXT_MAX_CHARS + 1) };
		const result = await toToolResult(
			"typed",
			{ content: [{ type: "text", text: "success" }], structuredContent: value },
			true,
		);
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toBeUndefined();
		const file = /Full JSON: (.+)\. Request/.exec(shown(result))![1];
		expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(value);
	});
});

describe("Octocode result sanitizing", () => {
	it("shows control and invisible characters as escapes in tool results: text parts and structured content, clean ones untouched", async () => {
		const dirty = "a\u202eb\u{e0041}\u{e0042}c\u001b]0;title\u0007d\u001b[31me\u0000f";
		const result = await toToolResult(
			"localSearch",
			{
				content: [
					{ type: "text", text: dirty },
					{ type: "image", data: "x", mimeType: "image/png" },
				],
				structuredContent: { files: [{ path: "p", text: dirty, n: 1 }] },
			},
			true,
		);
		const shown = "a\\u{202e}b\\u{e0041}\\u{e0042}c\\u{1b}]0;title\\u{7}d\\u{1b}[31me\\u{0}f";
		expect(result.content).toEqual([
			{ type: "text", text: shown },
			{ type: "image", data: "x", mimeType: "image/png" },
		]);
		expect(result.structuredContent).toEqual({ files: [{ path: "p", text: shown, n: 1 }] });
		const clean = { a: ["x", { b: "tab\there\n" }], n: 1 };
		expect(sanitizeJson(clean)).toBe(clean);
		expect(sanitizeJson([dirty, 1, null])).toEqual([shown, 1, null]);
	});

	it("keeps what a file holds visible to the model: ZWJ, BOM, bidi, tag characters and CRLF", async () => {
		const text = '1\tok = "a\u200db"\r\n2\tBOM\ufeffmid\r\n3\tzero\u200bwidth \u202eevil\u202c\n4\ttag\u{e0041}\rend';
		const result = await toToolResult("localFetch", { content: [{ type: "text", text }] }, false);
		expect(result.content).toEqual([
			{
				type: "text",
				text: '1\tok = "a\\u{200d}b"\r\n2\tBOM\\u{feff}mid\r\n3\tzero\\u{200b}width \\u{202e}evil\\u{202c}\n4\ttag\\u{e0041}\\rend',
			},
		]);
		// Nothing raw that steers a terminal is left.
		expect(JSON.stringify(result.content)).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u202a-\u202e\u200b-\u200d\ufeff]/u);
		// Raw CR never stands alone: only the CR of a CRLF pair, which the terminal draws as a line break, is left.
		expect((result.content[0] as { text: string }).text.replaceAll("\r\n", "")).not.toContain("\r");
	});
});
