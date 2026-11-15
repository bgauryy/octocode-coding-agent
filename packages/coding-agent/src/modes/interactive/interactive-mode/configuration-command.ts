/**
 * `/configuration`: no arguments open the selector over the catalog, with arguments the text verbs run on it. Changes go
 * through the session's own settings manager and the MCP owner's live switch, so what can apply now does.
 */

import { type SettingItem, Text } from "@octocodeai/octocode-tui";
import { getMcpSessionStatus, getMcpSwitch, requestMcpReload } from "../../../../../mcp/src/api.ts";
import { getAgentDir } from "../../../config.ts";
import { runConfigWords, splitConfigWords } from "../../../configuration/command.ts";
import { type ConfigCatalog, createConfiguration } from "../../../configuration/index.ts";
import { theme } from "../../../theme/theme.ts";
import { ConfigurationSelectorComponent } from "../components/configuration-selector.ts";
import type { InteractiveModeHost } from "./host.ts";
import { applyLiveSetting } from "./live-settings.ts";
import { createLiveSettingsSelector } from "./settings-selector.ts";

export type ConfigurationHost = Pick<
	InteractiveModeHost,
	| "activeStatusIndicator"
	| "applyFullscreenScrollbarSetting"
	| "chatContainer"
	| "defaultEditor"
	| "editor"
	| "uiStore"
	| "outputPad"
	| "pendingMessagesContainer"
	| "rebuildChatFromMessages"
	| "renderer"
	| "session"
	| "sessionManager"
	| "settingsManager"
	| "setupAutocompleteProvider"
	| "showSelector"
	| "statusContainer"
	| "showStatus"
	| "switchTuiMode"
	| "themeController"
	| "ui"
	| "updateEditorBorderColor"
>;

/** The catalog bound to this session: its settings manager and, when MCP runs, its switch. */
function sessionCatalog(host: ConfigurationHost): ConfigCatalog {
	const events = host.session.resourceLoader.getEventBus?.();
	const mcpSwitch = events ? getMcpSwitch(events) : undefined;
	return createConfiguration({
		cwd: host.sessionManager.getCwd(),
		agentDir: getAgentDir(),
		settings: host.settingsManager,
		projectTrusted: host.settingsManager.isProjectTrusted(),
		live: {
			...(mcpSwitch ? { mcpSwitch } : {}),
			...(events ? { mcpReload: () => requestMcpReload(events), mcpStatus: () => getMcpSessionStatus(events) } : {}),
			applySetting: (key, value) => applyLiveSetting(host, key, value),
		},
	});
}

function print(host: ConfigurationHost, lines: readonly string[], ok: boolean): void {
	const text = lines.map((line) => (ok ? line : theme.fg("error", line))).join("\n");
	host.chatContainer.addChild(new Text(text, 1, 0));
	host.ui.requestRender();
}

/** `/configuration` with no arguments. */
async function showConfigurationSelector(host: ConfigurationHost): Promise<void> {
	const catalog = sessionCatalog(host);
	const entries = await catalog.list();
	host.showSelector((done) => {
		const live: SettingItem = {
			id: "interface",
			label: "Interface and session (applies now)",
			description:
				"Theme, TUI mode, images, steering, thinking levels and other settings that change the running terminal at once.",
			currentValue: "open",
			submenu: (_current, close) => createLiveSettingsSelector(host, () => close()).getSettingsList(),
		};
		const selector = new ConfigurationSelectorComponent({
			entries,
			apply: (op) => catalog.apply(op),
			get: (id) => catalog.get(id),
			onClose: () => {
				done();
				host.ui.requestRender();
			},
			requestRender: () => host.ui.requestRender(),
			projectAvailable: host.settingsManager.isProjectTrusted(),
			extraItems: [live],
		});
		return { component: selector, focus: selector };
	});
}

/** `/configuration <verb> ...`: runs the verb and prints each result; with no words, opens the selector. */
export async function handleConfigurationCommand(host: ConfigurationHost, args: string): Promise<void> {
	const words = splitConfigWords(args);
	if (words.length === 0) return showConfigurationSelector(host);
	const outcome = await runConfigWords(sessionCatalog(host), words, "/configuration");
	print(host, outcome.lines, outcome.ok);
}
