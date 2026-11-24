import { Container, getCapabilities, type SettingItem } from "@octocodeai/octocode-tui";
import { SettingsListView } from "./settings-list-view.ts";
import { formatHttpIdleTimeoutMs, HTTP_IDLE_TIMEOUT_CHOICES } from "../../../core/http-dispatcher.ts";
import { CACHE_WARMING_MODES } from "../../../core/settings-manager.ts";
import { DynamicBorder } from "../../../theme/dynamic-border.ts";
import { keyText } from "../../../theme/theme-tui-helpers.ts";
import { applySettingChange } from "./settings-selector/change-handler.ts";
import { addConditionalItems } from "./settings-selector/conditional-items.ts";
import {
	createModelThinkingSubmenu,
	modelSettingKey,
	modelThinkingOverridesSummary,
} from "./settings-selector/model-thinking.ts";
import { ThemeSubmenu } from "./settings-selector/theme-submenu.ts";
import type { SettingsCallbacks, SettingsConfig } from "./settings-selector/types.ts";
import { WarningSettingsSubmenu } from "./settings-selector/warnings-submenu.ts";

export type { SettingsCallbacks, SettingsConfig } from "./settings-selector/types.ts";

/**
 * Main settings selector component.
 */
export class SettingsSelectorComponent extends Container {
	private settingsList: SettingsListView;

