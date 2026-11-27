import { isCredentialError, isNoFundsError, type QuotaReading } from "@octocodeai/octocode-ai";
import type { FeatureContext } from "../../core/features/index.ts";
import { type CatalogStatus, catalogStatus } from "../../core/model-catalog/status.ts";
import { type ProviderCooldowns, providerCooldowns } from "../../core/model-runtime/provider-cooldown.ts";
import { type ProviderQuotas, providerQuotas } from "../../core/model-runtime/quota-request.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { type BillingFacts, billingFacts, entryBilling, entryUsage } from "../../core/usage-totals.ts";
import { formatCost, formatSpan } from "../shared/format.ts";
import { resetClock } from "@octocodeai/octocode-common/time";
import type { ModelRef } from "./model.ts";
import { providerHealth } from "./provider-health.ts";

/**
 * What the agent sees of each provider now (the `models` tool, `/modelsettings`): its quota windows with their resets,
 * its health (cooling down after a rate limit, refused, deprecated models) and this session's spend on it, money apart
 * from what a plan paid for; then the session's whole spend and, when it does not apply in full, the catalog update's state.
 */

/** A plan window from this share on is news: the 90 % notice (`models-quota-notice.ts`) fires there too. */
export const QUOTA_HIGH = 0.9;
/** Deprecated models named per provider; the rest are counted. */
const DEPRECATED_SHOWN = 3;

/** Where the state comes from; each defaults to the process's own record. */
export interface ProviderStateSources {
	quotas?: Pick<ProviderQuotas, "current" | "now">;
	cooldowns?: Pick<ProviderCooldowns, "remainingMs">;
	/** Whether the provider refused its credential or account lately (`ProviderHealth.refused`). */
	refused?: (provider: string) => boolean;
	catalog?: () => CatalogStatus;
}

type StateContext = Pick<FeatureContext, "model" | "modelRegistry" | "sessionManager">;

/** A plan window as `5h 92% (resets 14:20)`; a rate window (it refills within a minute) only when nearly used up. */
function windowText(reading: QuotaReading, now: number): string | undefined {
	if (reading.kind !== "plan" && reading.usedFraction < QUOTA_HIGH) return undefined;
	const used = `${reading.label} ${Math.round(reading.usedFraction * 100)}%`;
	return reading.kind === "plan" && reading.resetsAt !== undefined
		? `${used} (resets ${resetClock(reading.resetsAt, now)})`
		: used;
}

interface Spend {
	money: number;
	plan: number;
	unpriced: boolean;
}

const noSpend = (): Spend => ({ money: 0, plan: 0, unpriced: false });

/** `≈$1.24 · ~$3.10 plan`: money apart from what a plan paid for at list price; empty when nothing was spent. */
function spendText(spend: Spend): string {
	const money = formatCost({ cost: spend.money, unpriced: spend.unpriced });
	const plan = spend.plan > 0 ? `~$${spend.plan < 0.01 ? "<0.01" : spend.plan.toFixed(2)} plan` : "";
	return [money, plan].filter(Boolean).join(" · ");
}

/** The provider a reply or a recorded request names; summaries and subagent runs name none of their own. */
function entryProvider(entry: SessionEntry): string | undefined {
	if (entry.type === "usage") return entry.provider;
	if (entry.type === "message" && entry.message.role === "assistant") return entry.message.provider;
	return undefined;
}

/**
 * The session's spend (every entry, as `/session` counts it: `entryUsage`), split by who paid (`entryBilling`, the
 * judgment the footer and `/usage` share), in total and per provider of its replies and recorded requests.
 */
export function sessionSpend(
	entries: readonly SessionEntry[],
	facts: BillingFacts,
): { total: Spend; byProvider: Map<string, Spend> } {
	const total = noSpend();
	const byProvider = new Map<string, Spend>();
	for (const entry of entries) {
		const spend = entryUsage(entry);
		if (!spend) continue;
		const { usage } = spend;
		const cost = Number.isFinite(usage.cost.total) && usage.cost.total > 0 ? usage.cost.total : 0;
		const plan = spend.plan === true || entryBilling(entry, facts) === "plan";
		const unpriced = !plan && cost === 0 && usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0;
		const provider = entryProvider(entry);
		let own: Spend | undefined;
		if (provider && !(own = byProvider.get(provider))) byProvider.set(provider, (own = noSpend()));
		for (const sum of own ? [total, own] : [total]) {
			if (plan) sum.plan += cost;
			else sum.money += cost;
			sum.unpriced ||= unpriced;
		}
	}
	return { total, byProvider };
}

