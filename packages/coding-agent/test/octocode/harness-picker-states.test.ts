import { beforeAll, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { HarnessPicker } from "../../src/octocode/harness/picker.ts";
import type { InventoryItem } from "../../src/octocode/harness/inventory.ts";
import { initTheme, theme } from "../../src/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

beforeAll(() => initTheme("dark"));
const item = (index: number): InventoryItem => ({
	id: `skill:${index}`,
	kind: "skill",
	host: "skills",
	depth: 0,
	label: `Skill ${index}`,
	on: true,
	detail: `Project · .agents/skills/skill-${index}/SKILL.md`,
});
const text = (picker: HarnessPicker, width = 80) => stripAnsi(picker.render(width).join("\n"));
function fixture(items: InventoryItem[] = [], extra = {}) {
	const apply = vi.fn(() => "Saved");
	const done = vi.fn();
	const picker = new HarnessPicker(
		{
			items,
			apply,
			paths: { global: "~/settings.json", project: ".octocode/settings.json" },
			height: 20,
			done,
			requestRender: vi.fn(),
			section: "skills",
			...extra,
		},
		theme,
		new KeybindingsManager(),
	);
	return { picker, apply, done };
}

it("shows peer Skills, MCPs and Hooks sections even when they are empty", () => {
	const { picker } = fixture();
	expect(text(picker)).toContain("Skills (0)");
	expect(text(picker)).toContain("MCPs (0)");
	expect(text(picker)).toContain("Hooks (0)");
});

it("keeps hints and the selected row visible after terminal height changes", () => {
	let height = 34;
	const { picker } = fixture(
		Array.from({ length: 70 }, (_, i) => item(i)),
		{ height: () => height },
	);
	picker.render(80);
	for (let i = 0; i < 35; i++) picker.handleInput("\x1b[B");
	height = 14;
	expect(picker.render(80).length).toBeLessThanOrEqual(height);
	expect(text(picker)).toContain("Skill 35");
	expect(text(picker)).toMatch(/close/i);
	height = 8;
	expect(picker.render(32).length).toBeLessThanOrEqual(height);
	expect(text(picker, 32)).toContain("Skill 35");
	expect(text(picker, 32)).toContain("close");
});

it("opens complete scrollable details without changing a switch", () => {
	const long = item(0);
	long.detail = "SOURCE_START " + "long configuration detail ".repeat(45) + " SOURCE_END";
	const { picker, apply, done } = fixture([long]);
	picker.handleInput("\x1bOQ");
	expect(text(picker)).toContain("SOURCE_START");
	for (let i = 0; i < 8; i++) picker.handleInput("\x1b[6~");
	expect(text(picker)).toContain("SOURCE_END");
	expect(apply).not.toHaveBeenCalled();
	picker.handleInput("\x1b");
	expect(done).not.toHaveBeenCalled();
});

it("shows loading and error states without switching stale items", () => {
	const { picker, apply } = fixture([item(0)], { state: "loading" });
	expect(text(picker)).toMatch(/Loading.*skills.*MCPs.*hooks/i);
	picker.handleInput("\r");
	expect(apply).not.toHaveBeenCalled();
});

it("retries errors and navigates empty sections without changing switches", () => {
	const retry = vi.fn();
	const { picker, apply } = fixture([], { state: "error", error: "Cannot read settings.json", retry });
	expect(text(picker)).toContain("Cannot read settings.json");
	picker.handleInput("\x12");
	expect(retry).toHaveBeenCalledOnce();
	expect(text(picker)).toContain("Loading skills");
	picker.loaded([item(0)]);
	picker.handleInput("\x1b[1;5C");
	expect(text(picker)).toContain("No MCP servers");
	picker.handleInput("\x1b[1;5C");
	expect(text(picker)).toContain("No hooks found");
	expect(apply).not.toHaveBeenCalled();
});

it("requires a new gate confirmation after changing scope", () => {
	const file: InventoryItem = {
		id: "hook-file:project",
		kind: "hook-file",
		host: "octocode",
		depth: 1,
		label: "Project hooks",
		on: true,
		project: true,
		detail: "1 hook",
	};
	const gate: InventoryItem = {
		id: "hook:gate",
		kind: "hook",
		host: "octocode",
		depth: 2,
		parents: [file.id],
		label: "Gate",
		on: true,
		gate: true,
		project: true,
		detail: "Denies unsafe writes",
	};
	const { picker, apply } = fixture([file, gate], { section: "hooks" });
	picker.handleInput("\x1b[C");
	picker.handleInput("\x1b[B");
	picker.handleInput("\r");
	picker.handleInput("\t");
	picker.handleInput("\r");
	expect(apply).not.toHaveBeenCalled();
});

it("keeps a failed MCP connection visible beside its configured switch", () => {
	const server: InventoryItem = {
		id: "mcp:local",
		kind: "mcp",
		host: "mcp",
		depth: 0,
		label: "local",
		on: true,
		detail: "Project · failed · 0 tools · direct · .octocode/mcp.json",
	};
	const { picker, apply } = fixture([server], { section: "mcp" });
	expect(text(picker)).toMatch(/\[x\] local\s+Project · failed · 0 tools/);
	expect(apply).not.toHaveBeenCalled();
});
