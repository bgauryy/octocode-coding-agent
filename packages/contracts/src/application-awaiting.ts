import { Type } from "typebox";

/**
 * A blocking dialog the run waits on: an approval, or a question or other input. With `id` a client may answer it with
 * the `answer` command: one of `options` (an approval's choices are the host's own words), or `text` where
 * `allowsText`. Without `id` only the terminal can answer (an older host, or an editor or custom dialog).
 */
export const AwaitingSchema = Type.Object({
	kind: Type.Union([Type.Literal("approval"), Type.Literal("question")]),
	title: Type.Optional(Type.String({ maxLength: 200 })),
	id: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
	options: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 50 })),
	allowsText: Type.Optional(Type.Boolean()),
	/** The terminal ask card's content, so a client can draw what the terminal draws. All optional: older clients ignore it. */
	meta: Type.Optional(Type.Array(Type.String({ maxLength: 400 }), { maxItems: 12 })),
	body: Type.Optional(
		Type.Object({
			text: Type.String({ maxLength: 20000 }),
			label: Type.Optional(Type.String({ maxLength: 400 })),
			/** The body is long text a client may fold; approved targets are never collapsible. */
			collapsible: Type.Optional(Type.Boolean()),
			previewLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
		}),
	),
	/** The details block (effect, undo, why it asks, risk), shown on demand. */
	details: Type.Optional(
		Type.Array(
			Type.Object({
				text: Type.String({ maxLength: 800 }),
				tone: Type.Union([Type.Literal("muted"), Type.Literal("warning")]),
			}),
			{ maxItems: 12 },
		),
	),
	/** One entry per `options` entry, same order: what the choice does. */
	optionInfo: Type.Optional(
		Type.Array(
			Type.Object({
				description: Type.Optional(Type.String({ maxLength: 400 })),
				recommended: Type.Optional(Type.Boolean()),
				danger: Type.Optional(Type.Boolean()),
			}),
			{ maxItems: 50 },
		),
	),
	/** The option that opens a free-text step (a second `awaiting` that allows text) instead of answering at once. */
	writeIn: Type.Optional(Type.String({ maxLength: 200 })),
});
