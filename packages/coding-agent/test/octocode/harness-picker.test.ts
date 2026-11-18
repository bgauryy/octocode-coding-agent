import { beforeAll, expect, it, vi } from "vitest";
import type { SessionUI } from "../../src/core/features/index.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { registerHarnessCommand } from "../../src/octocode/harness/command.ts";
import * as inventory from "../../src/octocode/harness/inventory.ts";
import type { InventoryItem } from "../../src/octocode/harness/inventory.ts";
import { HarnessPicker } from "../../src/octocode/harness/picker.ts";
import { overviewRows } from "../../src/octocode/harness/overview.ts";
import type { HooksView } from "../../src/octocode/hooks/register/types.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { initTheme, theme } from "../../src/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

beforeAll(() => initTheme("dark"));

const row = (kind: InventoryItem["kind"], id: string, on: boolean, detail = "Project"): InventoryItem => ({
	id,
	kind,
	host: kind === "mcp" ? "mcp" : "skills",
	depth: 0,
	label: id,
	on,
	detail,
});
const items = [
	row("skill", "skill:a", true),
	row("skill", "skill:b", false, "not checked HIGH · Project"),
	row("skill", "skill:c", true, "approved · Project"),
	row("mcp", "mcp:one", true),
];
const text = (picker: HarnessPicker) => stripAnsi(picker.render(80).join("\n"));
const make = (list = items, extra = {}) => {
	const apply = vi.fn(() => "Saved");
	const picker = new HarnessPicker(
		{
			items: list,
			apply,
			paths: { global: "~/settings.json", project: ".octocode/settings.json" },
			height: 20,
			done: vi.fn(),
			requestRender: vi.fn(),
			...extra,
		},
		theme,
		new KeybindingsManager(),
	);
	return { picker, apply };
};

it("opens on the Overview with on/off counts and what waits for /security", () => {
	const { picker } = make();
	const out = text(picker);
	expect(out.indexOf("Overview")).toBeLessThan(out.indexOf("Skills ("));
	expect(out).toMatch(/Skills\s+2 on · 1 off · 1 waiting for \/security/);
	expect(out).toMatch(/MCPs\s+1 on · 0 off/);
	expect(out).toMatch(/Hooks\s+none yet/);
	expect(overviewRows(items).map((entry) => entry.section)).toEqual(["skills", "mcp", "hooks", "sources"]);
});

it("opens the selected section with Enter and never switches an item from the Overview", () => {
	const { picker, apply } = make();
	picker.handleInput("\x1b[B");
	picker.handleInput("\r");
	expect(text(picker)).toContain("[x] mcp:one");
	expect(apply).not.toHaveBeenCalled();
});

it("switches sections with plain arrows while the filter is empty, and keeps Ctrl arrows", () => {
	const { picker } = make();
	picker.handleInput("\x1b[C");
	expect(text(picker)).toContain("skill:a");
	picker.handleInput("\x1b[C");
	expect(text(picker)).toContain("mcp:one");
	picker.handleInput("\x1b[D");
	picker.handleInput("\x1b[D");
	expect(text(picker)).toMatch(/Skills\s+2 on/);
	picker.handleInput("\x1b[1;5D");
	expect(text(picker)).toContain("No harness or plugin sources found");
});

it("leaves arrows to the filter once text is typed", () => {
	const { picker } = make(items, { section: "skills" });
	picker.handleInput("a");
	picker.handleInput("\x1b[C");
	expect(text(picker)).toContain("skill:a");
	expect(text(picker)).not.toContain("mcp:one");
});

it("tells empty sections what to add and where", () => {
	const { picker } = make([], { section: "mcp" });
	expect(text(picker)).toContain("/mcp add");
	expect(text(picker)).not.toContain("Use /mcp to inspect");
});

const hooks = {
	report: () => "HOOK REPORT",
	testRun: async () => "",
} as unknown as HooksView;
async function run(args: string, mode: "tui" | "print") {
	vi.spyOn(inventory, "buildInventory").mockResolvedValue({ items, stale: [], ignored: [], notes: [] });
	const commands = new Subcommands();
	registerHarnessCommand(commands, hooks, fakeHost().api);
	const ctx = fakeCtx({ cwd: tmp(), mode, hasUI: mode === "tui" });
	Object.assign(ctx, { isProjectTrusted: () => true });
	const opened: string[] = [];
	if (mode === "tui")
		Object.assign(ctx.ui, {
			custom: async (factory: Parameters<SessionUI["custom"]>[0]) => {
				const view = await factory({ requestRender() {} } as never, theme, new KeybindingsManager(), () => {});
				if (!(view instanceof HarnessPicker)) throw new Error("Expected harness picker");
				await vi.waitFor(() => expect(text(view)).not.toContain("Loading"));
				opened.push(text(view));
				view.handleInput("\x1b");
			},
		});
	const command = commands.get("harness")!;
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	await command.handler(args, ctx);
	return { opened, ctx, command };
}

it("/harness opens the Overview and /harness mcp opens MCPs", async () => {
	expect((await run("", "tui")).opened[0]).toMatch(/Skills\s+2 on/);
	const { opened } = await run("mcp", "tui");
	expect(opened[0]).toContain("[x] mcp:one");
	expect(opened[0]).not.toContain("skill:a");
});

it("/harness <section> prints that section outside the terminal and completes section names", async () => {
	const { ctx, command } = await run("mcp", "print");
	const printed = ctx.ui.notes.map((note) => note.message).join("\n");
	expect(printed).toContain("mcp:one");
	expect(printed).not.toContain("skill:a");
	expect(command.argumentWords).toEqual(expect.arrayContaining(["overview", "skills", "mcp", "hooks", "sources"]));
});
