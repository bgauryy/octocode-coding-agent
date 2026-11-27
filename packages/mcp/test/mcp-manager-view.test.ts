import { setKeybindings, type TUI } from "@octocodeai/octocode-tui";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../../coding-agent/src/core/keybindings.ts";
import { McpManagerView } from "../src/ui.ts";
import { initTheme, theme } from "../../coding-agent/src/theme/theme.ts";
import { stripAnsi } from "../../coding-agent/src/utils/ansi.ts";

const ESCAPE = "\x1b";
const tui = { requestRender: vi.fn() } as unknown as TUI;

function rendered(view: McpManagerView): string {
	return stripAnsi(view.render(80).join("\n"));
}

describe("MCP manager status screen", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	// #10565
	test("cancels the running operation with the cancel key", () => {
		const view = new McpManagerView(tui, theme, new KeybindingsManager());
		const onCancel = vi.fn();
		view.status("Sign in to issues", "Contacting the authorization server…", onCancel);
		expect(rendered(view)).toContain("cancel");
		view.handleInput(ESCAPE);
		expect(onCancel).toHaveBeenCalledOnce();
	});

	test("ignores the cancel key for operations that cannot be cancelled", () => {
		const view = new McpManagerView(tui, theme, new KeybindingsManager());
		view.status("Sign in to issues", "Connecting…");
		expect(rendered(view)).not.toContain("cancel");
		view.handleInput(ESCAPE);
	});
});

// What runInView's displacement contract asks of the view: settle the wait, drop subscriptions, once.
describe("MCP manager view disposed by whatever takes its slot", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	const menu = () => ({ title: "MCP servers", items: [], confirmLabel: "select", cancelLabel: "close" });

	test("cancels the running sign-in once and settles the redirect prompt", async () => {
		const view = new McpManagerView(tui, theme, new KeybindingsManager());
		const onCancel = vi.fn();
		view.status("Sign in to issues", "Contacting the authorization server…", onCancel);
		view.dispose();
		view.dispose();
		expect(onCancel).toHaveBeenCalledOnce();

		const prompted = new McpManagerView(tui, theme, new KeybindingsManager());
		const redirect = prompted.redirectUrl(
			"Sign in to issues",
			"https://auth.example/authorize",
			new AbortController().signal,
		);
		prompted.dispose();
		expect(await redirect).toBeUndefined();
	});

	test("answers every later wait as cancelled without subscribing or rendering", async () => {
		const view = new McpManagerView(tui, theme, new KeybindingsManager());
		view.dispose();
		const subscribe = vi.fn(() => () => {});
		const requestRender = vi.mocked(tui.requestRender);
		requestRender.mockClear();
		expect(await view.menu(menu, subscribe)).toBeUndefined();
		expect(subscribe).not.toHaveBeenCalled();
		expect(await view.redirectUrl("Sign in", "https://auth.example", new AbortController().signal)).toBeUndefined();
		// A sign-in that reaches its next step after the view closed is cancelled there.
		const onCancel = vi.fn();
		view.status("Sign in to issues", "Connecting…", onCancel);
		expect(onCancel).toHaveBeenCalledOnce();
		expect(requestRender).not.toHaveBeenCalled();
	});

	test("a menu answered before the view closes is not settled again", async () => {
		const view = new McpManagerView(tui, theme, new KeybindingsManager());
		const unsubscribe = vi.fn();
		const answer = view.menu(menu, () => unsubscribe);
		view.handleInput(ESCAPE);
		expect(await answer).toBeUndefined();
		expect(unsubscribe).toHaveBeenCalledOnce();
		view.dispose();
		expect(unsubscribe).toHaveBeenCalledOnce();
	});
});
