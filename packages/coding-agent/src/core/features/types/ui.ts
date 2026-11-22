/** UI primitives features use to interact with the user. */

import type {
	AutocompleteProvider,
	Component,
	EditorComponent,
	EditorTheme,
	OverlayHandle,
	OverlayOptions,
	TUI,
} from "@octocodeai/octocode-tui";
import type { Question, Reply } from "@octocodeai/octocode-contracts";
import type { Theme } from "../../../theme/theme.ts";
import type { ReadonlyFooterDataProvider, StatusTone } from "../../footer-data-provider.ts";
import type { KeybindingsManager } from "../../keybindings.ts";
import type { SessionInfo } from "../../session-manager.ts";
import type { SessionPickerOptions } from "../../session-picker.ts";

// UI Context
// ============================================================================

/** An approval's identity as an RPC client receives it on a `select` request, and as a `Question` carries it (`approval`). */
export interface PermissionPrompt {
	toolCallId?: string;
	toolName?: string;
	action?: string;
	/** The exact commands, paths or other effects the host is asking about. */
	targets: string[];
	allowOnce: string;
	rejectOnce: string;
}

/**
 * The structured card the terminal draws for a question (`octocode/ask/question.ts` `viewOf` builds it): a short question,
 * dim metadata, a quoted body, details behind a toggle, options with descriptions and a write-in row.
 */
export interface AskView {
	/** One sentence, drawn bold. */
	question: string;
	/** Dim lines under the question: who asks, from where. */
	meta?: string[];
	/** Quoted text; `collapsible` bodies show `previewLines` (default 3) until expanded. Approved targets are never collapsible. */
	body?: { text: string; label?: string; previewLines?: number; collapsible?: boolean };
	/** The details block (effect, undo, why it asks, risk), shown on demand. */
	notes?: { text: string; tone: "muted" | "warning" }[];
	options: { label: string; description?: string; recommended?: boolean; tone?: "danger" }[];
	/** The option row that opens an inline editor instead of answering at once. */
	writeIn?: { label: string; title: string; placeholder?: string } | false;
	multiSelect?: boolean;
	/** Seconds from the card's start until the host takes the recommended option(s); the card shows the countdown. */
	timeoutSeconds?: number;
}

/**
 * How a custom dialog is answered by a remote client (see `SessionUI.custom`): by one choice or text, or, when it
 * carries `questions`, by one reply per question (a batch or a multi-select).
 */
export type RemoteAnswer<T> = RemoteChoice<T> | RemoteQuestions;

/** A dialog of typed questions: the client draws them and answers with `replies`, checked against them. */
interface RemoteQuestions {
	title: string;
	questions: readonly Question[];
	/** A client has started answering: stop the countdown the dialog runs, if any. */
	hold?(): void;
}

/** A dialog answered by one of its options or by text. */
interface RemoteChoice<T> {
	title: string;
	/** The choices a client may send; each must be answered by `answer({ choice })`. */
	options: string[];
	allowsText?: boolean;
	ask?: AskView;
	answer(answer: { choice: string } | { text: string }): T | undefined;
	/** A client has started answering (`UIPromptTracker.hold`): stop the countdown the dialog runs, if any. */
	hold?(): void;
}

export interface DialogOptions {
	/** AbortSignal to programmatically dismiss the dialog. */
	signal?: AbortSignal;
	/** Timeout in milliseconds. Dialog auto-dismisses with live countdown display. */
	timeout?: number;
	/**
	 * The dialog blocks work that goes on without the user, such as a background subagent's approval. It is reported as
	 * waiting even when no run is active; a picker the user opens themselves is not blocking and is not reported then.
	 */
	blocking?: boolean;
}

