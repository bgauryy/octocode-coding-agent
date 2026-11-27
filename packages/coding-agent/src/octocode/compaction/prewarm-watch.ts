import type { FeatureSetup } from "../../core/features/index.ts";
import { prewarmWatchOf } from "../monitor/attention/prewarm.ts";
import { notify } from "../shared/commands.ts";

/**
 * Feeds the compaction-prewarm rule (`monitor/attention/prewarm.ts`) the cycle's boundaries: a session start and each
 * successful compaction open a cycle, a prewarm event plans one, and a threshold compaction checks that one was planned.
 * The early summary's own outcomes are reported where they happen (`early-summary.ts`).
 */
export function registerPrewarmWatch(api: FeatureSetup): void {
	const watch = prewarmWatchOf(api);
	api.bus.on("session_start", async (_event, ctx) => {
		const ui = ctx.hasUI ? ctx.ui : undefined;
		watch.start(ui ? (text) => notify(ui, text, "warning") : undefined);
	});
	api.bus.on("session_compact_prewarm", async () => watch.plan());
	api.bus.on("session_before_compact", async (event) => {
		if (event.reason === "threshold") watch.threshold();
		return undefined;
	});
	api.bus.on("session_compact", async () => watch.compacted());
}
