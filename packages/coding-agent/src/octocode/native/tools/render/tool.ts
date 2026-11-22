import { StringEnum } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import type { FeatureSetup } from "../../../../core/features/index.ts";
import { renderPrompt } from "../../../../core/prompt-template.ts";
import { ask } from "../../../ask/ask.ts";
import { askUserResult } from "../../../ask/decode.ts";
import { timedTool } from "../../../render/rows.ts";
import { toolHeader } from "../../../render/tool.ts";
import { clip } from "../../../shared/text.ts";
import { textResult } from "../../../shared/util.ts";
import { formatAnswers } from "../ask-user/tool.ts";
import { type RenderParams, PROCEED_ID, displayOf, questionsOf } from "./compile.ts";

const parameters = Type.Object({
	type: StringEnum(["status", "table", "confirm", "form"]),
	title: Type.String(),
	body: Type.Optional(Type.String()),
	rows: Type.Optional(Type.Array(Type.Array(Type.String()))),
	fields: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.String(),
				label: Type.String(),
				options: Type.Optional(Type.Array(Type.String())),
			}),
		),
	),
	permission: Type.Optional(Type.Boolean()),
});

/**
 * The main session's `render` tool: a status or table drawn in the transcript, and a confirm or form asked through the
 * same dialog as `askUser`. `permission: true` adds an accept step; it never replaces or skips a tool's own permission
 * check, which `render` has none of: it changes nothing.
 */
export function registerRender(api: FeatureSetup, options: { isSubagent: boolean }): void {
	// A subagent has no screen of its own: it reports to its parent, which renders.
	if (options.isSubagent) return;
	api.tools.register(
		timedTool({
			name: "render",
			roleVariant: true,
			label: "Render",
			promptSnippet: renderPrompt("tools/render/snippet.md"),
			description:
				"Show a status or table (rows; the first is the header); ask a confirm or form. permission: true waits for the user's accept.",
			parameters,
			async execute(_id, params, signal, _onUpdate, ctx) {
				const call = params as RenderParams;
				if (!ctx.hasUI)
					throw new Error(
						"render needs the user's screen and this session has none (print or headless): say it in your reply, and ask a question in text only if it cannot wait.",
					);
				const questions = questionsOf(call);
				if (questions.length === 0) return textResult("Shown.");
				const result = askUserResult(questions, await ask(ctx, questions, signal ? { signal } : {}));
				const accepted = result.answers.find((entry) => entry.question === questions.at(-1)?.question);
				const needsAccept = call.type === "confirm" || call.permission === true;
				const refused = needsAccept && (accepted === undefined || accepted.answer !== "Yes");
				const note = refused
					? `\nNot accepted: do not proceed with "${clip(call.title, 80)}" unless the user asks.`
					: "";
				return {
					content: [{ type: "text", text: `${formatAnswers(result)}${note}` }],
					details: { ...result, ...(needsAccept ? { accepted: !refused, step: PROCEED_ID } : {}) },
				};
			},
			display(input) {
				const text = input.result?.content?.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
				return displayOf(input.args as Partial<RenderParams>, text, input.status === "failed");
			},
			renderCall(args, theme, context) {
				const input = args as Partial<RenderParams>;
				return toolHeader(
					theme,
					context,
					"Render",
					[input.type, clip(input.title ?? "", 80)].filter(Boolean).join(": "),
				);
			},
		}) as never,
	);
}
