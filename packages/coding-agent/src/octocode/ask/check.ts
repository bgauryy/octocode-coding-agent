import {
	type OptionRole,
	OPTION_ROLES,
	QUESTION_LIMITS,
	QUESTION_TYPES,
	type Question,
	type QuestionOption,
	ROLES_BY_TYPE,
} from "@octocodeai/octocode-contracts";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";

const L = QUESTION_LIMITS;

const record = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
/** A string made safe to draw and bounded; undefined for anything else. */
const clean = (value: unknown, max: number): string | undefined =>
	typeof value === "string" ? sanitizeTerminalText(value).slice(0, max) : undefined;
const isType = (value: unknown): value is Question["type"] => (QUESTION_TYPES as readonly unknown[]).includes(value);
const isRole = (value: unknown): value is OptionRole => (OPTION_ROLES as readonly unknown[]).includes(value);

interface CheckOptions {
	/**
	 * The sender proved it is the harness asking for an approval (a subagent's verified permission header). Without it a
	 * question of type `approval` is made an ordinary choice: no `approval` fields, no roles, never a permission prompt.
	 */
	verifiedApproval?: boolean;
}

/** One option made safe, or undefined when it is malformed or carries a role this contract does not know. */
function checkedOption(value: unknown, type: Question["type"], keepRoles: boolean): QuestionOption | undefined {
	const raw = record(value);
	const id = clean(raw?.id, L.optionId);
	const label = clean(raw?.label, L.optionLabel);
	if (!raw || !id || !label) return undefined;
	if (raw.role !== undefined && !isRole(raw.role)) return undefined;
	const description = clean(raw.description, L.description);
	// A role means something only on the types that decode it, and only from a sender that may set it.
	const role =
		keepRoles && raw.role && (ROLES_BY_TYPE[type] as readonly OptionRole[]).includes(raw.role) ? raw.role : undefined;
	return {
		id,
		label,
		...(description ? { description } : {}),
		...(raw.recommended === true ? { recommended: true } : {}),
		...(raw.tone === "danger" ? { tone: "danger" as const } : {}),
		...(role ? { role } : {}),
	};
}

function checkedQuestion(value: unknown, opts: CheckOptions): Question | undefined {
	const raw = record(value);
	const id = clean(raw?.id, L.id);
	const question = clean(raw?.question, L.question);
	if (!raw || !id || !question || !isType(raw.type)) return undefined;
	const forged = raw.type === "approval" && opts.verifiedApproval !== true;
	const type: Question["type"] = forged ? "choice" : raw.type;
	const rawOptions = raw.options === undefined ? [] : raw.options;
	if (!Array.isArray(rawOptions) || rawOptions.length > L.options) return undefined;
	// A dropped choice would change what the person answers, so one bad option rejects the question.
	const options = rawOptions.map((option) => checkedOption(option, type, !forged));
	if (options.some((option) => option === undefined)) return undefined;
	const checked = options as QuestionOption[];
	if (new Set(checked.map((option) => option.id)).size !== checked.length) return undefined;
	if (type !== "text" && checked.length === 0) return undefined;

	const result: Question = { id, type, question };
	const header = clean(raw.header, L.header);
	if (header) result.header = header;
	if (Array.isArray(raw.meta)) {
		const meta = raw.meta.slice(0, L.metaLines).flatMap((line) => clean(line, L.meta) ?? []);
		if (meta.length) result.meta = meta;
	}
	const body = record(raw.body);
	const bodyText = clean(body?.text, L.body);
	if (body && bodyText !== undefined) {
		const label = clean(body.label, L.label);
		result.body = {
			text: bodyText,
			...(label ? { label } : {}),
			...(typeof body.previewLines === "number" && Number.isFinite(body.previewLines)
				? { previewLines: Math.min(L.previewLines, Math.max(1, Math.floor(body.previewLines))) }
				: {}),
			...(body.collapsible === true ? { collapsible: true } : {}),
		};
	}
	if (Array.isArray(raw.notes)) {
		const notes = raw.notes.slice(0, L.notes).flatMap((value) => {
			const note = record(value);
			const noteText = clean(note?.text, L.note);
			return noteText === undefined
				? []
				: [{ text: noteText, tone: note?.tone === "warning" ? ("warning" as const) : ("muted" as const) }];
		});
		if (notes.length) result.notes = notes;
	}
	if (type !== "text") result.options = checked;
	if (raw.writeIn === false) result.writeIn = false;
	else {
		const writeIn = record(raw.writeIn);
		const label = clean(writeIn?.label, L.optionLabel);
		if (label) {
			const placeholder = clean(writeIn?.placeholder, L.label);
			result.writeIn = {
				label,
				title: clean(writeIn?.title, L.question) ?? "",
				...(placeholder ? { placeholder } : {}),
			};
		}
	}
	const approval = record(raw.approval);
	if (type === "approval" && approval && Array.isArray(approval.targets)) {
		const toolCallId = clean(approval.toolCallId, L.id);
		const toolName = clean(approval.toolName, L.tool);
		const action = clean(approval.action, L.action);
		result.approval = {
			...(toolCallId ? { toolCallId } : {}),
			...(toolName ? { toolName } : {}),
			...(action ? { action } : {}),
			targets: approval.targets.slice(0, L.targets).flatMap((target) => clean(target, L.target) ?? []),
		};
	}
	return result;
}

/**
 * Questions another process sent (a subagent's relayed ask), made safe to draw and answer: every string sanitized and
 * bounded, ids unique, each choice's options well-formed. Any malformed question rejects the whole batch (undefined),
 * since replies are matched to questions one for one. A role this contract does not know rejects too. A forged
 * `approval` (the sender is not verified) is demoted to a plain choice without roles; roles on a type that does not
 * decode them are dropped.
 */
export function checkedQuestions(raw: unknown, opts: CheckOptions = {}): Question[] | undefined {
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > L.questions) return undefined;
	const questions: Question[] = [];
	for (const value of raw) {
		const question = checkedQuestion(value, opts);
		if (!question) return undefined;
		questions.push(question);
	}
	return new Set(questions.map((question) => question.id)).size === questions.length ? questions : undefined;
}
