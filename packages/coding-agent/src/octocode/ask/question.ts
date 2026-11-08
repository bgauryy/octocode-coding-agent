import type { OptionRole, Question, QuestionOption } from "@octocodeai/octocode-contracts";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import type { ExtensionUIAskOptions } from "../../core/features/types.ts";
import { type AskView, isRecommended } from "../shared/ask-view.ts";
import { type AskQuestion, SUBMIT_PICKS, TYPE_OWN } from "./dialog/answers.ts";

/** Builders for the one `Question` and its render projection `viewOf`; `decode.ts` reads the replies back. */

/** How a host asks: `signal` dismisses the dialogs, `blocking` marks work waiting on the person, `timeout` is milliseconds, `header` a subagent's permission header. */
export type AskOptions = ExtensionUIAskOptions;

const YES = "Yes";
const NO = "No";

/** The id of the option at `index` of a question built from plain labels: `1`, `2`, … */
const optionId = (index: number): string => String(index + 1);

/** The write-in a choice or multi question offers beside its options (askUser's "Write an answer" row). */
const writeInOf = (question: string): NonNullable<Question["writeIn"]> => ({ label: TYPE_OWN, title: question });

/**
 * askUser's questions as `Question`s with ids `q1`, `q2`, …: text when it has no options, multi when `multiSelect`, else
 * choice. A label ending in "(Recommended)" marks its option recommended (the label keeps the suffix, as the model wrote
 * it). The write-in row is offered as today. A forwarded child question leads `question` with its label and text, as the
 * answer line has always read it, and travels again as the body: `viewOf` draws only the parent's own question bold.
 */
export function fromAskUser(questions: readonly AskQuestion[]): Question[] {
	return questions.map((q, index): Question => {
		const id = `q${index + 1}`;
		const header = q.header ? { header: q.header } : {};
		const body = q.forwarded ? { body: { label: q.forwarded.label, text: q.forwarded.text, collapsible: true } } : {};
		if (q.options.length === 0) return { id, type: "text", question: q.question, ...header, ...body };
		return {
			id,
			type: q.multiSelect ? "multi" : "choice",
			question: q.question,
			...header,
			...body,
			options: q.options.map((option, at) => ({
				id: optionId(at),
				label: option.label,
				...(option.description ? { description: option.description } : {}),
				...(isRecommended(option.label) ? { recommended: true } : {}),
			})),
			writeIn: writeInOf(q.question),
		};
	});
}

/** A choice of plain labels, or of options with descriptions; `extra` sets anything else (header, body, a write-in). */
export function choice(
	id: string,
	question: string,
	options: readonly (string | Omit<QuestionOption, "id">)[],
	extra: Partial<Omit<Question, "id" | "type" | "question" | "options">> = {},
): Question {
	return {
		id,
		type: "choice",
		question,
		...extra,
		options: options.map((option, index) => ({
			id: optionId(index),
			...(typeof option === "string" ? { label: option } : option),
		})),
	};
}

/** A yes/no question; `message` is its detail. */
export function confirm(id: string, question: string, message?: string): Question {
	return {
		id,
		type: "confirm",
		question,
		...(message ? { body: { text: message } } : {}),
		options: [
			{ id: "yes", label: YES, role: "yes" },
			{ id: "no", label: NO, role: "no" },
		],
	};
}

/** A free-text question; `placeholder` hints the editor. */
export function text(id: string, question: string, placeholder?: string): Question {
	return {
		id,
		type: "text",
		question,
		...(placeholder ? { writeIn: { label: TYPE_OWN, title: question, placeholder } } : {}),
	};
}

/**
 * The permission prompt as a question. `view` is the card `permission/ask/view.ts` builds for the request (title,
 * metadata, targets, effect card, what each choice does, the deny-with-a-note write-in): its content is reused whole, never
 * rebuilt here. `roles` names what each option label means, so no one decodes a label; ids are the role names. `approval`
 * is the action asked about. Only harness code builds one.
 */
