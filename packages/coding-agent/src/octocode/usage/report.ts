import type { UsageTotalRow } from "../../../../db/src/api.ts";
import { formatCost, formatTokenUsage } from "../shared/format.ts";
import { quotaRows } from "../shared/quota-text.ts";
import { localDay } from "./record.ts";

/** The ranges `/usage` reads, each ending today. */
export const USAGE_PERIODS = ["today", "7d", "30d"] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];

const DAYS: Record<UsagePeriod, number> = { today: 1, "7d": 7, "30d": 30 };
const TITLES: Record<UsagePeriod, string> = { today: "today", "7d": "last 7 days", "30d": "last 30 days" };

/** The first and last local day of `period` ending on `today`, and its title. */
function periodRange(period: UsagePeriod, today: Date): { from: string; to: string; title: string } {
	const first = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (DAYS[period] - 1));
	const from = localDay(first);
	const to = localDay(today);
	return { from, to, title: `${TITLES[period]} (${from === to ? to : `${from} – ${to}`})` };
}

/** What `/usage` reads: the agent database's `usage_daily` (`usageDaily.totals`, `usageDaily.firstDay`). */
export interface UsageSource {
	totals(from: string, to: string): UsageTotalRow[];
	firstDay(): string | undefined;
}

/** A provider's current quota windows as one text (`5h 62% · resets 14:20`), listed under the tables. */
export interface QuotaLine {
	provider: string;
	text: string;
}

type Figures = Pick<UsageTotalRow, "requests" | "input" | "output" | "cacheRead" | "cacheWrite" | "cost" | "unpriced">;
interface Line {
	name: string;
	requests: number;
	tokens: string;
	money: string;
	plan: string;
}

const empty = (): Figures => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0 });
const addTo = (into: Figures, row: Figures) => {
	for (const key of Object.keys(into) as (keyof Figures)[]) into[key] += row[key];
};
/** `↑fresh +cached ↓out`, as the footer and the agents panel count tokens. */
const tokens = (figures: Figures) =>
	formatTokenUsage({
		input: figures.input + figures.cacheRead + figures.cacheWrite,
		cacheRead: figures.cacheRead,
		output: figures.output,
	});
/** Money as everywhere else (`≈$1.24`, `+ n/a` for unpriced requests). */
const money = (figures: Figures) => formatCost({ cost: figures.cost, unpriced: figures.unpriced > 0 });
/** What plan-billed requests would have cost at list price: an estimate, never money. */
const plan = (figures: Figures) => {
	const shown = formatCost({ cost: figures.cost, unpriced: figures.unpriced > 0 });
	return shown.replace(/^≈/, "~");
};

/** One row per model under its provider, metered and plan figures side by side, and the period's split total. */
function periodLines(rows: readonly UsageTotalRow[]): { lines: Line[]; total: Line } {
	const providers = new Map<string, Map<string, { metered: Figures; plan: Figures }>>();
	const metered = empty();
	const planned = empty();
	for (const row of rows) {
		const models = providers.get(row.provider) ?? new Map<string, { metered: Figures; plan: Figures }>();
		providers.set(row.provider, models);
		const model = models.get(row.model) ?? { metered: empty(), plan: empty() };
		models.set(row.model, model);
		addTo(model[row.billing === "plan" ? "plan" : "metered"], row);
		addTo(row.billing === "plan" ? planned : metered, row);
	}
	const line = (name: string, figures: { metered: Figures; plan: Figures }): Line => {
		const both = empty();
		addTo(both, figures.metered);
		addTo(both, figures.plan);
		return {
			name,
			requests: both.requests,
			tokens: tokens(both),
			money: money(figures.metered),
			plan: plan(figures.plan),
		};
	};
	const lines: Line[] = [];
	for (const [provider, models] of providers) {
		lines.push({ name: provider, requests: Number.NaN, tokens: "", money: "", plan: "" });
		for (const [model, figures] of models) lines.push(line(`  ${model}`, figures));
	}
	return { lines, total: line("Total", { metered, plan: planned }) };
}

/** The lines as a table: name left, figures right, a provider's line carrying its name alone. */
function table(lines: readonly Line[], total: Line): string[] {
	const header: Line = {
		name: "Provider / model",
		requests: Number.NaN,
		tokens: "Tokens",
		money: "Money",
		plan: "Plan estimate",
	};
	const all = [header, ...lines, total];
	const count = (line: Line) =>
		line === header ? "Requests" : Number.isNaN(line.requests) ? "" : String(line.requests);
	const width = (pick: (line: Line) => string) => Math.max(...all.map((line) => pick(line).length));
	const widths = [width((line) => line.name), width(count), width((line) => line.tokens), width((line) => line.money)];
	return all.map((line) => {
		if (line !== header && Number.isNaN(line.requests)) return `  ${line.name}`;
		const cells = [line.name.padEnd(widths[0]), count(line).padStart(widths[1]), line.tokens.padEnd(widths[2])];
		return `  ${[...cells, line.money.padStart(widths[3]), line.plan].join("   ")}`.trimEnd();
	});
}

interface UsageReportInput {
	periods: readonly UsagePeriod[];
	today: Date;
	source: UsageSource;
	/** Quota windows by provider (the quota store), listed after the tables; none until the store supplies them. */
	quota?: readonly QuotaLine[];
}

/**
 * `/usage` as text: for each period, its requests, tokens, money and plan estimate by provider and model, and a total
 * that keeps the two apart. History starts when this table was created: an empty period says so, and one that starts
 * before the first recorded day names that day.
 */
export function usageReport(input: UsageReportInput): string {
	const first = input.source.firstDay();
	const parts: string[] = [];
	let tables = 0;
	for (const period of input.periods) {
		const range = periodRange(period, input.today);
		const rows = input.source.totals(range.from, range.to);
		const head = `Usage ${range.title}`;
		if (rows.length === 0) {
			parts.push(`${head}\n  No usage recorded.`);
			continue;
		}
		tables++;
		const { lines, total } = periodLines(rows);
		const since = first && first > range.from ? [`  History starts ${first}: earlier days were not recorded.`] : [];
		parts.push([head, ...table(lines, total), ...since].join("\n"));
	}
	// Said once, not under every empty period: nothing was ever recorded.
	if (first === undefined)
		parts.push("History starts at the upgrade that added /usage; earlier sessions are not counted.");
	const quota = input.quota ?? [];
	if (quota.length > 0) parts.push(["Quota", ...quotaRows(quota)].join("\n"));
	// The columns' meaning, under the tables that have them.
	if (tables > 0)
		parts.push(
			"Money is billed per token, at list prices; a plan estimate is what plan-billed requests would cost per token.",
		);
	return parts.join("\n\n");
}
