import { renderInstruction } from "../../core/prompt-template.ts";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { withDialog } from "../shared/locks.ts";
import { STATE_COLOR, stateMark, type UiState } from "../../theme/status.ts";
import { resultBlock, toolHeader } from "../shared/render.ts";
import { shareRowState, sharedRowState } from "../shared/row-mark.ts";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import { showAskDialog } from "./dialog.ts";
import { clip, plural } from "../shared/render/text.ts";
import { timedTool, timingOf } from "../shared/render/rows.ts";
import { answerLine } from "../shared/ask-answer.ts";
import { type AskQuestion, type AskResult, answerOf, SUBMIT_PICKS, TYPE_OWN } from "./dialog/answers.ts";
import { type AskView, isRecommended, takeWriteIn } from "../shared/ask-view.ts";

/** The most options one question offers (the schema asks for 2-4); the UI adds the write-in. */
const MAX_OPTIONS = 6;
/** An option the UI already offers as its write-in row. */
const OTHER = /^\s*(other|something else)\b/i;

/** RPC hosts have dialogs but no custom TUI components: fall back to select/input per question. */
async function askWithDialogs(
	ctx: ExtensionContext,
	questions: AskQuestion[],
	signal?: AbortSignal,
): Promise<AskResult> {
	const answers: AskResult["answers"] = [];
	const options = signal ? { signal } : undefined;
	const cancelled = (): AskResult => ({
		answers,
		cancelled: true,
		...(signal?.aborted ? { reason: "aborted" as const } : {}),
	});
	for (const q of questions) {
		if (signal?.aborted) return cancelled();
		if (q.options.length === 0) {
			let typed: string | undefined;
			do {
				typed = (await ctx.ui.input(sanitizeTerminalText(q.question), undefined, options))?.trim();
				if (signal?.aborted || typed === undefined) return cancelled();
			} while (!typed);
			answers.push(answerOf(q.question, [], typed));
			continue;
		}
		// Numbered identities distinguish duplicate labels and labels named after UI actions.
		const labels = q.options.map((option, index) =>
			sanitizeTerminalText(`${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`),
		);
		// Multi-select: pick one option per round until Done (or every option is picked), as the TUI's toggles.
		const chosen = new Set<number>();
		let typed: string | undefined;
		for (;;) {
			const remaining = labels.filter((_, index) => !chosen.has(index));
			const extra = q.multiSelect && chosen.size > 0 ? [SUBMIT_PICKS, TYPE_OWN] : [TYPE_OWN];
			const selected = [...chosen].map((index) => q.options[index].label).join(", ");
			const title = q.multiSelect
				? `${q.question} (choose one or more, then ${SUBMIT_PICKS}${selected ? `; selected: ${selected}` : ""})`
				: q.question;
			const choices = [...remaining, ...extra];
			// The same question as a card for a terminal that draws one (a parent showing this subagent's question).
			const view: AskView = {
				question: sanitizeTerminalText(q.forwarded?.ask ?? q.question),
				...(q.forwarded ? { body: { label: q.forwarded.label, text: q.forwarded.text, collapsible: true } } : {}),
				options: choices.map((label) => ({ label, ...(isRecommended(label) ? { recommended: true } : {}) })),
				writeIn: { label: TYPE_OWN, title: sanitizeTerminalText(q.question) },
			};
			const picked = await ctx.ui.select(sanitizeTerminalText(title), choices, { ...options, ask: view });
			if (signal?.aborted || picked === undefined) return cancelled();
			if (picked === TYPE_OWN) {
				// An empty answer is no answer, as in the TUI dialog. A card's inline write-in already holds the text.
				typed = (
					takeWriteIn(view) ?? (await ctx.ui.input(sanitizeTerminalText(q.question), undefined, options))
				)?.trim();
				if (signal?.aborted) return cancelled();
				if (!typed) {
					typed = undefined;
					continue;
				}
				break;
			}
			if (picked === SUBMIT_PICKS) break;
			const index = labels.indexOf(picked);
			if (index < 0 || chosen.has(index)) return cancelled();
			chosen.add(index);
			if (!q.multiSelect || chosen.size === labels.length) break;
		}
		const picks = q.options.flatMap((option, index) => (chosen.has(index) ? [option.label] : []));
		answers.push(answerOf(q.question, picks, typed));
	}
	return { answers, cancelled: false };
}

