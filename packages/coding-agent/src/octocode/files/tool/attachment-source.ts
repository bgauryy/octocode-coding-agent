import type { FeatureContext } from "../../../core/features/index.ts";
import type { FileQuery } from "./queries.ts";

/**
 * A `write` query's `fromAttachment`: the bytes a teammate attached, written by the file tool instead of being copied by
 * the model. The team layer owns which attachments reached this session and checks their saved copies
 * (`team/attachment-source.ts`); the composition root passes that reader in, as `files` may not import team. The write
 * then runs through the normal guard, review and permissions like any other.
 */

/** The checked text of the attachment `hash` delivered to this session; throws naming what to do. */
export type AttachmentContent = (hash: string, ctx: Pick<FeatureContext, "sessionManager">) => string;

/**
 * `queries` with each `fromAttachment` write given its attachment's text as `content`, as new objects (the call's own
 * arguments keep the reference, so the transcript never carries the text). Throws for a misuse or an attachment that
 * cannot be written, before anything is changed; without a reader (no team mail in this host) every reference throws.
 */
export function withAttachments(
	queries: FileQuery[],
	ctx: Pick<FeatureContext, "sessionManager">,
	content: AttachmentContent | undefined,
): FileQuery[] {
	return queries.map((query) => {
		if (query.fromAttachment === undefined) return query;
		if (query.type !== "write")
			throw new Error(
				`fromAttachment goes with a write query, not ${query.type} (${query.path}). Nothing was changed.`,
			);
		if (query.content !== undefined)
			throw new Error(`Give content or fromAttachment for ${query.path}, not both. Nothing was changed.`);
		if (!content)
			throw new Error(
				`fromAttachment needs team mail, which this session has none of; send content for ${query.path}. Nothing was changed.`,
			);
		return { ...query, content: content(query.fromAttachment, ctx) };
	});
}
