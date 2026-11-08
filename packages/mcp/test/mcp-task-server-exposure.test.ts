import { describe, expect, it } from "vitest";
import { selectsToolPrefix } from "../../coding-agent/src/core/agent-session/tool-selection.ts";
import type { McpServerEntry } from "../src/config.ts";
import { isDefaultActive, isSelected } from "../src/exposure.ts";

const entry = (name: string, defaultActive?: boolean): McpServerEntry => ({
	name,
	source: "test",
	config: { command: "unused", ...(defaultActive === undefined ? {} : { defaultActive }) },
});

/** The child's host selection: `--tools` entries and `--exclude-tools`, as `SessionToolLoadout.selectsTools` applies them. */
const child = (selection: { allowed?: string[]; excluded?: string[]; modifiers?: string[] }) => ({
	selectsTools: (prefix: string, activeByDefault: boolean) =>
		selectsToolPrefix(prefix, activeByDefault, {
			allowed: selection.allowed,
			excluded: selection.excluded ?? [],
			modifiers: selection.modifiers ?? [],
		}),
});

describe("servers a child's task named", () => {
	// A `+name` child list (the default profile) cannot carry `mcp__alpha__*`, so the task's naming selects the server.
	const relative = child({ modifiers: ["+bash", "+file"] });

	it("selects an opt-in server the child's relative tool list cannot name", () => {
		const alpha = entry("alpha", false);
		expect(isSelected(relative, alpha)).toBe(false);
		expect(isSelected(relative, alpha, new Set(["alpha"]))).toBe(true);
		expect(isSelected(relative, alpha, new Set(["beta"]))).toBe(false);
	});

	it("activates the named server's tools by default; others stay as configured", () => {
		expect(isDefaultActive(entry("alpha", false))).toBe(false);
		expect(isDefaultActive(entry("alpha", false), new Set(["alpha"]))).toBe(true);
		expect(isDefaultActive(entry("beta", false), new Set(["alpha"]))).toBe(false);
		expect(isDefaultActive(entry("gamma"), new Set(["alpha"]))).toBe(true);
	});

	it("still honors an exclusion of the server", () => {
		const excluding = child({ modifiers: ["+bash"], excluded: ["mcp__alpha__*"] });
		expect(isSelected(excluding, entry("alpha", false), new Set(["alpha"]))).toBe(false);
	});
});
