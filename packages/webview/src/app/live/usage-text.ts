import type {
	ApplicationBilling,
	ApplicationModelOption,
	ApplicationProviderKind,
	ApplicationUsage,
	QuotaReading,
} from "@octocodeai/octocode-contracts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { formatCost, formatTokens } from "./profiler-model.ts";

const dollars = (value: number): string => `$${value < 0.01 ? "<0.01" : value.toFixed(2)}`;

/**
 * The session's spend as the terminal footer writes it: money (an estimate at list price) apart from the plan's share,
 * `Σ ≈$1.24 · ~$3.10 plan`; `+ n/a` when some replies had no price, `cost n/a` when none had one. Undefined while
 * nothing was spent, as the footer then shows no `Σ`.
 */
export function sigmaText(usage: ApplicationUsage): string | undefined {
	const money = usage.metered > 0 ? `≈${dollars(usage.metered)}` : "";
	const priced = usage.unpriced > 0 ? (money ? `${money} + n/a` : "cost n/a") : money;
	const estimate = usage.planEstimate > 0 ? `~${dollars(usage.planEstimate)} plan` : "";
	const parts = [priced, estimate].filter(Boolean);
	return parts.length ? `Σ ${parts.join(" · ")}` : undefined;
}

/** What `Σ` means, for its tooltip, with the number of replies no price covers. */
export function sigmaTitle(usage: ApplicationUsage): string {
	const replies = usage.unpriced === 1 ? "1 reply" : `${usage.unpriced} replies`;
	const unpriced = usage.unpriced > 0 ? ` ${replies} used a model without a price (n/a).` : "";
	return `Money billed per token, at list prices; a plan's share is an estimate, not money.${unpriced}`;
}

/** A token count as the footer writes it: `950`, `1.2k`, `115k`, `1M`. */
function windowTokens(count: number): string {
	const short = (value: number, unit: string) =>
		value < 100 ? `${value.toFixed(1).replace(/\.0$/, "")}${unit}` : `${Math.round(value)}${unit}`;
	if (count < 1_000) return String(count);
	return count < 999_500 ? short(count / 1_000, "k") : short(count / 1_000_000, "M");
}

/**
 * How full the context window is, as the footer's gauge reads it: `Context 41% of 115k` (`<1%` for use that rounds to
 * zero), warning from half the window, danger past 80 % of where Octocode compacts (80 % of the window without it).
 * Undefined when the host does not know.
 */
export function contextText(usage?: ApplicationUsage): { text: string; tone?: "warning" | "danger" } | undefined {
	const percent = usage?.contextPercent;
	if (percent === undefined) return undefined;
	const shown = Math.round(percent);
	const window = usage?.contextWindow;
	const alarm = window && usage.compactAt ? ((usage.compactAt * 0.8) / window) * 100 : 80;
	return {
		text: `Context ${percent > 0 && shown === 0 ? "<1" : shown}%${window ? ` of ${windowTokens(window)}` : ""}`,
		...(shown > alarm ? { tone: "danger" as const } : shown >= 50 ? { tone: "warning" as const } : {}),
	};
}

const DAY_MS = 86_400_000;
const pad = (value: number): string => String(value).padStart(2, "0");

/** A reset as `/status` writes it: `14:20` within a day, `Fri 09:00` within a week, else `Dec 1`. Local time. */
export function resetClock(at: number, now: number): string {
	const date = new Date(at);
	const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	if (at - now < DAY_MS) return clock;
	if (at - now < 7 * DAY_MS) return `${date.toLocaleDateString("en-US", { weekday: "short" })} ${clock}`;
	return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** A plan window at 70 % or more whose reset is still ahead: one that reset since the host's reading is past. */
const warns = (reading: QuotaReading, now: number): boolean =>
	reading.kind === "plan" && reading.usedFraction >= 0.7 && (reading.resetsAt === undefined || reading.resetsAt > now);

/**
 * Plan windows at 70 % or more, fullest first, in the footer's words: `quota 5h 92% · resets 14:20` for the selected
 * model's provider, with the provider named for another one (`openai-codex quota week 75%`); danger from 90 %.
 */
export function quotaWarnings(
	quota: readonly QuotaReading[] | undefined,
	selected?: string,
	now: number = Date.now(),
): { key: string; text: string; tone: "warning" | "danger" }[] {
	return (quota ?? [])
		.filter((reading) => warns(reading, now))
		.sort((a, b) => b.usedFraction - a.usedFraction)
		.map((reading) => {
			const who = reading.provider === selected ? "" : `${reading.provider} `;
			const reset = reading.resetsAt === undefined ? "" : ` · resets ${resetClock(reading.resetsAt, now)}`;
			return {
				key: `${reading.provider}:${reading.window}`,
				text: `${who}quota ${reading.label} ${Math.round(reading.usedFraction * 100)}%${reset}`,
				tone: reading.usedFraction >= 0.9 ? "danger" : "warning",
			};
		});
}

const billingLabel = (billing?: ApplicationBilling): string =>
	billing === "plan" ? "plan" : billing === "metered" ? "per token" : "";

/**
 * What the model's provider is, in the terminal footer's words (`subscription`, `API key`, `account`, `CLI`, `local`);
 * from an older host that does not say, who pays (`plan`, `per token`).
 */
export const providerWords = (model: { billing?: ApplicationBilling; kind?: ApplicationProviderKind }): string =>
	model.kind ?? billingLabel(model.billing);

const rate = (value: number): string => `$${Number.isInteger(value) ? value : value.toFixed(2)}`;

/** List price per million input and output tokens: `$3 / $15 per M`; `no price` for a model without pricing. */
export function modelPrice(option: ApplicationModelOption): string {
	if (!option.cost || (option.cost.input === 0 && option.cost.output === 0)) return "no price";
	return `${rate(option.cost.input)} / ${rate(option.cost.output)} per M`;
}

/** The models whose provider, id or name contains `query`, grouped by provider in the host's order. */
export function groupModels(
	models: readonly ApplicationModelOption[],
	query: string,
): [provider: string, models: ApplicationModelOption[]][] {
	const needle = query.trim().toLowerCase();
	const groups = new Map<string, ApplicationModelOption[]>();
	for (const model of models) {
		if (needle && !`${model.provider} ${model.id} ${model.name}`.toLowerCase().includes(needle)) continue;
		const group = groups.get(model.provider);
		if (group) group.push(model);
		else groups.set(model.provider, [model]);
	}
	return [...groups];
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** One reply's usage as a line: `1.2k in · 340 out · 900 cached · $0.0123`; undefined when it spent nothing. */
export function replyUsageText(usage: Record<string, unknown>): string | undefined {
	const input = count(usage.input);
	const output = count(usage.output);
	const cacheRead = count(usage.cacheRead);
	const cacheWrite = count(usage.cacheWrite);
	const cost = isRecord(usage.cost) ? count(usage.cost.total) : 0;
	if (input + output + cacheRead + cacheWrite === 0 && cost === 0) return undefined;
	return [
		`${formatTokens(input)} in`,
		`${formatTokens(output)} out`,
		...(cacheRead > 0 ? [`${formatTokens(cacheRead)} cached`] : []),
		...(cacheWrite > 0 ? [`${formatTokens(cacheWrite)} to cache`] : []),
		...(cost > 0 ? [formatCost(cost)] : []),
	].join(" · ");
}
