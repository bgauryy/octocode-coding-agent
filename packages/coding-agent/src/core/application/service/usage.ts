import type { ApplicationBilling, ApplicationUsage } from "@octocodeai/octocode-contracts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { SessionEntry } from "../../session-manager.ts";
import { type BillingFacts, entryBilling, entryUsage } from "../../usage-totals.ts";
import type { ApplicationSession } from "../session-port.ts";

type UsageSource = Pick<ApplicationSession, "sessionManager" | "modelRuntime" | "getContextUsage" | "model">;

const amount = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

/** A subagent's run (its tool result or report) that judged some of its replies unpriced. */
function reportsUnpriced(entry: SessionEntry): boolean {
	const details =
		entry.type === "custom_message"
			? entry.details
			: entry.type === "message" && entry.message.role === "toolResult"
				? entry.message.details
				: undefined;
	return isRecord(details) && details.unpriced === true;
}

type ContextMeasure = Pick<ApplicationUsage, "contextPercent" | "contextWindow" | "compactAt">;

const tokens = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;

/**
 * How full the context is, of which window, and where Octocode compacts automatically, as the footer's gauge reads
 * them. The percent is unknown (null) right after a compaction, until the next reply reports its tokens.
 */
function contextMeasure(usage: ReturnType<NonNullable<UsageSource["getContextUsage"]>>): ContextMeasure {
	const percent = usage?.percent;
	const window = tokens(usage?.contextWindow);
	const compactAt = tokens(usage?.compactionThreshold);
	return {
		...(typeof percent === "number" && Number.isFinite(percent) ? { contextPercent: Math.max(0, percent) } : {}),
		...(window ? { contextWindow: window } : {}),
		...(compactAt ? { compactAt } : {}),
	};
}

/**
 * The session's spend split by who pays, by the judgment the footer, `/usage` and `subagents.maxCost` share
 * (`entryBilling`: what was stored on the entry when it was appended, else its provider's billing): plan-paid spend counts
 * as a plan estimate, everything else as money. It reads the entries `/session` totals (`entryUsage`), all of them, not only
 * the current branch. Entries are append-only, so a read looks only at those added since the last one: one entry count
 * when none were, else one copy of the entry list and the new entries.
 */
export class UsageTally {
	/** The session's entry count at the last read; entries are read again only when it changed. */
	private count = -1;
	private seen = 0;
	private last: SessionEntry | undefined;
	private metered = 0;
	private planEstimate = 0;
	private unpriced = 0;
	/** The providers the entries read so far name: replies and recorded side calls (`/status` lists their quota). */
	private readonly named = new Set<string>();
	/** Context use at the last read, with the entry count and model it was computed for: it changes only with them. */
	private context: { count: number; model: unknown; measure: ContextMeasure } | undefined;

	reset(): void {
		this.count = -1;
		this.seen = 0;
		this.last = undefined;
		this.metered = 0;
		this.planEstimate = 0;
		this.unpriced = 0;
		this.named.clear();
		this.context = undefined;
	}

	/** The providers named by the entries of the last read. */
	providers(): ReadonlySet<string> {
		return this.named;
	}

	/**
	 * Undefined for a session without entries to read (a fixture). `context`: also measure how full the context window is,
	 * which reads the session projection; the last measure is kept otherwise.
	 */
	read(session: UsageSource, { context = true }: { context?: boolean } = {}): ApplicationUsage | undefined {
		const manager = session.sessionManager;
		if (typeof manager?.getEntryCount !== "function") return undefined;
		const count = manager.getEntryCount();
		if (count !== this.count) {
			this.add(session, manager.getEntries());
			this.count = count;
		}
		const measure = context ? this.contextMeasure(session, count) : this.context?.measure;
		return { metered: this.metered, planEstimate: this.planEstimate, unpriced: this.unpriced, ...measure };
	}

	/** Computing context use reads the session projection, so it runs only when the entries or the model changed. */
	private contextMeasure(session: UsageSource, count: number): ContextMeasure {
		const model = session.model;
		const cached = this.context;
		if (cached && cached.count === count && cached.model === model) return cached.measure;
		const measure = contextMeasure(session.getContextUsage?.());
		this.context = { count, model, measure };
		return measure;
	}

	private add(session: UsageSource, entries: SessionEntry[]): void {
		// Anything but growth (another file, a rewrite) is counted again from the start.
		if (!(this.seen > 0 && entries.length >= this.seen && entries[this.seen - 1] === this.last)) this.reset();
		const billing = new Map<string, ApplicationBilling>();
		const runtime = session.modelRuntime;
		const facts: BillingFacts = {
			// A host without a model runtime knows no plan: everything is money.
			billingOf: (provider, scope) => {
				const key = `${scope ?? ""}\0${provider}`;
				let paid = billing.get(key);
				if (paid === undefined) billing.set(key, (paid = runtime?.getProviderBilling(provider, scope) ?? "metered"));
				return paid;
			},
			provider: session.model?.provider,
		};
		for (let index = this.seen; index < entries.length; index++) {
			const entry = entries[index];
			if (entry.type === "message" && entry.message.role === "assistant") this.named.add(entry.message.provider);
			else if (entry.type === "usage") this.named.add(entry.provider);
			const spend = entryUsage(entry);
			if (!spend) continue;
			const { usage } = spend;
			const cost = amount(usage.cost.total);
			const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
			if ((tokens > 0 && cost === 0) || reportsUnpriced(entry)) this.unpriced++;
			if (spend.plan || entryBilling(entry, facts) === "plan") this.planEstimate += cost;
			else this.metered += cost;
		}
		this.seen = entries.length;
		this.last = entries.at(-1);
	}
}
