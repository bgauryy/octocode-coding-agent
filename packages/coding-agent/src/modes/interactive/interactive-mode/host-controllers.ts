/**
 * Cohesive controller slices of `InteractiveModeHost`.
 *
 * Grouping related host operations into four typed controllers (`dialogs`, `chrome`, `transcript`, `sessionBinding`)
 * keeps collaborators decoupled from the full host surface while preserving direct method access on the host itself.
 */

import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { AssistantMessage } from "@octocodeai/octocode-ai/compat";
import type { AutocompleteProvider, Component, SlashCommand, TUI } from "@octocodeai/octocode-tui";
import type { AgentSessionEvent } from "../../../core/agent-session.ts";
import type {
	DialogOptions,
	EditorFactory,
	SessionUI,
	WidgetOptions,
	WorkingIndicatorOptions,
} from "../../../core/features/index.ts";
import type { MissingSessionCwdError } from "../../../core/session-cwd.ts";
import type { SessionEntry, UsageEntry } from "../../../core/session-manager.ts";
import type { Theme } from "../../../theme/theme.ts";
import type { ToolStatus } from "../../../utils/tools-manager.ts";
import type { StatusIndicator } from "../components/status-indicator.ts";
import type { BlockedStatus } from "../program-status-reporter.ts";
import type { StatusIndicatorRequest } from "../state/status-slice.ts";
import type { AskView } from "../../../octocode/shared/ask-view.ts";
import type { SessionRenderOptions } from "./session-render-options.ts";
import type { CompactionCostNotice, RenderSessionItem, StatusText } from "./types.ts";

/** A question drawn as a card over a selector: its view (option labels equal the selector's options) and where a typed note goes. */
export interface SelectorCard {
	view: AskView;
	onWriteIn?: (note: string) => void;
}

export interface DialogController {
	disposeActiveSelector(): void;
	hideEditorDialog(): void;
	hideInputDialog(): void;
	hideSelectorDialog(): void;
	promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined>;
	showConfirmDialog(title: string, message: string, opts?: DialogOptions): Promise<boolean>;
	showCustomDialog: SessionUI["custom"];
	showEditorDialog(title: string, prefill?: string, opts?: DialogOptions): Promise<string | undefined>;
	showInputDialog(title: string, placeholder?: string, opts?: DialogOptions): Promise<string | undefined>;
	showSelector(create: (done: () => void) => { component: Component; focus: Component; dispose?: () => void }): void;
	showSelectorDialog(
		title: string,
		options: string[],
		opts?: DialogOptions & { stack?: boolean },
		blocked?: BlockedStatus,
		card?: SelectorCard,
	): Promise<string | undefined>;
}

export interface ChromeController {
	addFeatureTerminalInputListener(
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void;
	clearFeatureTerminalInputListeners(): void;
	clearStatusIndicator(kind?: StatusIndicator["kind"]): void;
	rebindFeatureTerminalInputListeners(): void;
	renderWidgets(): void;
	resetFeatureUI(): void;
	setCustomEditorComponent(factory: EditorFactory | undefined): void;
	setEditorWorkingStatusIndicator(indicator: StatusIndicator | undefined): boolean;
	setFeatureFooter: SessionUI["setFooter"];
	setFeatureHeader: SessionUI["setHeader"];
	setFeatureStatus: SessionUI["setStatus"];
	setFeatureWidget(
		key: string,
		content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
		options?: WidgetOptions,
	): void;
	setWorkingIndicator(options?: WorkingIndicatorOptions): void;
	showError(errorMessage: string): void;
	showFeatureError(source: string, error: string, stack?: string): void;
	showManagedToolStatus(status: ToolStatus): void;
	showStatus(message: StatusText): void;
	showStatusIndicator(request: StatusIndicatorRequest): void;
	showWarning(warningMessage: string): void;
	showWorkingStatusIndicator(): void;
	updateEditorBorderColor(): void;
	updateTerminalTitle(): void;
}

export interface TranscriptController {
	addCacheWarmingUsage(entry: UsageEntry): void;
	addCompactionCostNotice(notice: CompactionCostNotice): void;
	addCustomEntryToChat(entry: Extract<SessionEntry, { type: "custom" }>): void;
	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void;
	loadEarlierFromKey(): void;
	maybeShowCacheMissNotice(message: AssistantMessage): void;
	maybeShowThinkingDropNotice(message: AssistantMessage): void;
	maybeSuggestBugReport(message: AssistantMessage): void;
	rebuildChatFromMessages(): void;
	renderInitialMessages(): void;
	renderSessionEntries(entries: SessionEntry[], options?: SessionRenderOptions): void;
	renderSessionItems(items: readonly RenderSessionItem[], options?: SessionRenderOptions): void;
}

export interface SessionBindingController {
	applyRuntimeSettings(): void;
	bindCurrentSessionFeatures(): Promise<void>;
	createBaseAutocompleteProvider(): AutocompleteProvider;
	createSessionUI(): SessionUI;
	getSlashCommands(includeSkills?: boolean): SlashCommand[];
	handleEvent(event: AgentSessionEvent): Promise<void>;
	rebindCurrentSession(options?: { renderBeforeBind?: boolean }): Promise<void>;
	renderCurrentSessionState(): void;
	setupAutocompleteProvider(): void;
	subscribeToAgent(): void;
}

export interface InteractiveModeControllers {
	readonly dialogs: DialogController;
	readonly chrome: ChromeController;
	readonly transcript: TranscriptController;
	readonly sessionBinding: SessionBindingController;
}

type ControllerTarget = DialogController & ChromeController & TranscriptController & SessionBindingController;

/** Builds the four typed controller views backed by `host`. */
export function createInteractiveModeControllers(host: ControllerTarget): InteractiveModeControllers {
	return {
		dialogs: host,
		chrome: host,
		transcript: host,
		sessionBinding: host,
	};
}
