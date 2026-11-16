import { afterEach, describe, expect, it } from "vitest";
import { publishToolRoles, resolveToolRoles } from "../src/roles.ts";
import { convertMcpResult } from "../src/tools.ts";
import { hostOutput } from "../src/host.ts";

/** A JSON page of non-ASCII text: about 15,000 characters, far over 20 KB of UTF-8. */
const page = JSON.stringify({ results: [{ data: { content: "日本語のテキスト".repeat(1_900) } }] });

function saver() {
	const saved: string[] = [];
	return { saved, saveOutput: (data: string | Uint8Array) => (saved.push(String(data)), "/tmp/full.txt") };
}

describe("the model-facing text budget of an MCP result", () => {
	afterEach(() => publishToolRoles(resolveToolRoles([])));

	it("keeps a page whole up to the host text cap for a tool its entry gives a role", async () => {
		expect(Buffer.byteLength(page)).toBeGreaterThan(40 * 1024);
		publishToolRoles(
			resolveToolRoles([
				{ name: "docs", config: { command: "x", roles: { reader: ["read"], search: ["find"], readOnly: ["list"] } } },
			]),
		);
		for (const tool of ["read", "find", "list"]) {
			const { saved, saveOutput } = saver();
			const converted = await convertMcpResult(
				"docs",
				tool,
				{ content: [{ type: "text", text: page }] },
				{ saveOutput },
			);
			expect(converted.content).toEqual([{ type: "text", text: page }]);
			expect(converted.details).toEqual({ server: "docs", tool });
			expect(saved).toEqual([]);
		}
		// Past the cap, a role's text is saved and previewed too, within the cap.
		const huge = "x".repeat(hostOutput().textMaxChars + 1);
		const { saved, saveOutput } = saver();
		const converted = await convertMcpResult(
			"docs",
			"read",
			{ content: [{ type: "text", text: huge }] },
			{ saveOutput },
		);
		const text = (converted.content[0] as { text: string }).text;
		expect(text).toMatch(/\[Output trimmed: .*Full output: \/tmp\/full\.txt/);
		expect(text.length).toBeLessThanOrEqual(hostOutput().textMaxChars);
		expect(saved).toEqual([huge]);
	});

	it("spills a tool without a role at the 20 KB result default, also a same-named tool of another server", async () => {
		publishToolRoles(resolveToolRoles([{ name: "docs", config: { command: "x", roles: { reader: ["read"] } } }]));
		for (const [server, tool] of [
			["docs", "other"],
			["notes", "read"],
		]) {
			const { saved, saveOutput } = saver();
			const converted = await convertMcpResult(
				server,
				tool,
				{ content: [{ type: "text", text: page }] },
				{ saveOutput },
			);
			const text = (converted.content[0] as { text: string }).text;
			expect(text).toMatch(/\[Output trimmed: .*Full output: \/tmp\/full\.txt/);
			expect(Buffer.byteLength(text)).toBeLessThan(21 * 1024);
			expect(converted.details).toMatchObject({ fullOutputPath: "/tmp/full.txt" });
			expect(saved).toEqual([page]);
		}
	});
});

describe("the structuredContent of an MCP result", () => {
	afterEach(() => publishToolRoles(resolveToolRoles([])));

	it("is replaced by a bounded stub pointing to the saved full JSON when over the host text cap", async () => {
		const big = { rows: ["x".repeat(hostOutput().textMaxChars + 1)] };
		const { saved, saveOutput } = saver();
		const converted = await convertMcpResult(
			"notes",
			"dump",
			{ content: [{ type: "text", text: "ok" }], structuredContent: big },
			{ saveOutput },
		);
		expect(saved).toEqual([JSON.stringify(big)]);
		const kept = converted.structuredContent as { content: unknown; structuredContent: Record<string, unknown> };
		expect(JSON.stringify(kept).length).toBeLessThan(hostOutput().textMaxChars);
		expect(kept.content).toEqual([{ type: "text", text: "ok" }]);
		expect(kept.structuredContent).toMatchObject({ truncated: true, fullOutputPath: "/tmp/full.txt" });
	});

	it("stays unchanged when small", async () => {
		const { saved, saveOutput } = saver();
		const result = { content: [{ type: "text" as const, text: "ok" }], structuredContent: { n: 1 } };
		const converted = await convertMcpResult("notes", "dump", result, { saveOutput });
		expect(converted.structuredContent).toEqual(result);
		expect(saved).toEqual([]);
	});
});

describe("the structured content blocks of an MCP result", () => {
	it("are the bounded, sanitized blocks, not the raw server content", async () => {
		const huge = `a\u001b[31m${"x".repeat(1_000_000)}`;
		const { saveOutput } = saver();
		const converted = await convertMcpResult(
			"notes",
			"dump",
			{ content: [{ type: "text", text: huge }] },
			{ saveOutput },
		);
		const json = JSON.stringify(converted.structuredContent);
		expect(json.length).toBeLessThanOrEqual(hostOutput().textMaxChars);
		expect(json).not.toContain("\\u001b");
	});

	it("bound image blocks", async () => {
		const data = "A".repeat(hostOutput().imageBudget() * 4);
		const { saveOutput } = saver();
		const converted = await convertMcpResult(
			"notes",
			"shot",
			{ content: [{ type: "image", data, mimeType: "image/png" }] },
			{ saveOutput },
		);
		expect(JSON.stringify(converted.content).length).toBeLessThan(data.length);
		expect(JSON.stringify(converted.structuredContent).length).toBeLessThanOrEqual(hostOutput().textMaxChars);
	});
});