/** How `SessionUI.ask` is called. */
export interface AskOptions {
	/** Dismisses the dialogs. */
	signal?: AbortSignal;
	/** The dialogs block work that goes on without the user (as `DialogOptions.blocking`). */
	blocking?: boolean;
	/** Timeout in milliseconds. */
	timeout?: number;
	/**
	 * A subagent's permission header: the one line its parent reads to answer a lone approval without a dialog
	 * (`octocode/permission/header.ts`). A host that relays the question sends it along (an RPC `ask` request's `header`);
	 * it is never shown.
	 */
	header?: string;
	/**
	 * Stops the timer the caller runs over these dialogs, which would dismiss them with a default. A client that starts
	 * answering (`UIPromptTracker.hold`) calls it, so nothing is taken for the person afterwards.
	 */
	hold?: () => void;
}

type WidgetPlacement = "aboveEditor" | "belowEditor";

export interface WidgetOptions {
	/** Where the widget is rendered. Defaults to "aboveEditor". */
	placement?: WidgetPlacement;
}

/** Raw terminal input listener for features. */
type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

/** Working indicator configuration for the interactive streaming loader. */
export interface WorkingIndicatorOptions {
	/** Animation frames. Use an empty array to hide the indicator entirely. Custom frames are rendered verbatim. */
	frames?: string[];
	/** Frame interval in milliseconds for animated indicators. */
	intervalMs?: number;
}

/** Wrap the current autocomplete provider with additional behavior. */
export type AutocompleteProviderFactory = (current: AutocompleteProvider) => AutocompleteProvider;
export type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

/**
 * UI context for features to request interactive UI.
 * Each mode (interactive, RPC, print) provides its own implementation.
 */
export interface SessionUI {
	/** Show a selector and return the user's choice. */
	select(title: string, options: string[], opts?: DialogOptions): Promise<string | undefined>;

	/** Show a confirmation dialog. */
	confirm(title: string, message: string, opts?: DialogOptions): Promise<boolean>;

	/** Show a text input dialog. */
	input(title: string, placeholder?: string, opts?: DialogOptions): Promise<string | undefined>;

	/**
	 * Show a batch of typed questions together and return one `Reply` per question, in order (`Question` and `Reply` are
	 * the contracts' own). Optional: a host that draws questions itself provides it (an RPC client that declared `ask`
	 * with `--rpc-ask`, the terminal, ACP); every other host gets the same questions as `select`, `input` and `confirm`
	 * dialogs. Callers use `octocode/ask/ask.ts`, never this directly. A dismissed question is a `cancelled` reply, not a
	 * rejection.
	 */
	ask?(questions: Question[], opts?: AskOptions): Promise<Reply[]>;

	/** Show a notification to the user. */
	notify(message: string, type?: "info" | "warning" | "error"): void;

	/**
	 * Listen to raw terminal input (interactive mode only), before the focused component. Characters typed in one
	 * terminal read reach the handler one by one before the editor gets any of them, so editor text read in the handler
	 * is the text from before that read. Returns an unsubscribe function.
	 */
	onTerminalInput(handler: TerminalInputHandler): () => void;

	/**
	 * Set status text in the footer/status bar. Pass undefined to clear. Pass plain text and a `tone` instead of
	 * colouring the text: each renderer (terminal footer, RPC client, web view) paints the tone in its own palette.
	 */
	setStatus(key: string, text: string | undefined, tone?: StatusTone): void;

	/** Set the working/loading message shown during streaming. Call with no argument to restore default. */
	setWorkingMessage(message?: string): void;

	/**
	 * Configure the interactive working indicator shown during streaming.
	 *
	 * - Omit the argument to restore the default animated spinner.
	 * - Use `frames: ["●"]` for a static indicator.
	 * - Use `frames: []` to hide the indicator entirely.
	 * - Custom frames are rendered as provided, so features must add their own colors.
	 */
	setWorkingIndicator(options?: WorkingIndicatorOptions): void;

	/** Set a widget to display above or below the editor. Accepts string array or component factory. */
	setWidget(key: string, content: string[] | undefined, options?: WidgetOptions): void;
	setWidget(
		key: string,
		content: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined,
		options?: WidgetOptions,
	): void;

