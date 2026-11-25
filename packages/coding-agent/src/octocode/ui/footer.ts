import os from "node:os";
import { Connected, shallowEqual } from "@octocodeai/octocode-tui";
import { createStore } from "zustand/vanilla";
import type { FeatureSetup, FeatureContext } from "../../core/features/index.ts";
import type { StatusEntry } from "../../core/footer-data-provider.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { type ProviderQuotas, providerQuotas } from "../../core/model-runtime/quota-request.ts";
import { billingFacts, entryBilling } from "../../core/usage-totals.ts";
import { chipOf } from "../permission/chip-store.ts";
import { limitsModelKey, resolveLimits } from "../../core/limits.ts";
import { autoCompactAt, compactionThinking } from "../shared/tokens.ts";
import {
	addReply,
	emptyTotals,
	entryMessage,
	memoizedModelLookup,
	modelLookup,
	type ModelLookup,
	type Spend,
	spendOf,
	unpricedModel,
} from "../shared/util.ts";
import { SpendScan } from "../shared/spend.ts";
import { liveAgentsOf, reportedAgent } from "../shared/team-spend.ts";
import {
	registerDefaultedModelNotice,
	registerFallbackNotice,
	registerReasoningNotice,
	registerUnpricedNotice,
} from "./footer/notices.ts";
import { githubTokenPresent } from "./footer/github.ts";
import { tightestPlanWindow } from "../shared/quota-text.ts";
import { followSessionActivity } from "../activity/session-activity.ts";
import { type FooterState, footerLines } from "./footer/rows.ts";

export { contextBar, type FooterState, footerLines } from "./footer/rows.ts";

const isCompaction = (entry: unknown): boolean =>
	typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "compaction";

/** The entry a finished message becomes (`entryMessage` the other way round): who paid for it reads as it will once appended. */
function messageEntry(message: unknown): SessionEntry {
	const { role, customType, details } = message as { role?: unknown; customType?: unknown; details?: unknown };
	return (
		role === "custom" ? { type: "custom_message", customType, details } : { type: "message", message }
	) as SessionEntry;
}

/**
 * Mounts the footer, `footerLines`, in the host's footer slot. The state is sampled on events (session start, each finished message,
 * model, thinking and context-size changes, compaction, tree moves), never inside render: context usage walks the whole session.
 * The state lives in a store and the footer is a `Connected` view of it, the permission chip, the live agents the panel
 * publishes (for `Σ`), the git branch and the statuses: a frame whose selection is unchanged reuses its lines. It also
 * warns once when a reply's model has no pricing, and when the model declares no reasoning that a built-in twin declares.
 */
