import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { ApplicationAssetSchema } from "./content.ts";

/** A row's lifecycle mark, shared by every surface (the terminal library keeps a structural copy). */
export const UiStateSchema = Type.Union([
	Type.Literal("pending"),
	Type.Literal("running"),
	Type.Literal("waiting"),
	Type.Literal("done"),
	Type.Literal("failed"),
	Type.Literal("stopped"),
]);
export type UiState = Static<typeof UiStateSchema>;

/** Semantic emphasis; each surface maps it to its own colors. */
export const ToneSchema = Type.Union([
	Type.Literal("normal"),
	Type.Literal("muted"),
	Type.Literal("success"),
	Type.Literal("warning"),
	Type.Literal("error"),
]);
export type Tone = Static<typeof ToneSchema>;

/** What a tool does, for icons and grouping; the same set as ACP's tool kinds plus `agent`. */
export const ToolKindSchema = Type.Union([
	Type.Literal("read"),
	Type.Literal("edit"),
	Type.Literal("delete"),
	Type.Literal("move"),
	Type.Literal("search"),
	Type.Literal("execute"),
	Type.Literal("fetch"),
	Type.Literal("think"),
	Type.Literal("agent"),
	Type.Literal("other"),
]);
export type ToolKind = Static<typeof ToolKindSchema>;

/** Every block carries `text`: its plain rendering, the fallback for a surface that does not know the block's type. */
const text = { text: Type.String() };
const full = { full: Type.Optional(ApplicationAssetSchema) };

const TextBlockSchema = Type.Object({
	type: Type.Literal("text"),
	...text,
	/** Which end a collapsed view keeps: the start (default) or the end (a log). */
	preview: Type.Optional(Type.Union([Type.Literal("head"), Type.Literal("tail")])),
	tone: Type.Optional(ToneSchema),
	...full,
});
const OutputBlockSchema = Type.Object({
	type: Type.Literal("output"),
	...text,
	command: Type.Optional(Type.String()),
	exitCode: Type.Optional(Type.Integer()),
	signal: Type.Optional(Type.String()),
	timedOut: Type.Optional(Type.Literal(true)),
	...full,
});
const DiffFileSchema = Type.Object({
	path: Type.String(),
	operation: Type.Union([Type.Literal("add"), Type.Literal("delete"), Type.Literal("modify"), Type.Literal("move")]),
	from: Type.Optional(Type.String()),
	additions: Type.Integer({ minimum: 0 }),
	removals: Type.Integer({ minimum: 0 }),
	/** Unified diff hunks; empty when the change has no text form. */
	patch: Type.String(),
});
const DiffBlockSchema = Type.Object({ type: Type.Literal("diff"), ...text, files: Type.Array(DiffFileSchema) });
const ListItemSchema = Type.Object({
	text: Type.String(),
	state: Type.Optional(UiStateSchema),
	tone: Type.Optional(ToneSchema),
	detail: Type.Optional(Type.String()),
});
const ListBlockSchema = Type.Object({ type: Type.Literal("list"), ...text, items: Type.Array(ListItemSchema) });
const FieldsBlockSchema = Type.Object({
	type: Type.Literal("fields"),
	...text,
	entries: Type.Array(Type.Object({ label: Type.String(), value: Type.String() })),
});
const MarkdownBlockSchema = Type.Object({ type: Type.Literal("markdown"), ...text, ...full });
const PathBlockSchema = Type.Object({
	type: Type.Literal("path"),
	...text,
	label: Type.String(),
	path: Type.String(),
});

/** The block types this version knows. */
export const KnownToolDisplayBlockSchema = Type.Union([
	TextBlockSchema,
	OutputBlockSchema,
	DiffBlockSchema,
	ListBlockSchema,
	FieldsBlockSchema,
	MarkdownBlockSchema,
	PathBlockSchema,
]);
export type KnownToolDisplayBlock = Static<typeof KnownToolDisplayBlockSchema>;
/** Any block, including a type a newer host added: a surface that does not know it shows its `text`. */
export const ToolDisplayBlockSchema = Type.Union([
	KnownToolDisplayBlockSchema,
	Type.Object({ type: Type.String({ minLength: 1 }), ...text }),
]);
export type ToolDisplayBlock = KnownToolDisplayBlock | { type: string; text: string };

export const ToolDisplaySchema = Type.Object({
	/** The tool's display name: `Bash`, `File`, `github/search_code`. */
	title: Type.String(),
	/** What this call does, in a few words: the command, the path and edit count, the query. */
	summary: Type.Optional(Type.String()),
	/** Short qualifiers after the summary: `background`, `timeout 60s`. */
	meta: Type.Optional(Type.Array(Type.String())),
	/** One line per sub-request of a batched call; views fold long lists. */
	subjects: Type.Optional(Type.Array(Type.String())),
	/** The goal the call states, decided on the host. */
	reason: Type.Optional(Type.String()),
	kind: Type.Optional(ToolKindSchema),
	locations: Type.Optional(Type.Array(Type.Object({ path: Type.String(), line: Type.Optional(Type.Integer()) }))),
	/** Overrides the mark the tool's status implies (a question still waiting, a run that was stopped). */
	state: Type.Optional(UiStateSchema),
	/** The one-line result. `stopped` draws a failure as interrupted. */
	outcome: Type.Optional(
		Type.Object({ text: Type.String(), tone: Type.Optional(ToneSchema), stopped: Type.Optional(Type.Literal(true)) }),
	),
	blocks: Type.Array(ToolDisplayBlockSchema),
	/** Blocks shown only when the row is expanded, before the others (a subagent's prompt). */
	preface: Type.Optional(Type.Array(ToolDisplayBlockSchema)),
});
export type ToolDisplay = Static<typeof ToolDisplaySchema>;

/** The block when this version knows its type and shape; undefined means: show its `text`. */
export function knownToolDisplayBlock(block: ToolDisplayBlock): KnownToolDisplayBlock | undefined {
	return Value.Check(KnownToolDisplayBlockSchema, block) ? block : undefined;
}

/** A display as plain text, for surfaces without rich rendering (ACP content, accessibility, tests). */
export function toolDisplayText(display: ToolDisplay, options: { preface?: boolean } = {}): string {
	const head = [display.title, display.summary ? `(${display.summary})` : ""].join("");
	const lines = [
		[head, ...(display.meta ?? [])].join(" · "),
		...(display.subjects ?? []).map((subject) => `  ${subject}`),
		...(display.reason ? [`↳ ${display.reason}`] : []),
		...(display.outcome ? [`⎿ ${display.outcome.text}`] : []),
		...(options.preface ? (display.preface ?? []).map((block) => block.text) : []),
		...display.blocks.map((block) => block.text),
	];
	return lines.filter((line) => line.length > 0).join("\n");
}
