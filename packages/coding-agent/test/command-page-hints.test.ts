import "../src/octocode/mcp-host/core-install.ts";
import { setKeybindings } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CommandSelectorComponent } from "../src/modes/interactive/components/command-selector.ts";
import { ConfigurationSelectorComponent } from "../src/modes/interactive/components/configuration-selector.ts";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import { QueueListComponent } from "../src/modes/interactive/components/queue-list.ts";
import { ScopedModelsSelectorComponent } from "../src/modes/interactive/components/scoped-models-selector.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const noop = () => {};
const listSettings = {
	warnings: {},
	defaultModel: "not set",
	availableDefaultModels: [],
	availableThinkingLevels: [],
	modelThinkingLevels: {},
	availableThemes: [],
};
/** Every setting the page does not care about reads as "off", so each row renders. */
const settingsConfig = new Proxy(listSettings, {
	get: (target, key) => (key in target ? target[key as keyof typeof target] : "off"),
}) as unknown as SettingsConfig;

const provider = {
	id: "anthropic",
	name: "Anthropic",
	authType: "api_key" as const,
	authenticated: true,
};

interface Page {
	name: string;
	build: () => { render(width: number): string[] };
	/** Every phrase the hint line must carry, matched case-insensitively against the plain footer text. */
	keys: RegExp[];
}

const MOVE = /(↑|up)/i;
const ESC = /esc\S* (back|close|cancel)/i;
const ENTER = /enter \w+/i;

const PAGES: Page[] = [
	{
		name: "/help command picker",
		build: () => new CommandSelectorComponent("Commands", [{ name: "help", description: "Find" }], noop, noop),
		keys: [MOVE, ENTER, ESC],
	},
	{
		name: "/queue",
		build: () => {
			const queue = new QueueListComponent(noop, noop);
			queue.setRows([{ mode: "steer", text: "hello", notes: [] }]);
			return queue;
		},
		keys: [MOVE, ENTER, ESC],
	},
	{
		name: "/effort",
		build: () => new ThinkingSelectorComponent("low", ["off", "low", "high"], noop, noop, noop),
		keys: [MOVE, ENTER, ESC],
	},
	{
		name: "/fork",
		build: () => new UserMessageSelectorComponent([{ id: "u1", text: "hi", timestamp: "" }], noop, noop),
		keys: [MOVE, ENTER, ESC],
	},
	{
		name: "/tree",
		build: () =>
			new TreeSelectorComponent(
				[
					{
						entry: {
							type: "message",
							id: "u1",
							parentId: null,
							timestamp: "2026-01-01T00:00:00Z",
							message: { role: "user", content: "hi", timestamp: 0 },
						},
						children: [],
					},
				] as never,
				"u1",
				40,
				noop,
				noop,
			),
		keys: [MOVE, ENTER, ESC],
	},
	{
		name: "/resume",
		build: () =>
			new SessionSelectorComponent(
				async () => [],
				async () => [],
				noop,
				noop,
				noop,
				noop,
			),
		keys: [ENTER, ESC],
	},
	{
		name: "/logout",
		build: () => new OAuthSelectorComponent("logout", [provider], noop, noop),
		keys: [MOVE, ENTER, ESC],
	},
	{
		name: "/providers sign-in",
		build: () => new OAuthSelectorComponent("sign-in", [provider], noop, noop),
		keys: [MOVE, ENTER, ESC],
	},
	{
		name: "/configuration",
		build: () =>
			new ConfigurationSelectorComponent({
				entries: [],
				apply: vi.fn(),
				get: vi.fn(),
				onClose: noop,
				requestRender: noop,
				projectAvailable: true,
				extraItems: [{ id: "x", label: "x", currentValue: "on", values: ["on", "off"] }],
			}),
		keys: [MOVE, /enter|space/i, ESC, /search|filter/i],
	},
	{
		name: "/modelsettings interface settings",
		build: () => new SettingsSelectorComponent(settingsConfig, {} as unknown as SettingsCallbacks),
		keys: [MOVE, /enter/i, ESC, /search|filter/i],
	},
	{
		name: "scoped models",
		build: () =>
			new ScopedModelsSelectorComponent(
				{ allModels: [], enabledModelIds: null },
				{ onChange: noop, onPersist: noop, onCancel: noop },
			),
		keys: [ESC],
	},
];

describe("command pages name their keys in the footer hint", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	test.each(PAGES)("$name", async ({ build, keys }) => {
		const page = build();
		await new Promise((resolve) => setTimeout(resolve, 20));
		const text = page.render(100).map(stripAnsi).join("\n");
		for (const key of keys) expect(text, text).toMatch(key);
	});
});
