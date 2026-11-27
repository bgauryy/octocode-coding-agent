import type { ProviderPlan } from "@octocodeai/octocode-ai";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { createStore, type StoreApi } from "zustand/vanilla";
import { AGENT_RESULT_TYPE } from "./messages.ts";
import { spendOf, type TokenTotals } from "./util.ts";

/**
 * What a live descendant adds to the total: its own replies (`Member.cost` never holds its children's), and who pays
 * for them (`runBilling` of its model, as `subagents.maxCost` judges it): `Σ` shows a plan's share apart from money.
 */
export type LiveAgent = Pick<Member, "id" | "parentId" | "cost" | "unpriced"> & { billing?: ProviderPlan["billing"] };

/**
 * One session's live descendants as its agents panel last read them (`team/panel.ts`), for that session's footer `Σ`.
 * The panel is the only reader of the team for the main session, so the footer reads its result here instead of the
 * database.
 */
export type LiveAgentsStore = StoreApi<{ live: readonly LiveAgent[] }>;

/** A store with no live agents: a panel that no footer reads (tests) gets its own. */
export function createLiveAgentsStore(): LiveAgentsStore {
	return createStore<{ live: readonly LiveAgent[] }>()(() => ({ live: [] }));
}

/** One store per feature instance, as `runningWorkOf`: a process hosting several sessions keeps each session's `Σ`. */
const stores = new WeakMap<object, LiveAgentsStore>();

/** The live-agents store of the session `owner` (its feature setup) belongs to. */
export function liveAgentsOf(owner: object): LiveAgentsStore {
	let store = stores.get(owner);
	if (!store) {
		store = createLiveAgentsStore();
		stores.set(owner, store);
	}
	return store;
}

/** Publishes `live` to `store`; an unchanged list (same ids, costs and pricing) notifies nobody. */
export function publishLiveAgents(store: LiveAgentsStore, live: readonly LiveAgent[]): void {
	const key = (agents: readonly LiveAgent[]) =>
		agents
			.map((agent) => `${agent.id}\0${agent.parentId ?? ""}\0${agent.cost}\0${agent.unpriced}\0${agent.billing ?? ""}`)
			.join("\n");
	if (key(store.getState().live) === key(live)) return;
	store.setState({ live: [...live] });
}

/**
 * The agent whose finished run a message adds to the session ledger: a foreground `agent` result or a background
 * report, each carrying the run's total usage and the agent's name in `details.id`. Undefined for any other message, and
 * for a result without usage (a background launch), which adds nothing yet.
 */
export function reportedAgent(message: unknown): string | undefined {
	if (!isRecord(message) || !spendOf(message) || !isRecord(message.details)) return undefined;
	const subagent =
		(message.role === "toolResult" && message.toolName === "agent") ||
		(message.role === "custom" && message.customType === AGENT_RESULT_TYPE);
	return subagent && typeof message.details.id === "string" ? message.details.id : undefined;
}

/**
 * The one total cost, `Σ`: the session ledger (this session's replies, recorded spend and every subagent result or report
 * already added) plus each live descendant whose spend the ledger does not hold yet. A descendant counts as held once it
 * or any agent between it and this session reported: a reported run's usage includes the children it waited for.
 */
export function totalSpend(
	ledger: Pick<TokenTotals, "cost" | "unpriced">,
	live: readonly LiveAgent[],
	reported: ReadonlySet<string>,
): Pick<TokenTotals, "cost" | "unpriced"> {
	const parents = new Map(live.map((agent) => [agent.id, agent.parentId]));
	const held = (id: string | undefined, seen = new Set<string>()): boolean => {
		if (id === undefined || seen.has(id)) return false;
		if (reported.has(id)) return true;
		seen.add(id);
		return held(parents.get(id), seen);
	};
	const pending = live.filter((agent) => !held(agent.id));
	return {
		cost: ledger.cost + pending.reduce((sum, agent) => sum + agent.cost, 0),
		unpriced: ledger.unpriced || pending.some((agent) => agent.unpriced),
	};
}
