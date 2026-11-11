import type { MarkdownTransformContext, MarkdownTransformer } from "../../../core/features/types.ts";
import { sanitizeTerminalText } from "../../../../../common/src/sanitize.ts";

/** Built-in transformers marked by `trustedMarkdownTransformer`. */
const trustedTransformers = new WeakSet<MarkdownTransformer>();

/**
 * Marks a built-in transformer as trusted: it runs after every other transformer and after the final sanitize, so the
 * terminal styling it adds reaches the screen. Its output must be built only from the Markdown it is given (already
 * sanitized) and its own styling. Extension transformers are never marked: their output is sanitized.
 */
export function trustedMarkdownTransformer(transformer: MarkdownTransformer): MarkdownTransformer {
	trustedTransformers.add(transformer);
	return transformer;
}

export function createMarkdownTransform(
	messageType: MarkdownTransformContext["messageType"],
	isStreaming: boolean,
	transformers: readonly MarkdownTransformer[],
): (markdown: string, availableWidth: number) => string {
	return (markdown, availableWidth) =>
		applyMarkdownTransformers(markdown, { messageType, isStreaming, availableWidth }, transformers);
}

function runTransformers(
	markdown: string,
	context: MarkdownTransformContext,
	transformers: readonly MarkdownTransformer[],
	trusted: boolean,
): string {
	let transformedMarkdown = markdown;
	for (const transformer of transformers) {
		if (trustedTransformers.has(transformer) !== trusted) continue;
		try {
			const transformed = transformer(transformedMarkdown, context);
			if (typeof transformed === "string") {
				transformedMarkdown = transformed;
			}
		} catch {
			// Keep the current Markdown and continue with the next transformer.
		}
	}
	return transformedMarkdown;
}

/**
 * Sanitizes the Markdown, runs the untrusted (extension) transformers and sanitizes what they return, then runs the
 * trusted built-ins over that clean text, keeping their styling.
 */
function applyMarkdownTransformers(
	markdown: string,
	context: MarkdownTransformContext,
	transformers: readonly MarkdownTransformer[],
): string {
	const sanitized = sanitizeTerminalText(markdown);
	const transformed = runTransformers(sanitized, context, transformers, false);
	// Sanitizing is idempotent: text no transformer changed is already clean, so only new text is scanned again.
	const clean = transformed === sanitized ? sanitized : sanitizeTerminalText(transformed);
	return runTransformers(clean, context, transformers, true);
}
