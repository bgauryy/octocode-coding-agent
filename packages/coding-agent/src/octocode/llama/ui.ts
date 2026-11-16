import {
	type Component,
	type Container,
	type Focusable,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	type TUI,
} from "@octocodeai/octocode-tui";
import { sanitizeTerminalText as plain } from "@octocodeai/octocode-common/sanitize";
import type { ExtensionCommandContext } from "../../core/features/types.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { frame, renderClipped, runInView } from "../../theme/framed-view.ts";
import { HintBar, keyText, type RankedHint } from "../../theme/theme-tui-helpers.ts";
import type { Theme } from "../../theme/theme.ts";
import type { LlamaModelInfo, LlamaProgress } from "./client.ts";
import { contextWindowOf } from "./context.ts";
import type { HuggingFaceModel } from "./huggingface.ts";
import { HuggingFaceSearch } from "./ui/huggingface-search.ts";

const DOWNLOAD_VALUE = "\0download";

type LlamaManagerAction = { type: "model"; model: LlamaModelInfo } | { type: "download" } | { type: "close" };

interface ProgressState extends LlamaProgress {
	title: string;
	model: string;
}

/** The spacer and key-hint line that end a view's body. */
function hints(...keys: RankedHint[]): Component[] {
	return [new Spacer(1), new HintBar(keys)];
}

function contextLabel(model: LlamaModelInfo): string | undefined {
	const context = contextWindowOf(model);
	if (context) return context >= 1000 ? `${Math.round(context / 1000)}k` : String(context);
	return undefined;
}

function modelDescription(model: LlamaModelInfo): string {
	const details: string[] = [];
	const loaded = model.status.value === "loaded" || model.status.value === "sleeping";
	if (loaded) details.push("loaded");
	else if (model.status.value !== "unloaded") details.push(model.status.value);
	const context = loaded ? contextLabel(model) : undefined;
	if (context) details.push(`${context} context`);
	return details.join(" · ");
}

function selectTheme(theme: Theme) {
	return {
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("warning", text),
	};
}

export interface LlamaUi {
	showModels(serverUrl: string, models: LlamaModelInfo[]): Promise<LlamaManagerAction>;
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	connectionError(serverUrl: string, message: string): Promise<"retry" | "close">;
	searchModels(
		search: (query: string, signal: AbortSignal) => Promise<HuggingFaceModel[]>,
	): Promise<string | undefined>;
	showStatus(title: string, message: string): void;
	progress(state: ProgressState): Promise<void>;
	updateProgress(state: ProgressState): void;
}

