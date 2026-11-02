import * as crypto from "node:crypto";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../../core/features/index.ts";
import type { StatusTone } from "../../../core/footer-data-provider.ts";
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
	defaultValue: T,
	request: Record<string, unknown>,
	parseResponse: (response: RpcExtensionUIResponse) => T,
): Promise<T> {
	if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

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
			resolve(defaultValue);
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

/**
 * Create an extension UI context that uses the RPC protocol.
 */
export const createExtensionUIContext = (
	output: RpcOutput,
	pendingExtensionRequests: PendingExtensionRequests,
): ExtensionUIContext => ({
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
				...(opts?.permission ? { permission: opts.permission } : {}),
				...(opts?.approval ? { approval: true } : {}),
			},
			(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
		),

	confirm: (title, message, opts) =>
		createDialogPromise(
			output,
			pendingExtensionRequests,
			opts,
			false,
			{ method: "confirm", title, message, timeout: opts?.timeout, ...(opts?.approval ? { approval: true } : {}) },
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

	async editor(title: string, prefill?: string): Promise<string | undefined> {
		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			pendingExtensionRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					if ("cancelled" in response && response.cancelled) {
						resolve(undefined);
					} else if ("value" in response) {
						resolve(response.value);
					} else {
						resolve(undefined);
					}
				},
				reject,
			});
			output({ type: "extension_ui_request", id, method: "editor", title, prefill });
		});
	},

	addAutocompleteProvider(): void {
		// Autocomplete provider composition is not supported in RPC mode
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