export function approvalQuestion(input: {
	id: string;
	view: AskView;
	roles: Readonly<Record<string, OptionRole>>;
	approval: NonNullable<Question["approval"]>;
}): Question {
	const { id, view, roles, approval } = input;
	return {
		id,
		type: "approval",
		question: view.question,
		...(view.meta ? { meta: view.meta } : {}),
		...(view.body ? { body: view.body } : {}),
		...(view.notes ? { notes: view.notes } : {}),
		options: view.options.map((option, index) => {
			const role = roles[option.label];
			return { id: role ?? optionId(index), ...option, ...(role ? { role } : {}) };
		}),
		...(view.writeIn !== undefined ? { writeIn: view.writeIn } : {}),
		approval,
	};
}

/** A forwarded child question's leading text: `label`, then the child's text, then a blank line. */
const forwardedLead = (q: Question): string | undefined =>
	q.body?.label !== undefined ? `${q.body.label}\n${q.body.text}\n\n` : undefined;

/**
 * The question as the card `ask/card.ts` draws: its text bold (a forwarded child's text is the body, so only the parent's
 * own question), its metadata, body and effect notes, its options and then, when the write-in is not already one of them,
 * the write-in row (and a multi question's submit row). The same view `permissionView` and askUser's `questionView`
 * give for the same content.
 */
export function viewOf(q: Question): AskView {
	const lead = forwardedLead(q);
	const question = lead && q.question.startsWith(lead) ? q.question.slice(lead.length) : q.question;
	const rows: AskView["options"] = (q.options ?? []).map((option) => ({
		label: option.label,
		...(option.description ? { description: option.description } : {}),
		...(option.recommended ? { recommended: true } : {}),
		...(option.tone ? { tone: option.tone } : {}),
	}));
	const writeIn = q.writeIn ? q.writeIn : undefined;
	if (writeIn && q.type !== "text" && !rows.some((row) => row.label === writeIn.label))
		rows.push({ label: writeIn.label });
	if (q.type === "multi") rows.push({ label: SUBMIT_PICKS });
	return {
		question,
		...(q.meta?.length ? { meta: q.meta } : {}),
		...(q.body ? { body: q.body } : {}),
		...(q.notes?.length ? { notes: q.notes } : {}),
		options: rows,
		...(q.writeIn !== undefined ? { writeIn: q.writeIn } : {}),
		...(q.type === "multi" ? { multiSelect: true } : {}),
	};
}

/** The line an approval's metadata carries for what the agent says: unverified, so plain text puts it after the system's lines. */
const AGENT_SAYS = "agent says (unverified):";

/** One line of agent-chosen text: line breaks shown as `⏎`, so it cannot forge a line of its own. */
const folded = (text: string): string => sanitizeTerminalText(text.replace(/\r\n|\r|\n/g, "⏎"));

/**
 * The question as plain text for a host that draws no card: the question, its metadata, body and effect lines. An
 * approval shows each target it asks about on one line (breaks as `⏎`), then the system's effect lines led by `▸`, which
 * agent text cannot forge (one line each, after them), and what the agent says about its purpose last.
 */
export function plainTitle(q: Question): string {
	if (q.type !== "approval") {
		return sanitizeTerminalText(
			[
				q.question,
				...(q.meta ?? []),
				...(q.body && q.body.label === undefined ? q.body.text.split("\n").map((line) => `  ${line}`) : []),
				...(q.notes ?? []).map((note) => `  ${note.text}`),
			].join("\n"),
		);
	}
	const targets = q.approval?.targets ?? [];
	const agent = (q.meta ?? []).filter((line) => line.startsWith(AGENT_SAYS));
	const other = (q.meta ?? []).filter((line) => !agent.includes(line));
	const shown = targets.length > 0 ? targets.map(folded) : [...other, ...(q.body?.text.split("\n") ?? [])];
	// Who is asking (a relayed prompt's subagent) is shown even when the targets stand in for the body.
	const lead = targets.length > 0 ? other.filter((line) => !shown.some((target) => target.includes(line))) : [];
	const lines = [
		q.question,
		...lead.map((line) => `  ${line}`),
		...shown.map((line) => `  ${line}`),
		...(q.notes ?? []).map((note) => `  ▸ ${note.text}`),
		...agent.map((line) => `  ${line}`),
	];
	return sanitizeTerminalText(lines.join("\n"));
}
