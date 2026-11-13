import os from "node:os";
import { Connected, shallowEqual } from "@octocodeai/octocode-tui";
import { createStore } from "zustand/vanilla";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import type { StatusEntry } from "../../core/footer-data-provider.ts";
import { chipStore } from "../permission/chip-store.ts";
import { autoCompactAt, compactionThinking } from "../shared/tokens.ts";
import { addReply, emptyTotals, modelLookup, type Spend, spendOf, unpricedModel } from "../shared/util.ts";
import { SpendScan } from "../shared/spend.ts";
import { registerFallbackNotice, registerReasoningNotice, registerUnpricedNotice } from "./footer/notices.ts";
import { type FooterState, footerLines } from "./footer/rows.ts";

export { contextBar, type FooterState, footerLines } from "./footer/rows.ts";

const isCompaction = (entry: unknown): boolean =>
	typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "compaction";

/**
 * Replaces Octocode's footer with `footerLines`. The state is sampled on events (session start, each finished message,
 * model and thinking changes, compaction, tree moves), never inside render: context usage walks the whole session.
 * The state lives in a store and the footer is a `Connected` view of it, the permission chip, the git branch and the
 * statuses: Octocode repaints on every streamed token, and a frame whose selection is unchanged reuses its lines. It also
 * warns once when a reply's model has no pricing, and when the model declares no reasoning that a built-in twin declares.
 */
export function registerFooter(api: ExtensionAPI): void {
	registerUnpricedNotice(api);
	registerReasoningNotice(api);
	registerFallbackNotice(api);
	const store = createStore<FooterState>()(() => ({ usage: emptyTotals(), cwd: process.cwd(), home: os.homedir() }));
	// Each event changes the state in one commit, so it asks for one frame however many fields it touched.
	let pending: Partial<FooterState> = {};
	const set = (patch: Partial<FooterState>) => {
		pending = { ...pending, ...patch };
	};
	const commit = () => {
		const patch = pending;
		pending = {};
		if (Object.keys(patch).length > 0) store.setState(patch);
	};
	const setRunning = (running: boolean) => {
		set({ running });
		commit();
	};
	const scan = new SpendScan();
	/** Compaction entries among those the scan has read (`appended`), so counting them never reads the session again. */
	let compactions = 0;
	const addEntry = (entry: unknown, ctx: ExtensionContext) => add(scan.entry(entry), ctx);
	/**
	 * Spend recorded outside a reply (a compaction summary, a cache refresh, a side question) since the last look, by the
	 * rule of `SpendScan.recorded`: only `usage` entries, each once.
	 */
	const addRecorded = (ctx: ExtensionContext) => {
		const { restart, entries } = scan.appended(ctx.sessionManager);
		if (restart) compactions = 0;
		for (const entry of entries) {
			if (isCompaction(entry)) compactions++;
			for (const spend of scan.recorded([entry])) add(spend, ctx);
		}
	};
	const countCompactions = () => {
		set({ compactions });
	};
	const add = (spend: Spend | undefined, ctx: ExtensionContext) => {
		if (!spend) return;
		// A new object: the store's subscribers compare totals by identity.
		const usage = { ...(pending.usage ?? store.getState().usage) };
		addReply(usage, spend.usage, unpricedModel(spend, modelLookup(ctx)) !== undefined);
		set({ usage });
	};
	const sample = (ctx: ExtensionContext) => {
		const model = ctx.model;
		const usage = ctx.getContextUsage();
		const limit = model ? autoCompactAt(model, compactionThinking(api)) : usage?.contextWindow;
		set({
			model: model?.id,
			provider: model?.provider,
			subscription: model ? ctx.modelRegistry.billedBySubscription(model.provider) : false,
			kind: model ? ctx.modelRegistry.getProviderKind(model.provider) : undefined,
			thinking: model?.reasoning ? api.getThinkingLevel() : undefined,
			context: limit
				? { percent: typeof usage?.tokens === "number" ? (usage.tokens / limit) * 100 : null, limit }
				: undefined,
			cwd: ctx.cwd,
			sessionName: ctx.sessionManager.getSessionName?.(),
		});
	};
	// The footer is a terminal component (setFooter does nothing over RPC), so its bookkeeping runs only in the TUI.
	const refresh = async (_event: unknown, ctx: ExtensionContext) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		sample(ctx);
		commit();
	};

	api.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		set({ running: false, usage: emptyTotals() });
		scan.reset();
		compactions = 0;
		for (const entry of scan.appended(ctx.sessionManager).entries) {
			if (isCompaction(entry)) compactions++;
			addEntry(entry, ctx);
		}
		countCompactions();
		sample(ctx);
		commit();
		ctx.ui.setFooter((tui, theme, data) => {
			// A host without footer state gives texts only: wrap them once per change of the host's map.
			let wrapped: { from: ReadonlyMap<string, string>; entries: ReadonlyMap<string, StatusEntry> } | undefined;
			const statuses = (): ReadonlyMap<string, StatusEntry> => {
				const state = data.getState?.();
				if (state) return state.statuses;
				const from = data.getExtensionStatuses();
				if (wrapped?.from !== from)
					wrapped = { from, entries: new Map([...from].map(([name, text]) => [name, { text }] as const)) };
				return wrapped.entries;
			};
			// Branch and status changes come with a frame the host asks for; render notices them by comparing.
			let shown: { branch: string | null; statuses: ReadonlyMap<string, StatusEntry> } | undefined;
			const view = new Connected({
				source: {
					getState: () => ({ ...store.getState(), chip: chipStore.getState().chip }),
					subscribe: (listener) => {
						const stops = [store.subscribe(listener), chipStore.subscribe(listener)];
						return () => {
							for (const stop of stops) stop();
						};
					},
				},
				select: (state) => state,
				view: (footer, width) => footerLines(footer, shown?.branch ?? null, shown?.statuses ?? new Map(), theme, width),
				requestRender: () => tui.requestRender(),
				equals: shallowEqual,
			});
			return {
				render: (width: number) => {
					const next = { branch: data.getGitBranch(), statuses: statuses() };
					if (!shown || !shallowEqual(next, shown)) {
						shown = next;
						view.invalidate();
					}
					return view.render(width);
				},
				invalidate: () => view.invalidate(),
				dispose: () => {
					view.dispose();
					setRunning(false);
				},
			};
		});
	});
	api.on("message_end", async (event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		add(spendOf(event.message), ctx);
		// Context usage walks the session: only a reply changes it. A subagent's result or report only adds usage.
		if (event.message.role === "assistant") {
			addRecorded(ctx);
			sample(ctx);
		}
		commit();
	});
	api.on("session_tree", async (event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		addEntry(event.summaryEntry, ctx);
		await refresh(event, ctx);
	});
	api.on("model_select", refresh);
	api.on("thinking_level_select", refresh);
	api.on("session_compact", async (event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		addEntry(event.compactionEntry, ctx);
		addRecorded(ctx);
		countCompactions();
		await refresh(event, ctx);
	});
	api.on("agent_start", async (_event, ctx) => {
		if (ctx.hasUI && ctx.mode === "tui") setRunning(true);
	});
	api.on("agent_settled", async () => setRunning(false));
	api.on("session_shutdown", async () => setRunning(false));
	api.on("agent_end", async (event, ctx) => {
		if (ctx.hasUI && ctx.mode === "tui") addRecorded(ctx);
		await refresh(event, ctx);
	});
	api.on("session_info_changed", refresh);
}
