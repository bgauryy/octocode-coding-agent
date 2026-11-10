import { setKeybindings, type TUI } from "@octocodeai/octocode-tui";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../../coding-agent/src/core/keybindings.ts";
import { McpManagerView } from "../src/ui.ts";
import { initTheme, theme } from "../../coding-agent/src/theme/theme.ts";
import { stripAnsi } from "../../coding-agent/src/utils/ansi.ts";

const tui = { requestRender: vi.fn() } as unknown as TUI;

describe("MCP server list keys", () => {
	beforeAll(() => {
		initTheme("dark");
	});
	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	test("shows a key hint and reports the key with the highlighted server, keeping the list open", async () => {
		const view = new McpManagerView(tui, theme, new KeybindingsManager());
		const onKey = vi.fn();
		const answer = view.menu(() => ({
			title: "MCP servers",
			items: [
				{ value: "alpha", label: "alpha" },
				{ value: "beta", label: "beta" },
			],
			confirmLabel: "open",
			cancelLabel: "close",
			keys: [{ key: "e", label: "enable/disable" }],
			onKey,
		}));
		expect(stripAnsi(view.render(80).join("\n"))).toContain("enable/disable");
		view.handleInput("e");
		expect(onKey).toHaveBeenCalledWith("e", "alpha");
		view.handleInput("\x1b[B");
		view.handleInput("e");
		expect(onKey).toHaveBeenLastCalledWith("e", "beta");
		view.dispose();
		expect(await answer).toBeUndefined();
	});
});
