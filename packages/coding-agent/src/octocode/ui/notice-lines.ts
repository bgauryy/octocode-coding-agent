/**
 * Draws the once-only session notes (`core/notice-line.ts`) and writes two of them: the carried rules a compaction
 * lifted, and the lean prompt turning on by itself. Other owners write their own kinds (a `subagents` limit's refusal).
 */

import { Text } from "@octocodeai/octocode-tui";
import type { FeatureContext, FeatureSetup } from "../../core/features/index.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import { LEAN_MAIN_WINDOW, leanMainPolicy } from "../../core/lean-main.ts";
import { compactionOutcome, liftedLine } from "../../core/compaction/outcome-read.ts";
import { formatTokens } from "../shared/format.ts";
import { appendNoticeLine, NOTICE_LINE_TYPE, noticeLineOf, noticeLines } from "../../core/notice-line.ts";
import { publishUserNotice } from "../shared/user-notice.ts";

/** Why `leanPrompt: "auto"` chose the lean policy for `model`. */
function leanLine(model: NonNullable<FeatureContext["model"]>): string {
	const key = `${model.provider}/${model.id}`;
	const why =
		model.contextWindow > 0 && model.contextWindow < LEAN_MAIN_WINDOW
			? `its ${formatTokens(model.contextWindow)}-token window is under ${formatTokens(LEAN_MAIN_WINDOW)}`
			: "it is the subagents.models.small model";
	return `Lean prompt on for ${key}: ${why} (leanPrompt "auto"; no delegation or skill list)`;
}

/** Registers the notice lines for a main session: their renderer, the compaction note and the lean-prompt note. */
export function registerNoticeLines(api: FeatureSetup): void {
	api.renderers.entry(NOTICE_LINE_TYPE, (entry, _options, theme) => {
		const line = noticeLineOf(entry.data);
		return line ? new Text(theme.fg("dim", line.text), 1, 0) : undefined;
	});
	const append = (line: Parameters<typeof appendNoticeLine>[1]) => appendNoticeLine(api, line);

	api.bus.on("session_compact", async (event) => {
		const text = liftedLine(compactionOutcome(event.compactionEntry).lifted);
		if (!text) return;
		append({ kind: "compaction_lifted", text });
		publishUserNotice(api.channels, {
			type: "compaction_lifted",
			title: "Octocode: compaction lifted rules",
			message: text,
		});
	});

	/** Models the lean note was written for in this session (read back from its entries on a resume). */
	let leanNoted = new Set<string>();
	api.bus.on("session_start", async (_event, ctx) => {
		leanNoted = new Set(
			noticeLines(ctx.sessionManager.getEntries()).flatMap((line) =>
				line.kind === "lean_prompt" && line.model ? [line.model] : [],
			),
		);
	});
	api.bus.on("before_agent_start", async (_event, ctx) => {
		const settings = api.settings.get();
		// Only the automatic choice is news: `leanPrompt: "on"` is the user's own.
		if ((settings.leanPrompt ?? SETTINGS_DEFAULTS.leanPrompt) !== "auto" || !ctx.model) return undefined;
		const key = `${ctx.model.provider}/${ctx.model.id}`;
		if (leanNoted.has(key) || !leanMainPolicy(ctx.model, settings)) return undefined;
		leanNoted.add(key);
		append({ kind: "lean_prompt", model: key, text: leanLine(ctx.model) });
		return undefined;
	});
}
