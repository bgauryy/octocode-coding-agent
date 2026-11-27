import { cacheForm, canonicalize, hashOf, textOf, type CapturedRequest, type Trace } from "./trace.ts";

export interface PrefixBreak {
	agent: string;
	request: number;
	/** First message index whose canonical form differs from the earlier request. */
	messageIndex: number;
	reason: "tools-changed" | "message-rewritten" | "model-changed";
}

/**
 * Cache precondition: each request of an agent starts with the previous request's messages, tools and model
 * (redacted text, not masked), so a provider prefix cache can reuse it. Compaction legitimately breaks the chain once.
 */
export function prefixBreaks(
	trace: Trace,
	opts: { allowAfterCompaction?: boolean; raw?: boolean } = {},
): PrefixBreak[] {
	// Providers cache on exact bytes: compare unmasked text unless the caller opts out.
	const canon = (v: unknown): string => canonicalize(v, { raw: opts.raw !== false });
	const breaks: PrefixBreak[] = [];
	const byAgent = new Map<string, CapturedRequest[]>();
	for (const r of trace.requests) byAgent.set(r.agent, [...(byAgent.get(r.agent) ?? []), r]);
	const compactedAgents = new Set(trace.of("compaction").map((e) => e.agent));
	for (const [agent, reqs] of byAgent) {
		for (let i = 1; i < reqs.length; i++) {
			const prev = reqs[i - 1];
			const cur = reqs[i];
			if (prev.model !== cur.model) {
				breaks.push({ agent, request: cur.index, messageIndex: 0, reason: "model-changed" });
				continue;
			}
			if (canon(prev.tools) !== canon(cur.tools)) {
				breaks.push({ agent, request: cur.index, messageIndex: 0, reason: "tools-changed" });
				continue;
			}
			const at = prev.messages.findIndex(
				(m, k) => cur.messages[k] === undefined || canon(cacheForm(m)) !== canon(cacheForm(cur.messages[k])),
			);
			if (at !== -1) breaks.push({ agent, request: cur.index, messageIndex: at, reason: "message-rewritten" });
		}
	}
	if (!opts.allowAfterCompaction) return breaks;
	const seen = new Set<string>();
	return breaks.filter((b) => {
		if (!compactedAgents.has(b.agent) || seen.has(b.agent) || b.reason !== "message-rewritten") return true;
		seen.add(b.agent);
		return false;
	});
}

export interface DuplicateBlock {
	request: number;
	hash: string;
	count: number;
	preview: string;
}

/** Blocks (paragraphs of at least minChars) that appear more than once inside one request. */
export function duplicateBlocks(trace: Trace, minChars = 200): DuplicateBlock[] {
	const out: DuplicateBlock[] = [];
	for (const r of trace.requests) {
		const counts = new Map<string, { count: number; text: string }>();
		for (const m of r.messages) {
			for (const block of textOf(m.content).split(/\n{2,}/)) {
				const t = block.trim();
				if (t.length < minChars) continue;
				const h = hashOf(t);
				const c = counts.get(h) ?? { count: 0, text: t };
				c.count++;
				counts.set(h, c);
			}
		}
		for (const [hash, c] of counts)
			if (c.count > 1) out.push({ request: r.index, hash, count: c.count, preview: c.text.slice(0, 60) });
	}
	return out;
}

/** Per-request size in UTF-8 bytes of the canonical request (bytes, not tokens). */
export function growth(trace: Trace, agent?: string): number[] {
	return trace.requests.filter((r) => agent === undefined || r.agent === agent).map((r) => r.bytes);
}

export interface CacheBreak {
	agent: string;
	request: number;
	promptTokens: number;
	estimated: boolean;
}

export interface CacheBreakOptions {
	/** Prompts below this size are not cached by providers, so a cold read there is no break. Default 1024. */
	minPromptTokens?: number;
	/** Each compaction of an agent excuses one cold read of that agent (the earliest unexcused one). Default true. */
	allowAfterCompaction?: boolean;
	agent?: string;
}

/**
 * Cold reads after warm-up, from the usage each request reports: per agent, every request after its first whose prompt
 * reaches `minPromptTokens` and reads no cached token. Requests and harness events carry no shared order, so as in
 * `prefixBreaks` a compaction is tied to its agent, not to a request: N compactions excuse that agent's first N breaks.
 */
export function cacheBreaks(trace: Trace, opts: CacheBreakOptions = {}): CacheBreak[] {
	const min = opts.minPromptTokens ?? 1024;
	const excused = new Map<string, number>();
	if (opts.allowAfterCompaction !== false)
		for (const e of trace.of("compaction")) excused.set(e.agent, (excused.get(e.agent) ?? 0) + 1);
	const seen = new Set<string>();
	const breaks: CacheBreak[] = [];
	for (const r of trace.requests) {
		if (opts.agent !== undefined && r.agent !== opts.agent) continue;
		const first = !seen.has(r.agent);
		seen.add(r.agent);
		const u = r.usage;
		if (first || !u || u.promptTokens < min || u.cachedTokens > 0) continue;
		const left = excused.get(r.agent) ?? 0;
		if (left > 0) {
			excused.set(r.agent, left - 1);
			continue;
		}
		breaks.push({ agent: r.agent, request: r.index, promptTokens: u.promptTokens, estimated: u.estimated });
	}
	return breaks;
}

/** Share of prompt tokens the (simulated or real) provider reported as cache reads. */
export function cacheReadRatio(trace: Trace): number {
	let prompt = 0;
	let cached = 0;
	for (const r of trace.requests) {
		prompt += r.usage?.promptTokens ?? 0;
		cached += r.usage?.cachedTokens ?? 0;
	}
	return prompt === 0 ? 0 : cached / prompt;
}
