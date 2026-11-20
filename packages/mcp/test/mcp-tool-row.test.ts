import { describe, expect, it } from "vitest";
import { formatMcpToolRow, toolSummary } from "../src/inspection.ts";

const tool = (description: string, audit?: object) =>
	({ name: "search", description, inputSchema: { type: "object" }, exposure: "direct", audit }) as never;

describe("tool list rows", () => {
	it("strip description markup instead of showing it", () => {
		const row = formatMcpToolRow(tool("<when>Use when a package is the lead.</when>\nMore text"), true);
		expect(row).toBe("search [direct] — Use when a package is the lead.");
		expect(toolSummary("<when>\nA\n</when>")).toBe("A");
	});

	it("carry no usage stats and no description when none is asked for", () => {
		expect(formatMcpToolRow(tool("Text", { calls: 9 }), true)).not.toContain("(");
		expect(formatMcpToolRow(tool("Text"), false)).toBe("search [direct]");
	});

	it("cut a long description", () => {
		expect(formatMcpToolRow(tool("x".repeat(300)), true).length).toBeLessThan(120);
	});
});