class LlamaView implements LlamaUi, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly searchCache = new Map<string, HuggingFaceModel[]>();
	private content: Container;
	private inputHandler: { handleInput?(data: string): void } | undefined;
	private inputTarget: Focusable | undefined;
	private progressPromise: Promise<void> | undefined;
	private progressResolver: (() => void) | undefined;
	private showingProgress = false;
	private _focused = false;
	private disposed = false;
	/** Settle the open list or search as cancelled. */
	private readonly pending = new Set<() => void>();

	constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.content = frame(theme, "llama.cpp models", [new Text(theme.fg("muted", "Loading…"), 1, 1)]);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.inputTarget) this.inputTarget.focused = value;
	}

	private setContent(
		content: Container,
		inputHandler?: { handleInput?(data: string): void },
		inputTarget?: Focusable,
	): void {
		if (this.disposed) return;
		if (this.inputTarget) this.inputTarget.focused = false;
		this.progressPromise = undefined;
		this.progressResolver = undefined;
		this.showingProgress = false;
		this.content = content;
		this.inputHandler = inputHandler;
		this.inputTarget = inputTarget;
		if (this.inputTarget) this.inputTarget.focused = this._focused;
		this.tui.requestRender();
	}

	showModels(serverUrl: string, models: LlamaModelInfo[]): Promise<LlamaManagerAction> {
		const sorted = [...models].sort((left, right) => {
			const loaded = Number(right.status.value === "loaded") - Number(left.status.value === "loaded");
			return loaded || left.id.localeCompare(right.id);
		});
		const byId = new Map(sorted.map((model) => [model.id, model]));
		const items: SelectItem[] = [
			...sorted.map((model) => ({
				value: model.id,
				label: model.id,
				description: modelDescription(model),
			})),
			{ value: DOWNLOAD_VALUE, label: "Download model…", description: "Hugging Face owner/repository[:quant]" },
		];
		return this.wait<LlamaManagerAction>({ type: "close" }, (resolve) => {
			const list = new SelectList(items, Math.min(items.length, 12), selectTheme(this.theme), {
				minPrimaryColumnWidth: 36,
				maxPrimaryColumnWidth: 56,
			});
			list.onSelect = (item) => {
				if (item.value === DOWNLOAD_VALUE) resolve({ type: "download" });
				else {
					const model = byId.get(item.value);
					if (model) resolve({ type: "model", model });
				}
			};
			list.onCancel = () => resolve({ type: "close" });
			this.setContent(
				frame(this.theme, "llama.cpp models", [
					new Text(this.theme.fg("dim", plain(serverUrl)), 1, 0),
					new Spacer(1),
					list,
					...hints(
						[keyText("tui.select.confirm"), "load/unload/download", 1],
						[keyText("tui.select.cancel"), "close", 0],
					),
				]),
				list,
			);
		});
	}

	select(title: string, options: string[]): Promise<string | undefined> {
		return this.wait<string | undefined>(undefined, (resolve) => {
			const list = new SelectList(
				options.map((option) => ({ value: option, label: option })),
				Math.min(options.length, 12),
				selectTheme(this.theme),
			);
			list.onSelect = (item) => resolve(item.value);
			list.onCancel = () => resolve(undefined);
			this.setContent(
				frame(
					this.theme,
					// Titles carry server text: model ids and the server's error messages.
					plain(title),
					[
						new Spacer(1),
						list,
						...hints([keyText("tui.select.confirm"), "select", 1], [keyText("tui.select.cancel"), "cancel", 0]),
					],
				),
				list,
			);
		});
	}

	async confirm(title: string, message: string): Promise<boolean> {
		return (await this.select(`${title}\n${message}`, ["No", "Yes"])) === "Yes";
	}

	async connectionError(serverUrl: string, message: string): Promise<"retry" | "close"> {
		const choice = await this.select(`llama.cpp unavailable\n${serverUrl}\n\n${message}`, ["Retry", "Close"]);
		return choice === "Retry" ? "retry" : "close";
	}

	searchModels(
		search: (query: string, signal: AbortSignal) => Promise<HuggingFaceModel[]>,
	): Promise<string | undefined> {
		return this.wait<string | undefined>(undefined, (resolve) => {
			const component = new HuggingFaceSearch(
				this.tui,
				this.theme,
				this.keybindings,
				search,
				this.searchCache,
				resolve,
			);
			this.setContent(
				frame(this.theme, "Download model", [
					new Spacer(1),
					component,
					...hints([keyText("tui.select.confirm"), "select", 1], [keyText("tui.select.cancel"), "back", 0]),
				]),
				component,
				component,
			);
			// Stops a pending search request and its debounce before answering.
			return () => component.dispose();
		});
	}

	showStatus(title: string, message: string): void {
		this.setContent(
			frame(this.theme, plain(title), [new Spacer(1), new Text(this.theme.fg("muted", plain(message)), 1, 0)]),
		);
	}

	/** After `dispose` nobody can ask to stop, so the progress wait stays open until the operation ends. */
	progress(state: ProgressState): Promise<void> {
		if (this.disposed) return new Promise(() => {});
		this.progressPromise ??= new Promise((resolve) => {
			this.progressResolver = resolve;
		});
		this.showingProgress = true;
		this.updateProgress(state);
		return this.progressPromise;
	}

	updateProgress(state: ProgressState): void {
		if (!this.showingProgress || this.disposed) return;
		const body = [
			new Text(this.theme.fg("text", plain(state.model)), 1, 0),
			new Spacer(1),
			// The stage name comes from the server's live updates.
			new Text(this.theme.fg("muted", plain(state.message)), 1, 0),
		];
		if (state.ratio !== undefined) {
			const available = 40;
			const filled = Math.round(Math.max(0, Math.min(1, state.ratio)) * available);
			body.push(
				new Text(
					this.theme.fg(
						"accent",
						`${"█".repeat(filled)}${"─".repeat(available - filled)} ${Math.round(state.ratio * 100)}%`,
					),
					1,
					0,
				),
			);
		}
		if (state.detail) body.push(new Text(this.theme.fg("dim", plain(state.detail)), 1, 0));
		this.content = frame(this.theme, plain(state.title), [...body, ...hints([keyText("tui.select.cancel"), "stop"])]);
		this.inputHandler = undefined;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.progressResolver && this.keybindings.matches(data, "tui.select.cancel")) {
			const resolve = this.progressResolver;
			this.progressPromise = undefined;
			this.progressResolver = undefined;
			resolve();
			return;
		}
		this.inputHandler?.handleInput?.(data);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return renderClipped(this.content, width);
	}

	invalidate(): void {
		this.content.invalidate();
	}

	/**
	 * Something else took the view's place (`runInView`): settle the open list or search as cancelled so the run ends
	 * through its cancel paths. A running load or download is not a request to stop: it continues, and the run ends after it.
	 */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		const cancels = [...this.pending];
		this.pending.clear();
		this.inputHandler = undefined;
		this.progressResolver = undefined;
		this.showingProgress = false;
		for (const cancel of cancels) cancel();
	}

	/**
	 * A wait settled once: by `show`'s answer, or with `cancelled` when the view is disposed, after `show`'s returned
	 * cleanup runs. Once disposed, it answers `cancelled` without showing anything.
	 */
	private wait<T>(cancelled: T, show: (settle: (value: T) => void) => (() => void) | undefined): Promise<T> {
		if (this.disposed) return Promise.resolve(cancelled);
		return new Promise((resolve) => {
			let done = false;
			const settle = (value: T) => {
				if (done) return;
				done = true;
				this.pending.delete(cancel);
				resolve(value);
			};
			// `dispose` calls `cancel` only after `cleanup` is assigned.
			const cancel = () => {
				cleanup?.();
				settle(cancelled);
			};
			const cleanup = show(settle);
			if (!done) this.pending.add(cancel);
		});
	}
}

