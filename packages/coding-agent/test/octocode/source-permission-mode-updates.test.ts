import { expect, it } from "vitest";
import { applyRuleUpdates, parsePermissionUpdates } from "../../src/octocode/shared/permission-updates.ts";
const initial = { allow: [], deny: [], ask: [] };
it("applies source mode and directory changes in list order", () => {
	const result = applyRuleUpdates(
		initial,
		parsePermissionUpdates([
			{ type: "setMode", mode: "acceptEdits", destination: "session" },
			{ type: "addDirectories", directories: ["/owned/a", "/owned/b"], destination: "session" },
			{ type: "removeDirectories", directories: ["/owned/a"], destination: "session" },
		]),
		"session",
	);
	expect(result).toEqual({ ...initial, defaultMode: "acceptEdits", additionalDirectories: ["/owned/b"] });
	expect(initial).toEqual({ allow: [], deny: [], ask: [] });
});
it("normalizes manual source mode without changing native modes", () => {
	expect(
		applyRuleUpdates(
			initial,
			parsePermissionUpdates([{ type: "setMode", mode: "manual", destination: "session" }]),
			"session",
		),
	).toEqual({ ...initial, defaultMode: "default" });
});
it("refuses classifier modes before applying preceding deltas", () => {
	expect(() =>
		applyRuleUpdates(
			initial,
			parsePermissionUpdates([
				{ type: "addDirectories", directories: ["/owned"], destination: "session" },
				{ type: "setMode", mode: "auto", destination: "session" },
			]),
			"session",
		),
	).toThrow(/Unsupported/);
	expect(initial).toEqual({ allow: [], deny: [], ask: [] });
});