export function formatAnswers(result: AskResult): string {
	const answered = result.answers.map(answerLine);
	if (!result.cancelled) return answered.join("\n");
	// The status leads, so a cancelled call is not read as answers; it is not `isError`: a refusal is the user's choice, the
	// call itself worked, and an error flag would invite a retry of the same question.
	const status =
		result.reason === "unavailable"
			? "Cancelled (unavailable). No interactive user is available. No answer or approval was supplied."
			: result.reason === "aborted"
				? "Cancelled (interrupted). The question was interrupted. No further answer or approval was supplied."
				: `Cancelled (declined). The user declined to answer${answered.length > 0 ? " the remaining questions" : ""}. Unanswered questions do not grant approval.`;
	const recovery =
		"Continue work covered by existing authorization; state reversible assumptions. If an answer is required to proceed, report what remains blocked.";
	// Answers given before the user cancelled still count.
	return [status, ...(answered.length > 0 ? ["Answered before that:", ...answered] : []), recovery].join("\n");
}

/** Where a forwarded question is read from: the team's stored message, with its access check. */
type StoredQuestion = (id: number) => { from: string; text: string } | { error: string };

export function registerAskUser(api: ExtensionAPI, storedQuestion?: StoredQuestion): void {
	api.registerTool(
		timedTool({
			name: "askUser",
			label: "Ask user",
			promptSnippet: renderInstruction("tools/ask-user/snippet.md"),
			description:
				"Put one or more questions to the user and get the answers this turn; use it instead of ending a reply or report with a question. Batch related, self-contained questions. " +
				"Decisions: 2-4 options (none for free text), each clear on its own, the recommendation your evidence and project instructions support, first, labelled ' (Recommended)'; the UI adds a write-in, so never add \"Other\".",
			parameters: Type.Object({
				forward: Type.Optional(
					Type.Number({
						description: "A child's message number: its question, word for word, above your first question",
					}),
				),
				questions: Type.Array(
					Type.Object({
						question: Type.String({ description: "One sentence; context goes in your reply first" }),
						header: Type.Optional(
							Type.String({
								description: "Tab label, ~12 characters shown",
							}),
						),
						options: Type.Optional(
							Type.Array(
								Type.Object({
									label: Type.String({ description: "Concise answer label" }),
									description: Type.Optional(
										Type.String({
											description: "Its distinguishing effect or trade-off",
										}),
									),
								}),
							),
						),
						multiSelect: Type.Optional(
							Type.Boolean({
								description: "true: the user may pick several",
							}),
						),
					}),
				),
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				// multiSelect means nothing without options: a free-text question opens its editor directly.
				let skippedOptions = 0;
				const dropped = { duplicate: 0, other: 0, over: 0 };
				const questions: AskQuestion[] = params.questions
					.filter((q) => q.question.trim())
					.map((q) => {
						const labelled = (q.options ?? []).filter((option) => option.label.trim());
						skippedOptions += (q.options?.length ?? 0) - labelled.length;
						const seen = new Set<string>();
						const options = labelled.filter((option) => {
							// Identical options only: a repeated label with its own description stays, told apart by its number.
							const key = `${option.label.trim().toLowerCase()}\n${option.description?.trim() ?? ""}`;
							if (seen.has(key)) dropped.duplicate += 1;
							else if (OTHER.test(option.label)) dropped.other += 1;
							else if (seen.size >= MAX_OPTIONS) dropped.over += 1;
							else return seen.add(key);
							return false;
						});
						return {
							...q,
							options,
							...(q.header ? { header: clip(q.header, 12) } : {}),
							...(options.length ? {} : { multiSelect: false }),
						};
					});
				if (questions.length === 0) throw new Error("Ask at least one question with text.");
				if (params.forward !== undefined) {
					const stored = storedQuestion?.(params.forward) ?? { error: "no message store in this session" };
					if ("error" in stored) throw new Error(`Cannot forward message #${params.forward}: ${stored.error}.`);
					questions[0] = {
						...questions[0],
						question: `${stored.from} asks (message #${params.forward}):\n${stored.text}\n\n${questions[0].question}`,
						forwarded: {
							label: `${stored.from} asks (message #${params.forward}):`,
							text: stored.text,
							ask: questions[0].question,
						},
					};
				}
				const result: AskResult = signal?.aborted
					? { answers: [], cancelled: true, reason: "aborted" }
					: !ctx.hasUI
						? { answers: [], cancelled: true, reason: "unavailable" }
						: await withDialog(
								() =>
									ctx.mode === "tui" ? showAskDialog(ctx, questions, signal) : askWithDialogs(ctx, questions, signal),
								signal,
							);
				// Empty questions and options are not asked: say how many, so a missing answer is not mistaken for a skipped one.
				const skippedQuestions = params.questions.length - questions.length;
				const skipped = [
					skippedQuestions > 0 && plural(skippedQuestions, "empty question"),
					skippedOptions > 0 && plural(skippedOptions, "option with an empty label", "options with an empty label"),
					dropped.duplicate > 0 && plural(dropped.duplicate, "duplicate option"),
					dropped.other > 0 && `${plural(dropped.other, '"Other" option')} (the UI adds a write-in)`,
					dropped.over > 0 &&
						plural(dropped.over, `option past the first ${MAX_OPTIONS}`, `options past the first ${MAX_OPTIONS}`),
				].filter(Boolean);
				const note = skipped.length > 0 ? `\n(Not asked: ${skipped.join(" and ")}.)` : "";
				return { content: [{ type: "text", text: `${formatAnswers(result)}${note}` }], details: result };
			},
			renderCall(args, theme, context) {
				const questions = args.questions ?? [];
				const headers = questions
					// oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- arguments are model output, unvalidated while the call renders
					.map((q) => clip(String(q?.header ?? ""), 24))
					.filter(Boolean)
					.join(", ");
				// Without headers the row names the first question, so the transcript shows what was asked.
				// oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- arguments are model output, unvalidated while the call renders
				const first = String(questions[0]?.question ?? "")
					.split("\n")[0]
					.trim();
				const more = questions.length > 1 ? ` +${questions.length - 1} more` : "";
				const what = headers || (first ? `${clip(first, 80)}${more}` : "");
				// The question is open on screen until the user answers: it waits on them (`◇`, breathing). Once answered the header
				// is its phase's `✓`; a declined or interrupted question was recorded by `renderResult`.
				const open = context.isPartial && context.executionStarted;
				const state = sharedRowState(context) ?? (open ? "waiting" : undefined);
				return toolHeader(theme, context, "Ask", what, state ? { state } : {});
			},
			renderResult(result, _options, theme, context) {
				const details = result.details as Partial<AskResult> | undefined;
				const answers = Array.isArray(details?.answers) ? details.answers : [];
				// Every answer is shown, collapsed or not: the user just gave them and there are at most four.
				const lines = answers.map(
					(entry) =>
						// oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- recorded details are read back from the session and may predate the current shape
						`${stateMark(theme, "done")} ${theme.fg("muted", clip(String(entry.question), 120))} ${theme.fg("dim", "→")} ${clip(String(entry.answer), 200)}`,
				);
				// Declined or unavailable: `✗`; interrupted: `◼`. The same state marks the header.
				const refused: UiState | undefined = !details?.cancelled
					? undefined
					: details.reason === "aborted"
						? "stopped"
						: "failed";
				shareRowState(context, refused);
				if (refused)
					lines.push(
						`${stateMark(theme, refused)} ${theme.fg(
							STATE_COLOR[refused],
							details?.reason === "unavailable"
								? "Unavailable"
								: details?.reason === "aborted"
									? "Interrupted"
									: lines.length > 0
										? "Declined the remaining questions"
										: "Declined",
						)}`,
					);
				const fallback =
					lines.length === 0
						? clip(result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"), 200)
						: "";
				if (fallback) lines.push(theme.fg("toolOutput", fallback));
				return resultBlock(theme, context, { summary: "", lines, max: lines.length, ...timingOf(result.details) });
			},
		}),
	);
}
