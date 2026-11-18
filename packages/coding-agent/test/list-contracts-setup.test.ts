import "../src/octocode/mcp-host/core-install.ts";
import { type Component, setKeybindings, type TUI, visibleWidth } from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { AuthUrlComponent } from "../src/modes/interactive/components/auth-url.ts";
import { BorderedLoader } from "../src/modes/interactive/components/bordered-loader.ts";
import { ConfigurationSelectorComponent } from "../src/modes/interactive/components/configuration-selector.ts";
import { FirstTimeSetupComponent } from "../src/modes/interactive/components/first-time-setup.ts";
import { folderTrustPrompt, worktreeTrustPrompt } from "../src/modes/interactive/components/folder-trust-prompt.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { SettingsListView } from "../src/modes/interactive/components/settings-list-view.ts";
import { SelectSubmenu } from "../src/modes/interactive/components/settings-submenu.ts";
import { initTheme, theme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

vi.mock("@octocodeai/octocode-common/open-target", () => ({ openTarget: vi.fn(async () => undefined) }));

const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PAGE_DOWN = "\x1b[6~";
const END = "\x1b[F";
const ENTER = "\r";
const tui = { requestRender: vi.fn() } as unknown as TUI;
const text = (component: Component, width = 80) => component.render(width).map(stripAnsi);
const mouse = (type: "press" | "click", y: number) =>
	({
		type,
		button: "left",
		x: 4,
		y,
		screenX: 4,
		screenY: y,
		width: 80,
		height: 40,
		shift: false,
		alt: false,
		ctrl: false,
	}) as const;

/** Press and release on the first rendered line holding `label`. */
function clickOn(component: Component, label: string): void {
	const y = text(component).findIndex((line) => line.includes(label));
	expect(y).toBeGreaterThanOrEqual(0);
	component.handleMouse?.(mouse("press", y));
	component.handleMouse?.(mouse("click", y));
}

/** Every line fits: hint lines are cut, never wrapped. */
function expectFits(component: Component, width: number): void {
	for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
}

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
afterEach(() => vi.clearAllMocks());

describe("dialog contract: trust and setup", () => {
	const folder = { path: "/work/app/web", parent: "/work/app", projectFiles: ["AGENTS.md"] };

	it("folder trust: Not now first and selected, numbered answers, a click never confirms", () => {
		const done = vi.fn();
		const prompt = folderTrustPrompt(folder, done, "/home/ada", 0);
		const lines = text(prompt);
		expect(lines).toContain("› 1. Not now  exit; ask again next time");
		expect(lines.some((line) => line.startsWith("  2. Trust this folder"))).toBe(true);
		expect(lines.join("\n")).toMatch(/enter confirm · \S+ cancel/);
		clickOn(prompt, "Trust this folder");
		clickOn(prompt, "Trust this folder");
		expect(done).not.toHaveBeenCalled();
		expect(prompt.getSelected()).toBe("folder");
		prompt.handleInput("9");
		prompt.handleInput(END);
		prompt.handleInput(DOWN);
		prompt.handleInput(ENTER);
		expect(done).toHaveBeenCalledExactlyOnceWith("refuse");
		expectFits(prompt, 40);
	});

	it("worktree trust: No first, named Trust action, Enter on arrival answers No", () => {
		const done = vi.fn();
		const prompt = worktreeTrustPrompt({ path: "/w/wt", from: "/w/repo" }, done, undefined, 0);
		const lines = text(prompt);
		expect(lines.some((line) => line.startsWith("› 1. No"))).toBe(true);
		expect(lines.some((line) => line.startsWith("  2. Trust this worktree"))).toBe(true);
		expect(lines.join("\n")).not.toMatch(/\bYes\b/);
		prompt.handleInput(ENTER);
		expect(done).toHaveBeenCalledExactlyOnceWith(false);
	});

	it("first-time setup: numbered answers, a number previews a theme, a second click confirms; analytics takes keys only", () => {
		const onThemePreview = vi.fn();
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const setup = new FirstTimeSetupComponent({ onThemePreview, onSubmit, onCancel });
		const lines = text(setup);
		expect(lines.some((line) => line.startsWith("› 1. System"))).toBe(true);
		expect(lines.some((line) => line.startsWith("  3. Light"))).toBe(true);
		expect(lines.join("\n")).not.toContain("skip setup");
		setup.handleInput("2");
		expect(onThemePreview).toHaveBeenLastCalledWith("dark");
		setup.handleInput("k");
		expect(onThemePreview).toHaveBeenCalledTimes(1);
		clickOn(setup, "Light");
		expect(onThemePreview).toHaveBeenLastCalledWith("light");
		clickOn(setup, "Light");
		expect(text(setup).join("\n")).toContain("Share anonymous usage data?");
		clickOn(setup, "Share anonymous usage data (");
		clickOn(setup, "Share anonymous usage data (");
		expect(onSubmit).not.toHaveBeenCalled();
		setup.handleInput("1");
		setup.handleInput(ENTER);
		expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ theme: "light", shareAnalytics: false });
		setup.handleInput(ESC);
		expect(onCancel).toHaveBeenCalledOnce();
	});
});

