import { beforeAll, describe, expect, it } from "vitest";
import { reasonRow } from "../src/modes/interactive/components/tool-execution/reason.ts";
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
});