export async function showLlamaUi(ctx: ExtensionCommandContext, run: (ui: LlamaUi) => Promise<void>): Promise<void> {
	await runInView<LlamaView>(ctx, (tui, theme, keybindings) => new LlamaView(tui, theme, keybindings), run);
}

export async function runWithProgress<T>(
	ui: LlamaUi,
	options: {
		title: string;
		model: string;
		initialMessage: string;
		cancelTitle: string;
		cancelMessage: string;
		run(signal: AbortSignal, update: (progress: LlamaProgress) => void): Promise<T>;
		cancel(): Promise<void>;
	},
): Promise<{ cancelled: true } | { cancelled: false; value: T }> {
	const controller = new AbortController();
	const state: ProgressState = { title: options.title, model: options.model, message: options.initialMessage };
	const settled = options
		.run(controller.signal, (progress) => {
			Object.assign(state, progress);
			ui.updateProgress(state);
		})
		.then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error }),
		);
	let completed = false;
	// `settled` maps rejection to a value, so it never rejects.
	void settled.finally(() => {
		completed = true;
	});

	while (!completed) {
		const outcome = await Promise.race([
			settled.then(() => "settled" as const),
			ui.progress(state).then(() => "stop" as const),
		]);
		if (outcome === "settled") break;
		const stop = await ui.confirm(options.cancelTitle, options.cancelMessage);
		if (!stop || completed) continue;
		try {
			await options.cancel();
		} finally {
			controller.abort(new Error("Cancelled"));
		}
		await settled;
		return { cancelled: true };
	}

	const result = await settled;
	if (!result.ok) throw result.error;
	return { cancelled: false, value: result.value };
}
