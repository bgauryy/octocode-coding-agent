import { type Static, Type } from "typebox";
import { StringEnum } from "./schema.ts";

/**
 * One question Octocode puts to a person. `type` alone decides how it is drawn, which keys answer it, how it is
 * announced (an `approval` is a permission prompt) and which option roles its decoder accepts. Serializable and bounded:
 * it crosses processes (RPC, ACP, the web workspace, a subagent's relay), so every string and array has a limit.
 */
export const QUESTION_TYPES = ["text", "choice", "multi", "confirm", "approval"] as const;
export const OPTION_ROLES = ["allow_once", "allow_session", "allow_kind", "deny", "deny_note", "yes", "no"] as const;
export const CANCEL_REASONS = ["declined", "aborted", "unavailable", "timeout"] as const;

/** The roles each type may carry; a role on any other type means nothing and is never decoded. */
export const ROLES_BY_TYPE = {
	text: [],
	choice: [],
	multi: [],
	confirm: ["yes", "no"],
	approval: ["allow_once", "allow_session", "allow_kind", "deny", "deny_note"],
} as const satisfies Record<(typeof QUESTION_TYPES)[number], readonly (typeof OPTION_ROLES)[number][]>;

/** Bounds, shared by the schemas below and by the sanitizer in front of a question another process sent. */
export const QUESTION_LIMITS = {
	questions: 8,
	id: 128,
	optionId: 64,
	question: 20_000,
	header: 100,
	metaLines: 12,
	meta: 400,
	body: 20_000,
	label: 400,
	previewLines: 100,
	notes: 12,
	note: 800,
	options: 50,
	optionLabel: 200,
	description: 400,
	targets: 100,
	target: 4000,
	action: 64,
	tool: 128,
	text: 20_000,
} as const;
const L = QUESTION_LIMITS;

export const QuestionTypeSchema = StringEnum(QUESTION_TYPES);
export const OptionRoleSchema = StringEnum(OPTION_ROLES);

export const QuestionOptionSchema = Type.Object({
	id: Type.String({ minLength: 1, maxLength: L.optionId }),
	label: Type.String({ minLength: 1, maxLength: L.optionLabel }),
	/** What choosing it does. */
	description: Type.Optional(Type.String({ maxLength: L.description })),
	recommended: Type.Optional(Type.Boolean()),
	tone: Type.Optional(Type.Literal("danger")),
	/** What the option means to the harness, so no one decodes a label. Only the types in `ROLES_BY_TYPE` use one. */
	role: Type.Optional(OptionRoleSchema),
});

export const QuestionSchema = Type.Object({
	id: Type.String({ minLength: 1, maxLength: L.id }),
	type: QuestionTypeSchema,
	/** The full text, never clipped in transport. */
	question: Type.String({ minLength: 1, maxLength: L.question }),
	/** The tab label of a batch. */
	header: Type.Optional(Type.String({ maxLength: L.header })),
	/** Dim lines under the question: who asks, from where. */
	meta: Type.Optional(Type.Array(Type.String({ maxLength: L.meta }), { maxItems: L.metaLines })),
	body: Type.Optional(
		Type.Object({
			text: Type.String({ maxLength: L.body }),
			label: Type.Optional(Type.String({ maxLength: L.label })),
			/** The body is long text a client may fold; approved targets are never collapsible. */
			collapsible: Type.Optional(Type.Boolean()),
			previewLines: Type.Optional(Type.Integer({ minimum: 1, maximum: L.previewLines })),
		}),
	),
	/** The details block (effect, undo, why it asks, risk), shown on demand. */
	notes: Type.Optional(
		Type.Array(
			Type.Object({
				text: Type.String({ maxLength: L.note }),
				tone: Type.Union([Type.Literal("muted"), Type.Literal("warning")]),
			}),
			{ maxItems: L.notes },
		),
	),
	/** choice, multi, confirm and approval; a text question has none. */
	options: Type.Optional(Type.Array(QuestionOptionSchema, { maxItems: L.options })),
	/** The row that opens free text beside the options (or, for `text`, the editor's title and placeholder); false: none. */
	writeIn: Type.Optional(
		Type.Union([
			Type.Object({
				label: Type.String({ maxLength: L.optionLabel }),
				title: Type.String({ maxLength: L.question }),
				placeholder: Type.Optional(Type.String({ maxLength: L.label })),
			}),
			Type.Literal(false),
		]),
	),
	/** Only the harness builds this; the action the person is asked to allow. */
	approval: Type.Optional(
		Type.Object({
			toolCallId: Type.Optional(Type.String({ maxLength: L.id })),
			toolName: Type.Optional(Type.String({ maxLength: L.tool })),
			action: Type.Optional(Type.String({ maxLength: L.action })),
			targets: Type.Array(Type.String({ maxLength: L.target }), { maxItems: L.targets }),
		}),
	),
});

export const QuestionsSchema = Type.Array(QuestionSchema, { minItems: 1, maxItems: L.questions });

/** The answer to one question: the ids of the options picked and any typed text, or why there is none. */
export const ReplySchema = Type.Union([
	Type.Object({
		id: Type.String({ minLength: 1, maxLength: L.id }),
		picks: Type.Array(Type.String({ maxLength: L.optionId }), { maxItems: L.options }),
		/** A write-in's text, or the answer to a `text` question. */
		text: Type.Optional(Type.String({ maxLength: L.text })),
	}),
	Type.Object({
		id: Type.String({ minLength: 1, maxLength: L.id }),
		cancelled: StringEnum(CANCEL_REASONS),
	}),
]);

export type QuestionType = (typeof QUESTION_TYPES)[number];
export type OptionRole = (typeof OPTION_ROLES)[number];
export type CancelReason = (typeof CANCEL_REASONS)[number];
export type QuestionOption = Static<typeof QuestionOptionSchema>;
export type Question = Static<typeof QuestionSchema>;
export type Reply = Static<typeof ReplySchema>;
