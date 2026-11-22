import { Type } from "typebox";
import { renderPrompt } from "../../../../core/prompt-template.ts";
import type { FeatureSetup } from "../../../../core/features/index.ts";
import { displayText, textResultDisplay } from "../../../render/display.ts";
import { resultBlock, resultText } from "../../../render/tool.ts";
import { timedTool, timingOf } from "../../../render/rows.ts";
import { oneLine } from "../../../shared/text.ts";
import { textResult } from "../../../shared/util.ts";
import { SkillBatch, requestedSkills } from "../../../skill/batch.ts";
import { batchDisplay, batchHeader, batchResult } from "../../../skill/batch-render.ts";
import { SkillCatalog } from "../../../skill/catalog.ts";

/**
 * The `skill` tool: the one place skills are explained and listed. Its description, built from the skills this session
 * has now, says what a skill is, when to load one and where its outputs go, then lists every skill a model may load
 * (`SkillListing`). A call loads several at once; it serves only skills in that list, so the tool is no way to read
 * another path, and an entry it refuses never costs the others. With no loadable skill the declaration stays out of requests.
 */
export function registerSkillTool(api: FeatureSetup, existing?: SkillCatalog): SkillCatalog {
	const catalog = existing ?? new SkillCatalog(() => api.resources.getSkillResourceSnapshot());
	api.bus.on("session_start", async () => {
		catalog.refresh();
	});
	api.tools.register(
		timedTool({
			name: "skill",
			roleVariant: true,
			label: "Skill",
			promptSnippet: renderPrompt("tools/skill/snippet.md"),
			description: renderPrompt("tools/skill/description.md", { listing: "(no skills are enabled)" }),
			parameters: Type.Object({
				names: Type.Optional(Type.Array(Type.String())),
				name: Type.Optional(Type.String()),
			}),
			prepareLoadout() {
				const listing = catalog.listing();
				return listing.isEmpty
					? { hiddenDeclarations: ["skill"] }
					: { descriptions: { skill: renderPrompt("tools/skill/description.md", { listing: listing.render() }) } };
			},
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				signal?.throwIfAborted();
				const requests = requestedSkills(params);
				if (requests.length === 0) throw new Error("skill needs the names of listed skills.");
				const batch = SkillBatch.run(catalog, requests, { id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd });
				// Nothing loaded: the call fails, naming every refusal.
				if (batch.loaded.length === 0) throw new Error(batch.text);
				return textResult(batch.text, batch.details);
			},
			display(input) {
				const head = { title: batchDisplay(input.args, undefined, "").title, kind: "read" as const, blocks: [] };
				if (!input.result || input.status !== "completed") return textResultDisplay(head, input);
				return { ...head, ...batchDisplay(input.args, input.result.details, displayText(input.result)) };
			},
			renderCall: (args, theme, context) => batchHeader(theme, context, args),
			renderResult(result, _options, theme, context) {
				// A failure lists what was wrong on the lines after its first: keep them all.
				if (context.isError) return resultBlock(theme, context, { summary: oneLine(resultText(result)), body: "" });
				return batchResult(resultText(result), result.details, theme, context, timingOf(result.details));
			},
		}),
	);
	return catalog;
}
