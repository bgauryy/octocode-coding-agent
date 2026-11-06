import "../mcp-host.ts";
import { octocodeToolDefinition } from "../../../mcp/test/mcp-preset-tool-fixture.ts";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sanitizeJson, toToolResult } from "../../../mcp/src/presets/octocode/tools.ts";
import { expandKey } from "../../src/octocode/shared/render/text.ts";
import { TEXT_MAX_CHARS } from "../../src/utils/output-budget.ts";
import { rendered, theme } from "./fake-host.ts";
import { noisyPng, pixelSize } from "./helpers.ts";
import { OCTOCODE_MCP_SPEC, octocodeLaunch } from "../../../mcp/src/presets/octocode/launch.ts";
afterEach(() => vi.unstubAllEnvs());
describe("Octocode launch policy", () => {
	it("launches the bundled octocode-mcp with the workspace allowed", () => {
		const launch = octocodeLaunch("/work/app", { OCTOCODE_HOME: "/h/.octocode" }, "/x/octocode-mcp/bin.js");
		expect(launch).toEqual({
			command: process.execPath,
			args: ["/x/octocode-mcp/bin.js"],
			cwd: "/work/app",
			env: {
				WORKSPACE_ROOT: "/work/app",
				ALLOWED_PATHS: "/work/app,/work/app/.octocode/code/session-data,/work/app/.octocode/code/temp/sessions",
			},
		});
		// The real bundled bin resolves (octocode-mcp is a dependency).
		expect(fs.existsSync(octocodeLaunch("/w").args[0])).toBe(true);
	});

	it("keeps Octocode's home state (trust store, credentials, database) out of the readers' roots", () => {
		const home = "/h/.octocode";
		const { env } = octocodeLaunch("/work/app", { OCTOCODE_HOME: home }, "/x/bin.js", ["/skills/review"]);
		const roots = env.ALLOWED_PATHS.split(",");
		expect(roots).toEqual([
			"/work/app",
			"/work/app/.octocode/code/session-data",
			"/work/app/.octocode/code/temp/sessions",
			"/skills/review",
		]);
		expect(roots).not.toContain(home);
		// Spilled output and bash logs, which the model reads back, are under the session folders.
		expect(path.join(home, "pi-trust.json").startsWith(`${roots[1]}${path.sep}`)).toBe(false);
	});

	it("turns off project language-server config for an untrusted project only", () => {
		const trusted = octocodeLaunch("/w", {}, "/x/bin.js", [], true);
		const untrusted = octocodeLaunch("/w", {}, "/x/bin.js", [], false);
		expect(trusted.env).not.toHaveProperty("OCTOCODE_TRUST_PROJECT_LSP_CONFIG");
		expect(untrusted.env.OCTOCODE_TRUST_PROJECT_LSP_CONFIG).toBe("false");
	});

	it("runs the octocode-mcp range of package.json: the dependency and the npx fallback share it", () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../..", "package.json"), "utf8")) as {
			dependencies: Record<string, string>;
		};
		const range = manifest.dependencies["octocode-mcp"];
		expect(OCTOCODE_MCP_SPEC).toBe(`octocode-mcp@${range}`);
		if (/^(file|link):/.test(range))
			expect(() => octocodeLaunch("/w", {}, "")).toThrow("local octocode-mcp build is missing");
		else expect(octocodeLaunch("/w", {}, "")).toMatchObject({ command: "npx", args: ["-y", `octocode-mcp@${range}`] });
	});

	it("refuses the npx fallback in an untrusted project", () => {
		const range = OCTOCODE_MCP_SPEC.slice("octocode-mcp@".length);
		if (/^(file|link):/.test(range)) {
			expect(() => octocodeLaunch("/w", {}, "", [], false)).toThrow("local octocode-mcp build is missing");
		} else {
			expect(() => octocodeLaunch("/w", {}, "", [], false)).toThrow(/npx fallback runs only in a trusted project/);
			expect(octocodeLaunch("/w", {}, "", [], true).command).toBe("npx");
		}
		// An installed server needs no fallback, whatever the trust.
		expect(octocodeLaunch("/w", {}, "/x/bin.js", [], false).args).toEqual(["/x/bin.js"]);
	});
});

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

	it("defines the Octocode tool from the listed tool: name, schema, declared output", async () => {
		const definition = octocodeToolDefinition(tool, binding);
		expect(definition).toMatchObject({
			name: "mcp__octocode__localFetch",
			label: "localFetch",
			description: "Read files",
			exposure: "direct",
			parameters: tool.inputSchema,
		});
		// Only the server's own output schema is declared: no tool name earns one.
		expect(definition).not.toHaveProperty("outputSchema");
		const withOutput = octocodeToolDefinition(
			{ ...tool, title: "Fetch", description: undefined, outputSchema: { type: "object" } },
			binding,
		);
		expect(withOutput).toMatchObject({
			label: "Fetch",
			description: 'Fetch\n\nServer result schema:\n{"type":"object"}',
			outputSchema: { type: "object" },
		});
		expect(withOutput).not.toHaveProperty("annotations");
		expect(octocodeToolDefinition({ name: "x", inputSchema: {} }, binding).description).toBe(
			"MCP tool x from server octocode",
		);
		const out = (await definition.execute("id", { queries: [] }, undefined, undefined, {} as never)) as {
			content: unknown;
		};
		expect(out.content).toEqual([{ type: "text", text: "ok" }]);
	});

	it("resizes an oversized image to the active model's image limit and keeps the coordinate note", async () => {
		const original = noisyPng(512);
		const image = { type: "image" as const, data: original.toString("base64"), mimeType: "image/png" };
		const withImage = { ...binding, call: async () => ({ content: [image] }) };
		const run = async (model: unknown) => {
			const out = (await octocodeToolDefinition(tool, withImage).execute("id", {}, undefined, undefined, {
				model,
			} as never)) as { content: Array<{ type: string; text?: string; data?: string }> };
			return {
				shown: out.content.find((part) => part.type === "image")!,
				note: out.content.find((part) => part.type === "text")!.text!,
			};
		};
		const small = await run({ inputLimits: { images: { resize: { maxWidth: 120, maxHeight: 90 } } } });
		expect(pixelSize(small.shown.data!)).toEqual({ width: 90, height: 90 });
		expect(small.note).toContain("original 512x512, displayed at 90x90");
		expect(fs.readFileSync(/Original saved to (\S+?\.png)\./.exec(small.note)![1])).toEqual(original);
		// A model without image metadata gets the default 1568 px limit, which this image already fits: only the byte budget applies.
		const unknown = await run(undefined);
		expect(pixelSize(unknown.shown.data!)).toEqual({ width: 512, height: 512 });
		expect(
			(await toToolResult("t", { content: [image] }, false, { maxWidth: 60, maxHeight: 60 })).content.map(
				(part) => part.type,
			),
		).toEqual(["image", "text"]);
	}, 120_000); // CPU-bound wasm resize: seconds alone, several times that on a loaded machine

	it("renders a call by what it looks for and a result as a compact block", () => {
		const definition = octocodeToolDefinition(tool, binding);
		const context = (extra: object = {}) =>
			({
				lastComponent: undefined,
				state: {},
				args: {},
				toolCallId: "c",
				invalidate: () => undefined,
				cwd: "/w",
				executionStarted: true,
				argsComplete: true,
				isPartial: false,
				expanded: false,
				showImages: false,
				isError: false,
				...extra,
			}) as never;
		const header = (args: object) => rendered(definition.renderCall!(args, theme, context()));
		expect(header({ queries: [{ path: ".", searchText: "add" }] })).toContain("localFetch(add in .)");
		const batch = header({ queries: [{ path: "a.ts" }, { path: "b.ts" }] });
		expect(batch).toContain("localFetch(2 queries)");
		expect(batch).toContain("a.ts");
		expect(batch).toContain("b.ts");
		expect(header({})).toContain("localFetch");
		const ok = rendered(
			definition.renderResult!(
				{ content: [{ type: "text", text: "line one\nline two" }], details: { tool: "localFetch" } } as never,
				{ expanded: false, isPartial: false },
				theme,
				context(),
			),
		);
		expect(ok).toContain("line one");
		const failed = rendered(
			definition.renderResult!(
				{ content: [{ type: "text", text: "It broke\nwith detail" }], details: { tool: "localFetch" } } as never,
				{ expanded: true, isPartial: false },
				theme,
				context({ isError: true }),
			),
		);
		expect(failed).toContain("It broke");
		expect(failed).toContain("with detail");
	});

	it("summarizes the server's JSON envelope in one line and keeps the payload for the expanded row", () => {
		const definition = octocodeToolDefinition(tool, binding);
		const context = (extra: object = {}) =>
			({
				lastComponent: undefined,
				state: {},
				args: {},
				toolCallId: "c",
				invalidate: () => undefined,
				cwd: "/w",
				executionStarted: true,
				argsComplete: true,
				isPartial: false,
				expanded: false,
				showImages: false,
				isError: false,
				...extra,
			}) as never;
		const show = (payload: object, extra: object = {}, expanded = false) =>
			rendered(
				definition.renderResult!(
					{ content: [{ type: "text", text: JSON.stringify(payload) }], details: { tool: "localFetch" } } as never,
					{ expanded, isPartial: false },
					theme,
					context({ expanded, ...extra }),
				),
			);
		const read = {
			results: [{ index: 0, data: { path: "package.json", content: "1\t{\n2\t}\n3\t", totalLines: 76 } }],
		};
		expect(show(read)).toBe(`  ⎿  package.json · lines 1–3 of 76 (${expandKey()} to expand)`);
		expect(show(read, {}, true)).toContain('"totalLines":76');
		const search = { results: [{ index: 0, data: { matchCount: 29, files: [{ path: "a" }, { path: "b" }] } }] };
		expect(show(search)).toContain("29 matches in 2 files");
		const none = { results: [{ index: 0, status: "empty", data: { matchCount: 0, filesScanned: 4 } }] };
		expect(show(none)).toContain("no matches");
		const listing = { results: [{ index: 0, data: { path: "src", files: [], summary: { files: 8, dirs: 1 } } }] };
		expect(show(listing)).toContain("src · 8 files, 1 dir");
		const error = {
			results: [
				{
					index: 0,
					data: {
						error: `Path '/nonexistent-xyz' is outside allowed directories (allowed: ., ~/.octocode/sessions, ${"~/x/y, ".repeat(20)})`,
					},
				},
			],
		};
		const failed = show(error, { isError: true });
		expect(failed).toContain("Error: Path '/nonexistent-xyz' is outside allowed directories");
		expect(failed).not.toContain('{"results"');
		expect(failed).not.toContain("allowed:");
		expect(show(error, { isError: true }, true)).toContain("allowed:");
	});
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