describe("dialog contract: sign-in", () => {
	it("login dialog: blank under the title, one hint line with Enter first, cut at narrow widths", () => {
		const dialog = new LoginDialogComponent(tui, "openrouter", vi.fn(), "OpenRouter");
		void dialog.showPrompt("Enter OpenRouter API key", "sk-or-...").catch(() => undefined);
		const lines = text(dialog);
		expect(lines.slice(1, 3).map((line) => line.trimEnd())).toEqual(["", " Login to OpenRouter"]);
		const hints = lines.filter((line) => /enter|esc/.test(line));
		expect(hints).toHaveLength(1);
		expect(hints[0]).toMatch(/^ enter submit · \S+ cancel$/);
		expectFits(dialog, 24);
		dialog.handleInput(ESC);
	});

	it("auth URL and loader: the hint stays on one line however narrow", () => {
		const url = new AuthUrlComponent(tui, `https://auth.example.invalid/?${"x".repeat(80)}`);
		const urlLines = text(url, 30);
		expect(urlLines.filter((line) => /click|copy/.test(line))).toHaveLength(1);
		expectFits(url, 30);
		const loader = new BorderedLoader(tui, theme, "Signing in…");
		try {
			const lines = text(loader, 12);
			expect(lines.filter((line) => line.startsWith(" esc"))).toHaveLength(1);
			expect(text(loader).join("\n")).toMatch(/\S+ cancel/);
			expectFits(loader, 12);
		} finally {
			loader.dispose();
		}
	});
});

describe("page contract: settings and configuration", () => {
	const items = () =>
		Array.from({ length: 30 }, (_, i) => ({
			id: `s${i}`,
			label: `setting ${i}`,
			currentValue: "on",
			values: ["on", "off"],
		}));

	it("settings: ⌕ search, a–b/total, ends stop, page = rows, a click only selects", () => {
		const onChange = vi.fn();
		const list = new SettingsListView(items(), 10, onChange, vi.fn(), { search: true });
		const lines = text(list);
		expect(lines[0].startsWith(" ⌕ ")).toBe(true);
		expect(lines.some((line) => /^› setting 0 +on$/.test(line))).toBe(true);
		expect(lines.join("\n")).toContain("1–10/30");
		expect(lines.at(-1)).toMatch(/^ enter\/space change · \S+ move · \S+ close$/);
		list.handleInput(UP);
		expect(list.getSelectedId()).toBe("s0");
		list.handleInput(PAGE_DOWN);
		expect(list.getSelectedId()).toBe("s10");
		clickOn(list, "setting 11");
		clickOn(list, "setting 11");
		expect(list.getSelectedId()).toBe("s11");
		expect(onChange).not.toHaveBeenCalled();
		list.handleInput(ENTER);
		expect(onChange).toHaveBeenCalledExactlyOnceWith("s11", "off");
		expectFits(list, 30);
	});

	it("settings: the empty line names esc clears, hints keep only Esc, Esc clears then closes", () => {
		const onCancel = vi.fn();
		const list = new SettingsListView(items(), 10, vi.fn(), onCancel, { search: true });
		for (const key of "zz") list.handleInput(key);
		const shown = text(list).join("\n");
		expect(shown).toContain('No settings match "zz" · esc clears');
		expect(shown).not.toMatch(/change|move/);
		list.handleInput(ESC);
		expect(onCancel).not.toHaveBeenCalled();
		expect(list.getSearchQuery()).toBe("");
		list.handleInput(ESC);
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it("configuration: the same page, with its scope header and a–b/total", () => {
		const selector = new ConfigurationSelectorComponent({
			entries: [],
			apply: vi.fn(),
			get: vi.fn(),
			onClose: vi.fn(),
			requestRender: vi.fn(),
			projectAvailable: true,
			extraItems: items(),
		});
		const shown = text(selector).join("\n");
		expect(shown).toMatch(/^ ⌕ /m);
		expect(shown).toMatch(/^› setting 0 +on$/m);
		expect(shown).toMatch(/\d+–\d+\/30/);
		expect(shown).not.toMatch(/\(\d+\/30\)/);
		expectFits(selector, 40);
	});

	it("settings submenu: ⌕ filter, empty line, Esc clears then goes back, a second click picks", () => {
		const onSelect = vi.fn();
		const onCancel = vi.fn();
		const options = ["low", "medium", "high"].map((value) => ({ value, label: value, description: `${value} effort` }));
		const menu = new SelectSubmenu("Effort", "", options, "medium", onSelect, onCancel, undefined, {
			searchable: true,
		});
		const lines = text(menu);
		expect(lines.some((line) => line.startsWith(" ⌕ "))).toBe(true);
		expect(lines.some((line) => /^› medium +medium effort$/.test(line))).toBe(true);
		for (const key of "qq") menu.handleInput(key);
		expect(text(menu).join("\n")).toContain('No options match "qq" · esc clears');
		menu.handleInput(ESC);
		expect(onCancel).not.toHaveBeenCalled();
		clickOn(menu, "high effort");
		expect(onSelect).not.toHaveBeenCalled();
		clickOn(menu, "high effort");
		expect(onSelect).toHaveBeenCalledExactlyOnceWith("high");
		menu.handleInput(ESC);
		expect(onCancel).toHaveBeenCalledOnce();
	});
});
