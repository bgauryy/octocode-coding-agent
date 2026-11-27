import { GLYPH } from "@octocodeai/octocode-tui/text";
import { textResultDisplay } from "../../../render/display.ts";
import { renderPrompt } from "../../../../core/prompt-template.ts";
import { StringEnum } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import type { FeatureSetup } from "../../../../core/features/index.ts";
import { STATE_COLOR, stateMark, type UiState } from "../../../../theme/status.ts";
import { resultBlock, toolHeader } from "../../../render/tool.ts";
import { shareRowState, sharedRowState } from "../../../render/row-mark.ts";
import { clip, plural } from "../../../shared/text.ts";
import { timedTool, timingOf } from "../../../render/rows.ts";
import { answerLine } from "../../../shared/ask-answer.ts";
import { isRecommended } from "../../../shared/ask-view.ts";
import { ask } from "../../../ask/ask.ts";
import { askUserResult } from "../../../ask/decode.ts";
import type { AskQuestion, AskResult } from "../../../ask/dialog/answers.ts";
import { fromAskUser } from "../../../ask/question.ts";

/** The most options one question offers; the UI adds the write-in. The schema, the description and the code all use it. */
const MAX_OPTIONS = 4;
/** The longest `timeout`, in seconds: an hour. */
const MAX_TIMEOUT = 3600;
/** The most questions one call asks (the result renderer lays out this many). */
const MAX_QUESTIONS = 4;
/** What a question asks for: free text, one option, or several. */
const QUESTION_TYPES = ["text", "choice", "multi"] as const;
/** An option that is only the write-in row the UI already offers: a bare "Other" or "Other (specify)", not "Other tools only". */
const OTHER = /^\s*(other|something else)\s*(\([^)]*\))?\s*:?\s*$/i;

export function formatAnswers(result: AskResult): string {
	const answered = result.answers.map(answerLine);
	// A default the host took is not the user's yes: the model is told so beside the answers.
	if (result.answers.some((entry) => entry.auto)) answered.push(renderPrompt("tools/ask-user/auto.md").trim());
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

export function registerAskUser(api: FeatureSetup, storedQuestion?: StoredQuestion): void {
	api.tools.register(
		timedTool({
			name: "askUser",
			roleVariant: true,
			label: "Ask user",
			promptSnippet: renderPrompt("tools/ask-user/snippet.md"),
			description: `Ask for decisions, approvals or facts here to get answers this turn. Group up to ${MAX_QUESTIONS} questions. For decisions give 2-${MAX_OPTIONS} options with trade-offs, first labelled ' (Recommended)'. The UI adds write-in. Only routine questions may time out to the recommendation.`,
			parameters: Type.Object({
				forward: Type.Optional(
					Type.Number({
						description: "A child's message number: its question leads yours",
					}),
				),
				timeout: Type.Optional(Type.Integer({ description: "Seconds" })),
				questions: Type.Array(
					Type.Object({
						question: Type.String({ description: "One sentence" }),
						header: Type.Optional(
							Type.String({
								description: "Tab label",
							}),
						),
						options: Type.Optional(
							Type.Array(
								Type.Object({
									label: Type.String({ description: "Few words" }),
									description: Type.String({
										description: "Trade-off, evidence",
									}),
								}),
							),
						),
						type: Type.Optional(
							StringEnum(QUESTION_TYPES, {
								description: "multi: pick several",
							}),
						),
					}),
				),
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				// `type` text, or no options, is a free-text question that opens its editor directly; multi means nothing without options.
				let skippedOptions = 0;
				const dropped = { duplicate: 0, other: 0, over: 0 };
				if (params.timeout !== undefined && (params.timeout < 1 || params.timeout > MAX_TIMEOUT))
					throw new Error(
						`askUser timeout must be a whole number of seconds from 1 to ${MAX_TIMEOUT}; got ${params.timeout}. Omit it to wait for the answer.`,
					);
				if (params.questions.length > MAX_QUESTIONS)
					throw new Error(
						`askUser takes at most ${MAX_QUESTIONS} questions; got ${params.questions.length}. Ask the ${MAX_QUESTIONS} that matter most, then ask the rest after the answers.`,
					);
				const asked = params.questions;
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
						const unexplained = q.type === "text" ? undefined : options.find((option) => !option.description?.trim());
						if (unexplained)
							throw new Error(
								`askUser option "${clip(unexplained.label, 40)}" of "${clip(q.question, 60)}" has no reason; give every option a description: why to pick it (its evidence or trade-off).`,
							);
						// The recommended option leads: the card lists it first.
						options.sort((a, b) => Number(isRecommended(b.label)) - Number(isRecommended(a.label)));
						if (params.timeout !== undefined && !options.some((option) => isRecommended(option.label)))
							throw new Error(
								`askUser timeout needs a recommended option on every question; "${clip(q.question, 60)}" has none${q.type === "text" || options.length === 0 ? " (a free-text question cannot time out)" : ""}. Add an option labelled '(Recommended)' with its reason, or drop timeout.`,
							);
						// Free text takes no options; a choice needs a real alternative.
						if (q.type !== "text" && (q.options?.length ?? 0) > 0 && options.length === 1)
							throw new Error(
								`askUser question "${clip(q.question, 60)}" has one usable option; give 2-${MAX_OPTIONS} distinct options, or none for free text.`,
							);
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
				const asking = fromAskUser(questions, params.timeout);
				const result: AskResult = askUserResult(asking, await ask(ctx, asking, signal ? { signal } : {}));
				// Empty questions and options are not asked: say how many, so a missing answer is not mistaken for a skipped one.
				const skippedQuestions = asked.length - questions.length;
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
			display(input) {
				const questions = input.args.questions ?? [];
				const headers = questions
					.map((q) => q?.header ?? "")
					.filter(Boolean)
					.join(", ");
				// oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- arguments are model output, unvalidated while the call renders
				const first = String(questions[0]?.question ?? "")
					.split("\n")[0]
					.trim();
				const more = questions.length > 1 ? ` +${questions.length - 1} more` : "";
				const summary = headers || (first ? `${first}${more}` : "");
				const head = { title: "Ask", ...(summary ? { summary } : {}), kind: "other" as const, blocks: [] };
				if (!input.result) return { ...head, state: "waiting" as const };
				const details = input.result.details as Partial<AskResult> | undefined;
				const answers = Array.isArray(details?.answers) ? details.answers : [];
				const refused = !details?.cancelled
					? undefined
					: details.reason === "aborted"
						? ("stopped" as const)
						: ("failed" as const);
				const items: Array<{ text: string; state: UiState }> = answers.map((entry) => ({
					// oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- recorded details may predate the current shape
					text: `${String(entry.question)} → ${String(entry.answer)}${entry.auto ? " (auto)" : ""}`,
					state: "done" as const,
				}));
				if (refused)
					items.push({
						text:
							details?.reason === "unavailable"
								? "Unavailable"
								: details?.reason === "aborted"
									? "Interrupted"
									: items.length > 0
										? "Declined the remaining questions"
										: "Declined",
						state: refused,
					});
				if (items.length === 0) return textResultDisplay(head, input);
				return {
					...head,
					...(refused ? { state: refused } : {}),
					blocks: [{ type: "list" as const, text: items.map((item) => item.text).join("\n"), items }],
				};
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
						`${stateMark(theme, "done")} ${theme.fg("muted", clip(String(entry.question), 120))} ${theme.fg("dim", GLYPH.arrow)} ${clip(String(entry.answer), 200)}${entry.auto ? theme.fg("dim", " (auto: timed out)") : ""}`,
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