export function registerFooter(api: FeatureSetup, quotas: Pick<ProviderQuotas, "current"> = providerQuotas): void {
	registerUnpricedNotice(api);
	registerReasoningNotice(api);
	registerDefaultedModelNotice(api);
	registerFallbackNotice(api);
	// This session's chip and live agents (a process may host several sessions).
	const chipStore = chipOf(api);
	const liveAgentsStore = liveAgentsOf(api);
	const store = createStore<FooterState>()(() => ({
		usage: emptyTotals(),
		reported: new Set<string>(),
		cwd: process.cwd(),
		home: os.homedir(),
	}));
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
	const addEntry = (entry: unknown, ctx: FeatureContext, find?: ModelLookup) => {
		noteReport(entryMessage(entry));
		add(scan.entry(entry), entry as SessionEntry, ctx, find);
	};
	/** A subagent whose result or report the ledger now holds: `Σ` stops adding its live row (`totalSpend`). */
	const noteReport = (message: unknown) => {
		const id = reportedAgent(message);
		const reported = pending.reported ?? store.getState().reported ?? new Set<string>();
		if (id !== undefined && !reported.has(id)) set({ reported: new Set([...reported, id]) });
	};
	/**
	 * Spend recorded outside a reply (a compaction summary, a cache refresh, a side question) since the last look, by the
	 * rule of `SpendScan.recorded`: only `usage` entries, each once.
	 */
	const addRecorded = (ctx: FeatureContext) => {
		const { restart, entries } = scan.appended(ctx.sessionManager);
		if (restart) compactions = 0;
		for (const entry of entries) {
			if (isCompaction(entry)) compactions++;
			for (const spend of scan.recorded([entry])) add(spend, entry as SessionEntry, ctx);
		}
	};
	const countCompactions = () => {
		set({ compactions });
	};
	const add = (spend: Spend | undefined, entry: SessionEntry, ctx: FeatureContext, find?: ModelLookup) => {
		if (!spend) return;
		// A new object: the store's subscribers compare totals by identity.
		const usage = { ...(pending.usage ?? store.getState().usage) };
		const before = usage.cost;
		addReply(usage, spend.usage, unpricedModel(spend, find ?? modelLookup(ctx)) !== undefined);
		set({ usage });
		// Who paid is what the append stored on the entry, else the judgment every surface shares (`entryBilling`): `/web`,
		// `/usage` and `subagents.maxCost` split the same spend the same way. `Σ (sub)` needs every plan-paid one.
		if (entryBilling(entry, billingFacts(ctx)) === "plan") {
			const plan = pending.planBilled ?? store.getState().planBilled ?? { replies: 0, cost: 0 };
			set({ planBilled: { replies: plan.replies + 1, cost: plan.cost + usage.cost - before } });
		}
	};
	const sample = (ctx: FeatureContext) => {
		const model = ctx.model;
		const usage = ctx.getContextUsage();
		// Usage carries the effective window (including overrides and the latest physical route): the gauge is of that.
		const window = usage?.contextWindow ?? model?.contextWindow;
		const compactAt =
			usage?.compactionThreshold ??
			(model && window
				? autoCompactAt(
						{ ...model, contextWindow: window },
						compactionThinking(api),
						resolveLimits(api.settings.get().limits, limitsModelKey(model)).compaction,
					)
				: undefined);
		// The provider's readings come with each response (`quotaStep`); a plan window near its cap shows (`quotaPart`).
		const quota = model?.provider ? tightestPlanWindow(quotas.current(model.provider)) : undefined;
		set({
			model: model?.id,
			kind: model ? ctx.modelRegistry.getProviderKind(model.provider) : undefined,
			quota: quota && { label: quota.label, usedFraction: quota.usedFraction, resetsAt: quota.resetsAt },
			thinking: model?.reasoning ? api.models.getThinkingLevel() : undefined,
			// A model with no known window still shows the gauge, as `ctx ?`: hiding it reads as nothing to worry about.
			context:
				window && window > 0
					? {
							percent: typeof usage?.tokens === "number" ? (usage.tokens / window) * 100 : null,
							window,
							...(compactAt && compactAt > 0 ? { compactAt } : {}),
						}
					: model
						? { percent: null, window: 0 }
						: undefined,
			cwd: ctx.cwd,
			sessionName: ctx.sessionManager.getSessionName?.(),
			githubToken: githubTokenPresent(),
		});
	};
	// The footer is a terminal component (setFooter does nothing over RPC), so its bookkeeping runs only in the TUI.
	const refresh = async (_event: unknown, ctx: FeatureContext) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		sample(ctx);
		commit();
	};

	/** Stops following the previous session's activity light. */
	let stopActivity: (() => void) | undefined;
	const followActivity = (sessionId: string | undefined) => {
		stopActivity?.();
		stopActivity = undefined;
		if (sessionId === undefined) return;
		stopActivity = followSessionActivity(sessionId, (activity) => {
			set({ activity });
			commit();
		});
	};
	api.bus.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		set({ running: false, usage: emptyTotals(), planBilled: undefined, reported: new Set() });
		followActivity(ctx.sessionManager.getSessionId());
		scan.reset();
		compactions = 0;
		const find = memoizedModelLookup(modelLookup(ctx));
		for (const entry of scan.appended(ctx.sessionManager).entries) {
			if (isCompaction(entry)) compactions++;
			addEntry(entry, ctx, find);
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
				const from = data.getFeatureStatuses();
				if (wrapped?.from !== from)
					wrapped = { from, entries: new Map([...from].map(([name, text]) => [name, { text }] as const)) };
				return wrapped.entries;
			};
			// Branch and status changes come with a frame the host asks for; render notices them by comparing.
			let shown: { branch: string | null; statuses: ReadonlyMap<string, StatusEntry> } | undefined;
			const view = new Connected({
				source: {
					getState: () => ({
						...store.getState(),
						chip: chipStore.getState().chip,
						live: liveAgentsStore.getState().live,
					}),
					subscribe: (listener) => {
						const stops = [
							store.subscribe(listener),
							chipStore.subscribe(listener),
							liveAgentsStore.subscribe(listener),
						];
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
	api.bus.on("message_end", async (event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		noteReport(event.message);
		add(spendOf(event.message), messageEntry(event.message), ctx);
		// Context usage walks the session: only a reply changes it. A subagent's result or report only adds usage.
		if (event.message.role === "assistant") {
			addRecorded(ctx);
			sample(ctx);
		}
		commit();
	});
	api.bus.on("session_tree", async (event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		addEntry(event.summaryEntry, ctx);
		await refresh(event, ctx);
	});
	api.bus.on("model_select", refresh);
	api.bus.on("thinking_level_select", refresh);
	api.bus.on("session_compact", async (event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		addEntry(event.compactionEntry, ctx);
		addRecorded(ctx);
		countCompactions();
		await refresh(event, ctx);
	});
	api.bus.on("agent_start", async (_event, ctx) => {
		if (ctx.hasUI && ctx.mode === "tui") setRunning(true);
	});
	api.bus.on("agent_settled", async () => setRunning(false));
	api.bus.on("session_shutdown", async () => {
		followActivity(undefined);
		setRunning(false);
	});
	api.bus.on("agent_end", async (event, ctx) => {
		if (ctx.hasUI && ctx.mode === "tui") addRecorded(ctx);
		await refresh(event, ctx);
	});
	api.bus.on("session_info_changed", refresh);
	// /context <size>, a reset or an observed capacity change the window without a reply.
	api.bus.on("session_context_changed", refresh);
}
