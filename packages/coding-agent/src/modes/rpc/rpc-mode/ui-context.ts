import * as crypto from "node:crypto";
import { checkedReplies, type Question, type Reply } from "@octocodeai/octocode-contracts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../../core/features/index.ts";
import type { StatusTone } from "../../../core/footer-data-provider.ts";
import { type DialogUi, degrade } from "../../../octocode/ask/degrade.ts";
import { plainTitle, viewOf } from "../../../octocode/ask/question.ts";
import { type Theme, theme } from "../../../theme/theme.ts";
import type {
	RpcExtensionUIDismiss,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "../rpc-types.ts";

/** Writes one protocol object to stdout. */
export type RpcOutput = (obj: RpcResponse | RpcExtensionUIRequest | RpcExtensionUIDismiss | object) => void;

/** Pending extension UI requests waiting for response */
export type PendingExtensionRequests = Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>;

/**
 * Helper for dialog methods with signal/timeout support. A dialog settled by anything but the host's response (its signal
 * aborted, its timeout passed) tells the host to close it with `extension_ui_dismiss`.
 */
function createDialogPromise<T>(
	output: RpcOutput,
	pendingExtensionRequests: PendingExtensionRequests,
	opts: ExtensionUIDialogOptions | undefined,
	defaultValue: T | (() => T),
	request: Record<string, unknown>,
	parseResponse: (response: RpcExtensionUIResponse) => T,
): Promise<T> {
	const dismissed = (): T => (typeof defaultValue === "function" ? (defaultValue as () => T)() : defaultValue);
	if (opts?.signal?.aborted) return Promise.resolve(dismissed());

	const id = crypto.randomUUID();
	return new Promise((resolve, reject) => {
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		const cleanup = () => {
			if (timeoutId) clearTimeout(timeoutId);
			opts?.signal?.removeEventListener("abort", dismiss);
			pendingExtensionRequests.delete(id);
		};

		const dismiss = () => {
			cleanup();
			output({ type: "extension_ui_dismiss", id } satisfies RpcExtensionUIDismiss);
			resolve(dismissed());
		};
		opts?.signal?.addEventListener("abort", dismiss, { once: true });

		if (opts?.timeout) {
			timeoutId = setTimeout(dismiss, opts.timeout);
		}

		pendingExtensionRequests.set(id, {
			resolve: (response: RpcExtensionUIResponse) => {
				cleanup();
				resolve(parseResponse(response));
			},
			reject,
		});
		output({ type: "extension_ui_request", id, ...request });
	});
}

/** What a client's process was started with that changes what it is sent. */
interface RpcUiOptions {
	/** `--rpc-ask`: the client answers `ask` requests, so `ui.ask` exists; otherwise questions reach it as select, confirm and input. */
	ask?: boolean;
}

const cancelledAll = (questions: readonly Question[], cancelled: "declined" | "aborted" | "timeout"): Reply[] =>
	questions.map((question) => ({ id: question.id, cancelled }));

/**
 * `ui.ask` over the RPC protocol: one `ask` request carries the batch, the client's `replies` are checked against the
 * questions (a reply that does not fit is not guessed at: every question is declined), a `cancelled` response declines, and a
 * dialog the host closes (abort, timeout) answers `aborted` or `timeout`. A subagent's approval also sends its permission
 * `header` (`AskOptions.header`), the parent's way to answer it without a dialog (see `subagents/relay.ts`).
 */
const rpcAsk =
	(output: RpcOutput, pending: PendingExtensionRequests): NonNullable<ExtensionUIContext["ask"]> =>
	(questions, opts) =>
		createDialogPromise<Reply[]>(
			output,
			pending,
			opts,
			() => cancelledAll(questions, opts?.signal?.aborted ? "aborted" : "timeout"),
			{
				method: "ask",
				questions,
				...(questions.some((question) => question.type === "approval") ? { approval: true } : {}),
				...(opts?.header ? { header: opts.header } : {}),
				...(opts?.timeout ? { timeout: opts.timeout } : {}),
			},
			(response) =>
				"replies" in response
					? (checkedReplies(questions, response.replies) ?? cancelledAll(questions, "declined"))
					: cancelledAll(questions, "declined"),
		);

/**
 * Create an extension UI context that uses the RPC protocol.
 */
export const createExtensionUIContext = (
	output: RpcOutput,
	pendingExtensionRequests: PendingExtensionRequests,
	options: RpcUiOptions = {},
): ExtensionUIContext => {
	const ui = dialogContext(output, pendingExtensionRequests);
	return {
		...ui,
		// A client that did not declare `ask` gets the questions as select, confirm and input requests, as it always has.
		ask: options.ask
			? rpcAsk(output, pendingExtensionRequests)
			: (questions, opts) => degrade(wireDialogs(output, pendingExtensionRequests, ui), questions, opts),
	};
};

/** The dialogs a client without `ask` answers, and an approval as the `select` request that says it is one. */
const wireDialogs = (
	output: RpcOutput,
	pending: PendingExtensionRequests,
	ui: Pick<ExtensionUIContext, "select" | "confirm" | "input">,
): DialogUi => ({
	...ui,
	approve: async (question, dialog) => {
		const options = question.options ?? [];
		const allowOnce = options.find((option) => option.role === "allow_once");
		const deny = options.find((option) => option.role === "deny");
		const label = await createDialogPromise<string | undefined>(
			output,
			pending,
			dialog,
			undefined,
			{
				method: "select",
				title: plainTitle(question),
				options: options.map((option) => option.label),
				timeout: dialog.timeout,
				approval: true,
				ask: viewOf(question),
				...(allowOnce && deny && question.approval
					? { permission: { ...question.approval, allowOnce: allowOnce.label, rejectOnce: deny.label } }
					: {}),
			},
			(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
		);
		return label === undefined ? undefined : { label };
	},
});

const dialogContext = (output: RpcOutput, pendingExtensionRequests: PendingExtensionRequests): ExtensionUIContext => ({
	select: (title, options, opts) =>
		createDialogPromise(
			output,
			pendingExtensionRequests,
			opts,
			undefined,
			{
				method: "select",
				title,
				options,
				timeout: opts?.timeout,
			},
			(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
		),

	confirm: (title, message, opts) =>
		createDialogPromise(
			output,
			pendingExtensionRequests,
			opts,
			false,
			{ method: "confirm", title, message, timeout: opts?.timeout },
			(r) => ("cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false),
		),

	input: (title, placeholder, opts) =>
		createDialogPromise(
			output,
			pendingExtensionRequests,
			opts,
			undefined,
			{ method: "input", title, placeholder, timeout: opts?.timeout },
			(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
		),

	notify(message: string, type?: "info" | "warning" | "error"): void {
		// Fire and forget - no response needed
		output({
			type: "extension_ui_request",
			id: crypto.randomUUID(),
			method: "notify",
			message,
			notifyType: type,
		});
	},

	onTerminalInput(): () => void {
		// Raw terminal input not supported in RPC mode
		return () => {};
	},

	setStatus(key: string, text: string | undefined, tone?: StatusTone): void {
		// Fire and forget - no response needed
		output({
			type: "extension_ui_request",
			id: crypto.randomUUID(),
			method: "setStatus",
			statusKey: key,
			statusText: text,
			...(tone ? { statusTone: tone } : {}),
		});
	},

	setWorkingMessage(_message?: string): void {
		// Working message not supported in RPC mode - requires TUI loader access
	},

	setWorkingVisible(_visible: boolean): void {
		// Working visibility not supported in RPC mode - requires TUI loader access
	},

	setWorkingIndicator(_options?: WorkingIndicatorOptions): void {
		// Working indicator customization not supported in RPC mode - requires TUI loader access
	},

	setHiddenThinkingLabel(_label?: string): void {
		// Hidden thinking label not supported in RPC mode - requires TUI message rendering access
	},

	setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
		// Only support string arrays in RPC mode - factory functions are ignored
		if (content === undefined || Array.isArray(content)) {
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setWidget",
				widgetKey: key,
				widgetLines: content as string[] | undefined,
				widgetPlacement: options?.placement,
			});
		}
		// Component factories are not supported in RPC mode - would need TUI access
	},

	setFooter(_factory: unknown): void {
		// Custom footer not supported in RPC mode - requires TUI access
	},

	setHeader(_factory: unknown): void {
		// Custom header not supported in RPC mode - requires TUI access
	},

	setTitle(title: string): void {
		// Fire and forget - host can implement terminal title control
		output({
			type: "extension_ui_request",
			id: crypto.randomUUID(),
			method: "setTitle",
			title,
		});
	},

	async custom() {
		// Custom UI not supported in RPC mode
		return undefined;
	},

	pasteToEditor(text: string): void {
		// Paste handling not supported in RPC mode - falls back to setEditorText
		this.setEditorText(text);
	},

	setEditorText(text: string): void {
		// Fire and forget - host can implement editor control
		output({
			type: "extension_ui_request",
			id: crypto.randomUUID(),
			method: "set_editor_text",
			text,
		});
	},

	getEditorText(): string {
		// Synchronous method can't wait for RPC response
		// Host should track editor state locally if needed
		return "";
	},

	editor: (title, prefill, opts) =>
		createDialogPromise(
			output,
			pendingExtensionRequests,
			opts,
			undefined,
			{ method: "editor", title, prefill, timeout: opts?.timeout },
			(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
		),

	addAutocompleteProvider(): void {
		// Autocomplete provider composition is not supported in RPC mode
	},

	onEditorChange(): () => void {
		// The RPC client owns its editor; no change events reach the host.
		return () => {};
	},

	setEditorSuggestion(): void {
		// Ghost text is drawn by the terminal editor only.
	},

	setEditorComponent(): void {
		// Custom editor components not supported in RPC mode
	},

	getEditorComponent() {
		// Custom editor components not supported in RPC mode
		return undefined;
	},

	get theme() {
		return theme;
	},

	getAllThemes() {
		return [];
	},

	getTheme(_name: string) {
		return undefined;
	},

	setTheme(_theme: string | Theme) {
		// Theme switching not supported in RPC mode
		return { success: false, error: "Theme switching not supported in RPC mode" };
	},

	getToolsExpanded() {
		// Tool expansion not supported in RPC mode - no TUI
		return false;
	},

	setToolsExpanded(_expanded: boolean) {
		// Tool expansion not supported in RPC mode - no TUI
	},
});
