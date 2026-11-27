import { cacheForm, canonicalize, type CapturedRequest, type Trace, type Usage } from "./trace.ts";

/** Characters per token of scripted usage without the gateway's `charsPerToken`. */
export const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * Scripted usage: what a provider would count for a request the gateway answers itself, at `charsPerToken` over the
 * canonical request, with prompt-cache reads from the longest prefix an earlier request of the same agent and model
 * shared. Marked `estimated`.
 */
export function simulateUsage(
	trace: Trace,
	req: CapturedRequest,
	rawTools: unknown,
	completion: string,
	charsPerToken: number,
): Usage {
	const est = (chars: number): number => Math.ceil(chars / charsPerToken);
	// Unmasked, like a provider cache: a changing timestamp in the prefix is a cache miss.
	const raw = { raw: true };
	const toolsCanon = canonicalize(rawTools ?? [], raw);
	const canon = req.messages.map((m) => canonicalize(cacheForm(m), raw));
	const total = toolsCanon.length + canon.reduce((n, c) => n + c.length, 0);
	let best = 0;
	for (const prev of trace.requests) {
		if (prev === req || prev.index >= req.index || prev.agent !== req.agent || prev.model !== req.model) continue;
		if (canonicalize((prev.raw as { tools?: unknown }).tools ?? [], raw) !== toolsCanon) continue;
		let chars = 0;
		for (let k = 0; k < prev.messages.length && k < canon.length; k++) {
			if (canonicalize(cacheForm(prev.messages[k]), raw) !== canon[k]) break;
			chars += canon[k].length;
		}
		best = Math.max(best, chars > 0 ? chars + toolsCanon.length : 0);
	}
	return {
		promptTokens: est(total),
		cachedTokens: est(best),
		completionTokens: est(completion.length),
		estimated: true,
	};
}
