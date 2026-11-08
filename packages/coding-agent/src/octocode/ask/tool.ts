import { renderInstruction } from "../../core/prompt-template.ts";
import { StringEnum } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/features/index.ts";
import { STATE_COLOR, stateMark, type UiState } from "../../theme/status.ts";
import { resultBlock, toolHeader } from "../shared/render.ts";
import { shareRowState, sharedRowState } from "../shared/row-mark.ts";
import { clip, plural } from "../shared/render/text.ts";
import { timedTool, timingOf } from "../shared/render/rows.ts";
import { answerLine } from "../shared/ask-answer.ts";
import { ask } from "./ask.ts";
import { askUserResult } from "./decode.ts";
import type { AskQuestion, AskResult } from "./dialog/answers.ts";
import { fromAskUser } from "./question.ts";

/** The most options one question offers; the UI adds the write-in. The schema, the description and the code all use it. */
const MAX_OPTIONS = 4;
/** The most questions one call asks (the result renderer lays out this many). */
const MAX_QUESTIONS = 4;
/** What a question asks for: free text, one option, or several. */
const QUESTION_TYPES = ["text", "choice", "multi"] as const;
/** An option the UI already offers as its write-in row. */
const OTHER = /^\s*(other|something else)\b/i;

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
				`Decisions: 2-${MAX_OPTIONS} options (none for free text), each clear on its own, the recommendation your evidence and project instructions support, first, labelled ' (Recommended)'; the UI adds a write-in, so never add "Other". At most ${MAX_QUESTIONS} questions.`,
			parameters: Type.Object({
				forward: Type.Optional(
					Type.Number({
						description: "A child's message number: its question, word for word, above your first question",
					}),
				),
				questions: Type.Array(
					Type.Object({
						question: Type.String({ description: "One short sentence" }),
						header: Type.Optional(
							Type.String({
								description: "Tab label, ~12 characters shown",
							}),
						),
						options: Type.Optional(
							Type.Array(
								Type.Object({
									label: Type.String({ description: "A few words" }),
									description: Type.Optional(
										Type.String({
											description: "Its distinguishing effect or trade-off",
										}),
									),
								}),
							),
						),
						type: Type.Optional(
							StringEnum(QUESTION_TYPES, { description: "multi: pick several; default choice, text without options" }),
						),
					}),
				),
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				// `type` text, or no options, is a free-text question that opens its editor directly; multi means nothing without options.
				let skippedOptions = 0;
				const dropped = { duplicate: 0, other: 0, over: 0 };
				const asked = params.questions.slice(0, MAX_QUESTIONS);
				const questions: AskQuestion[] = asked
					.filter((q) => q.question.trim())
					.map((q) => {
						const labelled = q.type === "text" ? [] : (q.options ?? []).filter((option) => option.label.trim());
						skippedOptions += q.type === "text" ? 0 : (q.options?.length ?? 0) - labelled.length;
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
							question: q.question,
							options,
							...(q.header ? { header: clip(q.header, 12) } : {}),
							...(options.length > 0 && q.type === "multi" ? { multiSelect: true } : {}),
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
				const asking = fromAskUser(questions);
				const result: AskResult = askUserResult(asking, await ask(ctx, asking, signal ? { signal } : {}));
				// Empty questions and options are not asked: say how many, so a missing answer is not mistaken for a skipped one.
				const skippedQuestions = asked.length - questions.length;
				const overQuestions = params.questions.length - asked.length;
				const skipped = [
					skippedQuestions > 0 && plural(skippedQuestions, "empty question"),
					overQuestions > 0 &&
						plural(
							overQuestions,
							`question past the first ${MAX_QUESTIONS}`,
							`questions past the first ${MAX_QUESTIONS}`,
						),
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
