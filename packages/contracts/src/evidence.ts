import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { StringEnum } from "./schema.ts";

/**
 * Evidence: a place in recorded history that a claim, memory or receipt points at, and the bounded read that answers
 * it. A `SourceAnchor` names its owner by `kind` plus that owner's locator; the host resolves it within the caller's
 * session scope and an unverifiable one reads as `missing`. New kinds (`memory`, `receipt`) add a member to
 * `SourceAnchorSchema` and one entry to `ANCHOR_FORMS`; existing anchors keep their meaning.
 */

/** Longest id or session name an anchor carries. */
const ID_MAX = 256;
const idSchema = Type.String({ minLength: 1, maxLength: ID_MAX });

/** A message in an archived segment of a session's compacted history. */
export const ArchiveAnchorSchema = Type.Object(
	{
		kind: Type.Literal("archive"),
		sessionId: idSchema,
		/** The segment number within that session's archive. */
		segment: Type.Integer({ minimum: 1 }),
		/** The session entry id of the message. */
		entryId: idSchema,
	},
	{ additionalProperties: false },
);
export type ArchiveAnchor = Static<typeof ArchiveAnchorSchema>;

/** An entry of a session's own transcript file. */
export const TranscriptAnchorSchema = Type.Object(
	{
		kind: Type.Literal("transcript"),
		sessionId: idSchema,
		entryId: idSchema,
	},
	{ additionalProperties: false },
);
export type TranscriptAnchor = Static<typeof TranscriptAnchorSchema>;

export const SourceAnchorSchema = Type.Union([ArchiveAnchorSchema, TranscriptAnchorSchema]);
export type SourceAnchor = Static<typeof SourceAnchorSchema>;
export type SourceAnchorKind = SourceAnchor["kind"];

export const isSourceAnchor = (value: unknown): value is SourceAnchor => Value.Check(SourceAnchorSchema, value);

type AnchorOf<K extends SourceAnchorKind> = Extract<SourceAnchor, { kind: K }>;

/** Each kind's string form: `<kind>:<part>/<part>…`, parts percent-encoded; `parse` returns undefined for a malformed locator. */
const ANCHOR_FORMS: {
	[K in SourceAnchorKind]: { format(a: AnchorOf<K>): string[]; parse(parts: string[]): AnchorOf<K> | undefined };
} = {
	archive: {
		format: (a) => [a.sessionId, String(a.segment), a.entryId],
		parse: ([sessionId, segment, entryId, ...rest]) =>
			sessionId && entryId && rest.length === 0 && /^[1-9]\d*$/.test(segment ?? "")
				? { kind: "archive", sessionId, segment: Number(segment), entryId }
				: undefined,
	},
	transcript: {
		format: (a) => [a.sessionId, a.entryId],
		parse: ([sessionId, entryId, ...rest]) =>
			sessionId && entryId && rest.length === 0 ? { kind: "transcript", sessionId, entryId } : undefined,
	},
};

/** `archive:<session>/<segment>/<entry>` or `transcript:<session>/<entry>`: the form humans and the CLI use. */
export function formatAnchor(anchor: SourceAnchor): string {
	const form = ANCHOR_FORMS[anchor.kind] as { format(a: SourceAnchor): string[] };
	return `${anchor.kind}:${form.format(anchor).map(encodeURIComponent).join("/")}`;
}

/** The anchor `text` names, or undefined when it is not a well-formed anchor of a known kind. */
export function parseAnchor(text: string): SourceAnchor | undefined {
	const colon = text.indexOf(":");
	if (colon < 0) return undefined;
	const kind = text.slice(0, colon);
	if (!Object.hasOwn(ANCHOR_FORMS, kind)) return undefined;
	let parts: string[];
	try {
		parts = text
			.slice(colon + 1)
			.split("/")
			.map(decodeURIComponent);
	} catch {
		return undefined;
	}
	const form = ANCHOR_FORMS[kind as SourceAnchorKind] as { parse(parts: string[]): SourceAnchor | undefined };
	const anchor = form.parse(parts);
	return anchor && isSourceAnchor(anchor) ? anchor : undefined;
}

/** Whether the anchored text can be read: `missing` is unknown, foreign or unverifiable; `expired` was removed by retention. */
export const EVIDENCE_AVAILABILITY = ["present", "missing", "expired"] as const;
export type EvidenceAvailability = (typeof EVIDENCE_AVAILABILITY)[number];

/** The bounded read of one anchor; only `anchor` and `availability` are set unless the text is `present`. */
export const EvidenceReadSchema = Type.Object(
	{
		anchor: SourceAnchorSchema,
		availability: StringEnum(EVIDENCE_AVAILABILITY),
		/** Who wrote the text: a message role such as `user` or `assistant`. */
		author: Type.Optional(Type.String()),
		/** ISO time of the message. */
		time: Type.Optional(Type.String()),
		text: Type.Optional(Type.String()),
		/** More text follows; continue with `nextCursor`. */
		truncated: Type.Optional(Type.Boolean()),
		nextCursor: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
export type EvidenceRead = Static<typeof EvidenceReadSchema>;

export const isEvidenceRead = (value: unknown): value is EvidenceRead => Value.Check(EvidenceReadSchema, value);
