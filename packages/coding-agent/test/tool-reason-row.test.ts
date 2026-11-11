import { beforeAll, describe, expect, it } from "vitest";
import { reasonRow } from "../src/octocode/ui/reason-row.ts";
import { setItemTitles } from "../src/octocode/render/item-titles.ts";
import { initTheme } from "../src/theme/theme.ts";

describe("reasonRow", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders the reason of a native tool call", () => {
		const row = reasonRow("bash", { command: "ls", reason: "list the package files" });
		expect(row?.render(80).join("\n")).toContain("list the package files");
	});

	it("shows no row for an extension tool, whose reason argument may mean something else", () => {
		expect(reasonRow("my-extension-tool", { reason: "list the package files" })).toBeUndefined();
	});

	it("shows no row when the call gives no reason", () => {
		expect(reasonRow("bash", { command: "ls" })).toBeUndefined();
	});

	it("shows an MCP call's purpose only from its returned data, never from its arguments", () => {
		const args = { queries: [{ path: "a", mainGoal: "from the input" }], reason: "copied from a native tool" };
		expect(reasonRow("mcp__octocode__localFetch", args)).toBeUndefined();
		expect(
			reasonRow("mcp__octocode__localFetch", args, { content: [], structuredContent: { results: [] } }),
		).toBeUndefined();
		const returned = { content: [], structuredContent: { results: [{ data: { mainGoal: "trace the parser" } }] } };
		expect(reasonRow("mcp__octocode__localFetch", args, returned)?.render(80).join("\n")).toContain("trace the parser");
	});

	it("draws a backlog ID with its title in a native reason only, never in a server's returned purpose", () => {
		setItemTitles(new Map([["B92", "Clickable IDs"]]));
		try {
			const native = reasonRow("bash", { command: "ls", reason: "Close B92: x" })?.render(80).join("\n");
			expect(native).toContain("Close B92 “Clickable IDs”: x");
			const returned = { content: [], structuredContent: { results: [{ data: { mainGoal: "Close B92: x" } }] } };
			const external = reasonRow("mcp__octocode__localFetch", {}, returned)?.render(80).join("\n");
			expect(external).toContain("Close B92: x");
			expect(external).not.toContain("Clickable");
		} finally {
			setItemTitles(new Map());
		}
	});
	it("returns the same rows for the same width until it is invalidated, and new ones for another width", () => {
		const row = reasonRow("bash", { command: "ls", reason: "a reason long enough to be cut at a narrow width" })!;
		const wide = row.render(80);
		expect(row.render(80)).toBe(wide);
		const narrow = row.render(20);
		expect(narrow).not.toBe(wide);
		expect(narrow[0]).not.toBe(wide[0]);
		row.invalidate();
		const again = row.render(20);
		expect(again).not.toBe(narrow);
		expect(again).toEqual(narrow);
	});
});