/** Why the provider is unhealthy now: cooling down after a rate limit, or refused (by the shared classifiers' kind). */
function healthText(provider: string, sources: Required<ProviderStateSources>): string[] {
	const parts: string[] = [];
	const cooling = sources.cooldowns.remainingMs(provider);
	if (cooling > 0) parts.push(`cooling down ${formatSpan(cooling)} (rate limit)`);
	if (sources.refused(provider)) {
		const detail = providerHealth.get(provider)?.detail ?? "";
		const kind = isNoFundsError(detail) ? "no funds" : isCredentialError(detail) ? "credential" : "usage limit";
		parts.push(`refused (${kind})`);
	}
	return parts;
}

/** `deprecated a, b, c +2`: the connected models models.dev lists as deprecated (never routed to). */
function deprecatedText(registry: StateContext["modelRegistry"], models: readonly ModelRef[]): string | undefined {
	const ids = models.filter((model) => registry.isModelDeprecated?.(model)).map((model) => model.id);
	if (ids.length === 0) return undefined;
	const more = ids.length > DEPRECATED_SHOWN ? ` +${ids.length - DEPRECATED_SHOWN}` : "";
	return `deprecated ${ids.slice(0, DEPRECATED_SHOWN).join(", ")}${more}`;
}

/** The catalog update's state when it is stale, failed or inert; undefined when it applies in full and is fresh. */
function catalogText(status: CatalogStatus): string | undefined {
	if (status.source === "off") return undefined;
	const parts = [
		...(status.stale ? ["index stale"] : []),
		...(status.problem ? [status.problem] : []),
		...(status.inert ? [`updates inert: ${status.inert}`] : []),
	];
	return parts.length > 0 ? `Catalog: ${parts.join("; ")}.` : undefined;
}

/**
 * The provider state block: one line per provider with something to say (a quota window, a health problem, deprecated
 * models, spend), this session's provider first, then the session's total spend and the catalog's state. `connected`
 * are the models the listing read; `only` narrows the lines to one provider. Empty when there is nothing to say.
 */
export function providerState(
	ctx: StateContext,
	connected: readonly ModelRef[],
	only?: string,
	given: ProviderStateSources = {},
): string {
	const sources: Required<ProviderStateSources> = {
		quotas: given.quotas ?? providerQuotas,
		cooldowns: given.cooldowns ?? providerCooldowns,
		refused: given.refused ?? ((provider) => providerHealth.refused(provider)),
		catalog: given.catalog ?? (() => catalogStatus()),
	};
	const now = sources.quotas.now();
	// Every entry, as the footer counts them; a context without a session (a test host) has spent nothing.
	const entries = ctx.sessionManager?.getEntries() ?? [];
	const spend = sessionSpend(entries, billingFacts(ctx));
	const own = ctx.model?.provider;
	const providers = [
		...new Set([...(own ? [own] : []), ...connected.map((model) => model.provider), ...spend.byProvider.keys()]),
	].filter((provider) => !only || provider.toLowerCase() === only);
	const lines = providers.flatMap((provider) => {
		const windows = sources.quotas.current(provider).flatMap((reading) => windowText(reading, now) ?? []);
		const deprecated = deprecatedText(
			ctx.modelRegistry,
			connected.filter((model) => model.provider === provider),
		);
		const spent = spendText(spend.byProvider.get(provider) ?? noSpend());
		const parts = [
			...windows,
			...healthText(provider, sources),
			...(deprecated ? [deprecated] : []),
			...(spent ? [`spent ${spent}`] : []),
		];
		return parts.length > 0 ? [`  ${provider}${provider === own ? " (this session)" : ""}: ${parts.join(" · ")}`] : [];
	});
	const total = spendText(spend.total);
	const catalog = catalogText(sources.catalog());
	return [
		...(lines.length > 0 ? ["Provider state (plan quota windows, health, this session's spend):", ...lines] : []),
		...(total ? [`This session spent ${total} (replies, summaries and subagents; plan at list price).`] : []),
		...(catalog ? [catalog] : []),
	].join("\n");
}
