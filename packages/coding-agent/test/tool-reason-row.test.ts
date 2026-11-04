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
});