	constructor(config: SettingsConfig, callbacks: SettingsCallbacks) {
		super();

		const supportsImages = getCapabilities().images;
		const followUpKey = keyText("app.message.followUp");
		const cycleThinkingKey = keyText("app.thinking.cycle");
		let currentWarnings = { ...config.warnings };
		const currentModelThinkingLevels = { ...config.modelThinkingLevels };
		const defaultModelByValue = new Map(config.availableDefaultModels.map((model) => [modelSettingKey(model), model]));
		const currentDefaultModelKey = defaultModelByValue.has(config.defaultModel) ? config.defaultModel : undefined;
		const currentModelKey = config.currentModel ? modelSettingKey(config.currentModel) : undefined;

		const items: SettingItem[] = [
			{
				id: "steering-mode",
				label: "Steering mode",
				description:
					"Enter while streaming queues steering messages. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
				currentValue: config.steeringMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "follow-up-mode",
				label: "Follow-up mode",
				description: `${followUpKey} queues follow-up messages until agent stops. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.`,
				currentValue: config.followUpMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "transport",
				label: "Transport",
				description: "Preferred transport for providers that support multiple transports",
				currentValue: config.transport,
				values: ["sse", "auto"],
			},
			{
				id: "http-idle-timeout",
				label: "HTTP idle timeout",
				description:
					"Maximum idle gap while waiting for HTTP headers or body chunks. Disable for local models that pause longer than five minutes.",
				currentValue: formatHttpIdleTimeoutMs(config.httpIdleTimeoutMs),
				values: HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => choice.label),
			},
			{
				id: "cache-warming-mode",
				label: "Cache warming",
				description: "off; streaming while the agent runs; idle also between runs while continuation stays profitable",
				currentValue: config.cacheWarmingMode,
				values: [...CACHE_WARMING_MODES],
			},
			{
				id: "hide-thinking",
				label: "Hide thinking",
				description:
					"Collapse thinking to one line (Thought for Ns) instead of showing its text; the thinking toggle key switches",
				currentValue: config.hideThinkingBlock ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "mermaid-rendering",
				label: "Mermaid diagrams",
				description: "Render Mermaid code blocks as Unicode diagrams",
				currentValue: config.mermaidRenderingMode,
				values: ["off", "final", "streaming"],
			},
			{
				id: "cache-miss-notices",
				label: "Cache miss notices",
				description: "Show transcript notices for cache costs and provider recovery diagnostics",
				currentValue: config.showCacheMissNotices ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "collapse-changelog",
				label: "Collapse changelog",
				description: "Show condensed changelog after updates",
				currentValue: config.collapseChangelog ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "quiet-startup",
				label: "Quiet startup",
				description: "Disable verbose printing at startup (header: keep only the startup header)",
				currentValue: String(config.quietStartup),
				values: ["true", "header", "false"],
			},
			{
				id: "install-telemetry",
				label: "Install telemetry",
				description: "Send an anonymous version/update ping after changelog-detected updates",
				currentValue: config.enableInstallTelemetry ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "double-escape-action",
				label: "Double-escape action",
				description: "Action when pressing Escape twice with empty editor",
				currentValue: config.doubleEscapeAction,
				values: ["tree", "fork", "none"],
			},
			{
				id: "tree-filter-mode",
				label: "Tree filter mode",
				description: "Default filter when opening /tree",
				currentValue: config.treeFilterMode,
				values: ["default", "no-tools", "user-only", "labeled-only", "all"],
			},
			{
				id: "warnings",
				label: "Warnings",
				description: "Enable or disable individual warnings",
				currentValue: "configure",
				submenu: (_currentValue, done) =>
					new WarningSettingsSubmenu(
						currentWarnings,
						(warnings) => {
							currentWarnings = warnings;
							callbacks.onWarningsChange(warnings);
						},
						() => done(),
					),
			},
			{
				id: "model-thinking",
				label: "Default thinking level per model",
				description: `Override the default thinking level for specific models. ${cycleThinkingKey} cycles in-session.`,
				currentValue: modelThinkingOverridesSummary(currentModelThinkingLevels),
				submenu: (_currentValue, done) =>
					createModelThinkingSubmenu(
						{
							config,
							callbacks,
							currentModelThinkingLevels,
							defaultModelByValue,
							currentModelKey,
							currentDefaultModelKey,
						},
						done,
					),
			},
			{
				id: "tui-mode",
				label: "TUI mode",
				description: "Interface layout; regular mode uses the terminal's normal scrollback",
				currentValue: config.tuiMode,
				values: ["regular", "fullscreen"],
			},
			{
				id: "fullscreen-exit-output",
				label: "Fullscreen exit output",
				description: "Print the transcript or only a session resume hint when exiting fullscreen mode",
				currentValue: config.fullscreenExitOutput,
				values: ["transcript", "resume-hint"],
			},
			{
				id: "fullscreen-scrollbar",
				label: "Fullscreen scrollbar",
				description: "Scrollbar behavior in fullscreen mode; has no effect in regular mode",
				currentValue: config.fullscreenScrollbar,
				values: ["auto", "always", "hidden"],
			},
			{
				id: "fullscreen-copy-on-select",
				label: "Fullscreen copy on select",
				description: "Automatically copy selected text in fullscreen mode; disable to copy selections with Ctrl+X",
				currentValue: config.fullscreenCopyOnSelect ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "fullscreen-wheel-scroll-lines",
				label: "Fullscreen wheel scrolling",
				description:
					"Lines per mouse-wheel event in fullscreen mode; 'auto' speeds up fast wheel spins where the terminal does not",
				currentValue: String(config.fullscreenWheelScrollLines),
				values: [
					"auto",
					...[...new Set([1, 2, 3, 5, 10, config.fullscreenWheelScrollLines])]
						.filter((lines) => lines !== "auto")
						.sort((a, b) => a - b)
						.map(String),
				],
			},
			{
				id: "theme",
				label: "Theme",
				description: "Color theme for the interface",
				currentValue: config.currentTheme,
				submenu: (currentValue, done) =>
					new ThemeSubmenu(currentValue, config.terminalTheme, config.availableThemes, callbacks, done),
			},
		];

		addConditionalItems(items, config, callbacks, supportsImages);

		this.addChild(new DynamicBorder());

		this.settingsList = new SettingsListView(
			items,
			10,
			(id, newValue) => applySettingChange(callbacks, id, newValue),
			callbacks.onCancel,
			{ search: true },
		);

		this.addChild(this.settingsList);
		this.addChild(new DynamicBorder());
	}

	getSettingsList(): SettingsListView {
		return this.settingsList;
	}
}
