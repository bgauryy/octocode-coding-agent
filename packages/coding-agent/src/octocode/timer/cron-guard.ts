import type { TimerRow } from "../../../../db/src/api.ts";
import { getAgentDir } from "../../config.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { addUsageToTotals, createUsageTotals, entryUsage } from "../../core/usage-totals.ts";
import { cronOf } from "./cron.ts";

/** What a session may spend on cron runs, in USD, when `timer.cron.maxUsdPerSession` is not set. */
const DEFAULT_CRON_MAX_USD = 2;

export interface CronSettings {
	enabled: boolean;
	maxUsd: number;
}

/**
 * `timer.cron` from the global settings only, as `timer.check.enabled` is: a project file must not start unattended spending.
 * Settings that cannot be read leave cron off and the cap at its default, which costs nothing.
 */
export function cronSettings(agentDir: string = getAgentDir()): CronSettings {
	try {
		const cron = SettingsManager.create(agentDir, agentDir, { projectTrusted: false }).getSettings().timer?.cron;
		return { enabled: cron?.enabled === true, maxUsd: cron?.maxUsdPerSession ?? DEFAULT_CRON_MAX_USD };
	} catch {
		// Unreadable settings: cron stays off, which spends nothing.
		return { enabled: false, maxUsd: DEFAULT_CRON_MAX_USD };
	}
}

/** The cost of the session so far, in USD: every reply and subagent result its entries hold. */
export function sessionCostUsd(entries: readonly SessionEntry[]): number {
	const totals = createUsageTotals();
	for (const entry of entries) {
		const spend = entryUsage(entry);
		if (spend) addUsageToTotals(totals, spend.usage);
	}
	return totals.cost;
}

/**
 * What the session spent since its first cron timer was set, when that is over `cap`; otherwise undefined. The first timer
 * is the oldest of `rows` (the session's cron timers, ended ones too), each of which recorded the cost when it was set.
 */
export function cronOverspend(rows: readonly TimerRow[], total: number, cap: number): number | undefined {
	const bases = rows.flatMap((row) => cronOf(row)?.usd ?? []);
	if (bases.length === 0) return undefined;
	const spent = total - Math.min(...bases);
	return spent > cap ? spent : undefined;
}
