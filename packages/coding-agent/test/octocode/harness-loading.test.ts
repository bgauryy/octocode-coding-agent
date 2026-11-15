import { TuiAltScreen } from "@octocodeai/octocode-tui";
import type { ExtensionUIContext } from "../../src/core/features/index.ts";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { registerHarnessCommand } from "../../src/octocode/harness/command.ts";
import * as inventory from "../../src/octocode/harness/inventory.ts";
import { HarnessPicker } from "../../src/octocode/harness/picker.ts";
import type { HooksView } from "../../src/octocode/hooks/register/types.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { initTheme, theme } from "../../src/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

beforeAll(() => initTheme("dark"));
afterEach(() => vi.restoreAllMocks());
const hooks: HooksView = {
	promptSection: () => "",
	hasFilePermissionRequest: () => false,
	fileInputCommitted: () => {},
	permissionRequest: async () => undefined,
	testRun: async () => "",
	summary: () => "",
	report: () => "",
	hasPreToolUse: () => false,
	preToolUse: async () => undefined,
	notification: () => {},
	messageSend: async () => undefined,
	messageReceive: async () => {},
};
const empty = (): inventory.Inventory => ({ items: [], stale: [], ignored: [], notes: [] });
const rendered = (view: HarnessPicker) => stripAnsi(view.render(80).join("\n"));

function fixture() {
	const fake = fakeHost(),
		commands = new Subcommands();
	registerHarnessCommand(commands, hooks, fake.api);
	const ctx = fakeCtx({ cwd: tmp(), mode: "tui" });
	Object.assign(ctx, { isProjectTrusted: () => true });
	return { command: commands.get("harness")!, ctx };
}

it("opens loading immediately, offers retry after failure, then shows empty sections", async () => {
	const build = vi
		.spyOn(inventory, "buildInventory")
		.mockRejectedValueOnce(new Error("skills folder unavailable"))
		.mockResolvedValue(empty());
	const { command, ctx } = fixture();
	Object.assign(ctx.ui, {
		custom: async (factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
			const tui = new TuiAltScreen(new VirtualTerminal(80, 24));
			vi.spyOn(tui, "requestRender").mockImplementation(() => {});
			const view = await factory(tui, theme, new KeybindingsManager(), () => {});
			if (!(view instanceof HarnessPicker)) throw new Error("Expected harness picker");
			expect(rendered(view)).toContain("Loading skills");
			await vi.waitFor(() => expect(rendered(view)).toContain("skills folder unavailable"));
			view.handleInput("\x12");
			await vi.waitFor(() => expect(rendered(view)).toContain("Skills (0)"));
			expect(build).toHaveBeenCalledTimes(2);
			view.handleInput("\x1b");
		},
	});
	await command.handler("", ctx);
});

it.each(["escape", "replacement"])(
	"does not redraw or reopen a picker closed by %s before inventory finishes",
	async (close) => {
		let resolve!: (value: inventory.Inventory) => void;
		const pending = new Promise<inventory.Inventory>((done) => {
			resolve = done;
		});
		vi.spyOn(inventory, "buildInventory").mockReturnValue(pending);
		const { command, ctx } = fixture();
		const tui = new TuiAltScreen(new VirtualTerminal(80, 24));
		const redraw = vi.spyOn(tui, "requestRender").mockImplementation(() => {});
		Object.assign(ctx.ui, {
			custom: async (factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
				const view = await factory(tui, theme, new KeybindingsManager(), () => {});
				if (!(view instanceof HarnessPicker)) throw new Error("Expected harness picker");
				if (close === "escape") view.handleInput("\x1b");
			},
		});
		await command.handler("", ctx);
		const before = redraw.mock.calls.length;
		resolve(empty());
		await pending;
		await Promise.resolve();
		expect(redraw).toHaveBeenCalledTimes(before);
	},
);
