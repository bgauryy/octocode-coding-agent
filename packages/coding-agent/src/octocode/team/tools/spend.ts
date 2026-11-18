import type { FeatureSetup, FeatureContext } from "../../../core/features/index.ts";
import { SpendScan } from "../../shared/spend.ts";
import { modelLookup, type Spend, unpricedModel } from "../../shared/util.ts";
import type { Team } from "../session.ts";

/**
 * Adds to the agent's row the spend that is not a reply: the summary request of a compaction, a cache refresh, a side
 * question (`usage` entries) and the summaries a compaction or branch switch records. Replies reach the row from
 * `message_end` (`tools.ts`); a subagent's spend is its own row's. The entries are read as the footer reads them
 * (`SpendScan`), each once, at the same moments: after a reply, after a compaction, at the end of a run. Entries already
 * in a resumed session were spent before this process joined and are not added.
 */
export function registerRecordedSpend(api: FeatureSetup, team: Team): void {
	const scan = new SpendScan();
	const add = (spend: Spend | undefined, ctx: FeatureContext) => {
		if (spend) team.onUsage(spend.usage, undefined, unpricedModel(spend, modelLookup(ctx)) !== undefined);
	};
	const addRecorded = (ctx: FeatureContext) => {
		for (const spend of scan.recordedIn(ctx.sessionManager)) add(spend, ctx);
	};
	api.bus.on("session_start", async (_event, ctx) => {
		scan.reset();
		scan.recordedIn(ctx.sessionManager);
	});
	api.bus.on("message_end", async (event, ctx) => {
		if (event.message.role === "assistant") addRecorded(ctx);
	});
	api.bus.on("session_compact", async (event, ctx) => {
		add(scan.entry(event.compactionEntry), ctx);
		addRecorded(ctx);
	});
	api.bus.on("session_tree", async (event, ctx) => add(scan.entry(event.summaryEntry), ctx));
	api.bus.on("agent_end", async (_event, ctx) => addRecorded(ctx));
}