	/** Mount the footer component (Octocode's own, from session start); undefined leaves the footer slot empty.
	 *
	 * The factory receives a FooterDataProvider for data not otherwise accessible:
	 * git branch and feature statuses from setStatus(). Context usage is on
	 * ctx.getContextUsage(), token stats on ctx.sessionManager.getEntries(), model info on ctx.model.
	 */
	setFooter(
		factory:
			| ((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void;

	/** Set a custom header component (shown at startup, above chat), or undefined to restore the built-in header. */
	setHeader(factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined): void;

	/** Set the terminal window/tab title. */
	setTitle(title: string): void;

	/**
	 * Show a custom component with keyboard focus. Resolves with the result passed to `done`, or undefined when the
	 * component is closed without one: another dialog or view took its place, the feature UI was reset (reload or
	 * session replacement), or the mode has no custom UI. The component is disposed when it closes.
	 */
	custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			/** Overlay positioning/sizing options. Can be static or a function for dynamic updates. */
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			/** Called with the overlay handle after the overlay is shown. Use to control visibility. */
			onHandle?: (handle: OverlayHandle) => void;
			/**
			 * Let a remote client (the web workspace, an RPC client) answer this dialog too, as it can a select: first answer
			 * wins and the terminal component is closed through its `done`. `answer` maps the client's choice or text to the
			 * dialog's result, or undefined to refuse it.
			 */
			remote?: RemoteAnswer<T>;
		},
	): Promise<T | undefined>;

	/**
	 * Pick a saved session in the session selector. Resolves with the chosen session, or undefined when cancelled.
	 * Only the interactive terminal implements it; elsewhere it is undefined.
	 */
	pickSession?(options: SessionPickerOptions): Promise<SessionInfo | undefined>;

	/** Set the text in the core input editor. */
	setEditorText(text: string): void;

	/** Show a multi-line editor for text editing. */
	editor(title: string, prefill?: string, opts?: DialogOptions): Promise<string | undefined>;

	/** Stack additional autocomplete behavior on top of the built-in provider. */
	addAutocompleteProvider(factory: AutocompleteProviderFactory): void;

	/** Call `handler` with the editor's text after each change; returns a function that stops it. */
	onEditorChange(handler: (text: string) => void): () => void;

	/**
	 * Show a whole suggested input as ghost text: while the typed text is a prefix of `text` and the cursor is at the end,
	 * the rest shows dimmed and Right or End accepts it. Undefined clears it; an editor without support ignores it.
	 */
	setEditorSuggestion(text: string | undefined): void;

	/**
	 * Set a custom editor component via factory function.
	 * Pass undefined to restore the default editor.
	 *
	 * The factory receives:
	 * - `theme`: EditorTheme for styling borders and autocomplete
	 * - `keybindings`: KeybindingsManager for app-level keybindings
	 *
	 * For full app keybinding support (escape, ctrl+d, model switching, etc.),
	 * extend `CustomEditor` from `@octocodeai/octocode-agent` and call
	 * `super.handleInput(data)` for keys you don't handle.
	 *
	 * @example
	 * ```ts
	 * import { CustomEditor } from "@octocodeai/octocode-agent";
	 *
	 * class VimEditor extends CustomEditor {
	 *   private mode: "normal" | "insert" = "insert";
	 *
	 *   handleInput(data: string): void {
	 *     if (this.mode === "normal") {
	 *       // Handle vim normal mode keys...
	 *       if (data === "i") { this.mode = "insert"; return; }
	 *     }
	 *     super.handleInput(data);  // App keybindings + text editing
	 *   }
	 * }
	 *
	 * ctx.ui.setEditorComponent((tui, theme, keybindings) =>
	 *   new VimEditor(tui, theme, keybindings)
	 * );
	 * ```
	 */
	setEditorComponent(factory: EditorFactory | undefined): void;

	/** Get the currently configured custom editor factory, or undefined when using the default editor. */
	getEditorComponent(): EditorFactory | undefined;

	/** Get the current theme for styling. */
	readonly theme: Theme;

	/** Load a theme by name without switching to it. Returns undefined if not found. */
	getTheme(name: string): Theme | undefined;

	/** Set the current theme by name or Theme object. */
	setTheme(theme: string | Theme): { success: boolean; error?: string };
}
