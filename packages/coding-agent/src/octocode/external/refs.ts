import { type ReferenceContext, referencedContentBlock, resolveReferences } from "../shared/references.ts";
import { redactSecrets } from "../shared/sanitize.ts";

/**
 * `text` with the content of `refs` appended as a `## Referenced content` block. The peer cannot read this machine's
 * agent store or session files, so the content travels in the prompt. Throws, naming each reference, when any of them
 * does not resolve; the caller marks that refusal not-sent.
 */
export async function expandPromptRefs(
	text: string,
	refs: readonly string[],
	context: ReferenceContext,
): Promise<string> {
	const { resolved, errors } = await resolveReferences(refs, { ...context, artifactAccess: "none" });
	if (errors.length) throw new Error(`Unresolvable refs; nothing was sent: ${errors.join("; ")}`);
	const block = referencedContentBlock(resolved);
	return block ? `${text}\n\n${redactSecrets(block)}` : text;
}
