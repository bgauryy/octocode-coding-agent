import { usageDaily } from "../../../../db/src/api.ts";
import type { FeatureSetup } from "../../core/features/index.ts";
import { providerQuotas } from "../../core/model-runtime/quota-request.ts";
import { builtinDescription, getBuiltinCommand } from "../../core/slash-commands.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import { type Subcommands, say, wordCompletions } from "../shared/commands.ts";
import { quotaTexts } from "../shared/quota-text.ts";
import { registerUsageRecording } from "./record.ts";
import { type QuotaLine, USAGE_PERIODS, type UsagePeriod, type UsageSource, usageReport } from "./report.ts";

interface UsageCommandOptions {
	/** The spend history to read; the agent database's `usage_daily` by default. */
	source?: () => UsageSource;
	/** Current quota windows by provider; the quota store's readings in force (`providerQuotas.all()`) by default. */
	quota?: () => readonly QuotaLine[];
	now?: () => Date;
}

/** The agent database's `usage_daily`, on the process's shared connection. */
const databaseSource = (): UsageSource => {
	const { db } = sharedAgentDb();
	return { totals: (from, to) => usageDaily.totals(db, from, to), firstDay: () => usageDaily.firstDay(db) };
};

/** Every provider's windows in force, from this process and the agent database (`provider_quota`). */
const storedQuota = (): QuotaLine[] => quotaTexts(providerQuotas.all(), providerQuotas.now());

/**
 * `/usage [today|7d|30d]` (`/cost` runs it): spend by provider and model, money apart from plan estimates, from the
 * daily totals every Octocode process records (`record.ts`), then each provider's quota windows in force. With no
 * argument it shows today and the last 7 days.
 */
export function registerUsageCommand(commands: Subcommands, options: UsageCommandOptions = {}): void {
	const usage = `Usage: /usage [${USAGE_PERIODS.join("|")}]`;
	commands.add("usage", {
		description: builtinDescription("usage"),
		argumentHint: getBuiltinCommand("usage")?.argumentHint,
		argumentWords: USAGE_PERIODS,
		dialog: "interaction",
		complete: (prefix) => wordCompletions([...USAGE_PERIODS], prefix),
		handler: async (args, ctx) => {
			if (args !== "" && !USAGE_PERIODS.includes(args as UsagePeriod)) return say(ctx, usage, "warning");
			const periods: readonly UsagePeriod[] = args ? [args as UsagePeriod] : ["today", "7d"];
			say(
				ctx,
				usageReport({
					periods,
					today: (options.now ?? (() => new Date()))(),
					source: (options.source ?? databaseSource)(),
					quota: (options.quota ?? storedQuota)(),
				}),
			);
		},
	});
}

/** Records this session's spend by day and adds `/usage`. */
export function registerUsage(api: FeatureSetup, commands: Subcommands, options: UsageCommandOptions = {}): void {
	registerUsageRecording(api);
	registerUsageCommand(commands, options);
}
