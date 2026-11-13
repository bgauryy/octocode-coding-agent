import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { cachedPercent } from "../shared/format.ts";
import type { EntrySource } from "../shared/entry-cursor.ts";
import { SpendScan } from "../shared/spend.ts";
import { addReply, emptyTotals, type ModelLookup, spendOf, unpricedModel, type UsageTotals } from "../shared/util.ts";

/** What one settled run adds up to; the fields of the `octocode-turn` entry besides its duration. */
export interface TurnTotals {
	tools: number;
	agents: number;
	cost: number;
	unpriced: boolean;
	/** Percent of the main agent's prompt tokens read from cache, undefined without a reply that reported any. */
	cache: number | undefined;
}

/**
 * Adds up one run across every segment (retry, auto-continue, compaction resume, queued follow-up), one event at a
 * time. Spend is read the way the footer reads it (`spendOf`, `SpendScan`), so the line and the footer total agree.
 */
export class TurnRun {
	private tools = 0;
	private all: UsageTotals = emptyTotals();
	private main: UsageTotals = emptyTotals();
	private readonly agents = new Set<string>();
	private anonymousAgents = 0;
	private readonly scan = new SpendScan();

	/** Starts a run: spend recorded before it is not the run's. */
	begin(session: EntrySource): void {
		this.tools = 0;
		this.all = emptyTotals();
		this.main = emptyTotals();
		this.agents.clear();
		this.anonymousAgents = 0;
		this.scan.recordedIn(session);
	}

	tool(): void {
		this.tools += 1;
	}

	/** A finished message: a main-agent reply, or a subagent's result or report. */
	message(message: unknown, find?: ModelLookup): void {
		const spend = spendOf(message);
		if (!spend) return;
		this.add(spend, find);
		if (spend.role === "assistant") addReply(this.main, spend.usage, false);
		else if (spend.role === "toolResult" || spend.role === "custom") this.agent(message);
	}

	/** Spend recorded outside a reply or event (a compaction summary, a cache refresh) since the last look. */
	recorded(session: EntrySource, find?: ModelLookup): void {
		for (const spend of this.scan.recordedIn(session)) this.add(spend, find);
	}

	/** A compaction or branch-summary entry, announced by an event. */
	entry(entry: unknown, find?: ModelLookup): void {
		const spend = this.scan.entry(entry);
		if (spend) this.add(spend, find);
	}

	totals(): TurnTotals {
		return {
			tools: this.tools,
			agents: this.agents.size + this.anonymousAgents,
			cost: this.all.cost,
			unpriced: this.all.unpriced,
			cache: cachedPercent(this.main.cacheRead, this.main.input),
		};
	}

	private add(spend: NonNullable<ReturnType<typeof spendOf>>, find?: ModelLookup): void {
		addReply(this.all, spend.usage, unpricedModel(spend, find) !== undefined);
	}

	private agent(message: unknown): void {
		const details = isRecord(message) ? message.details : undefined;
		const id = isRecord(details) ? details.id : undefined;
		if (typeof id === "string") this.agents.add(id);
		else this.anonymousAgents += 1;
	}
}
