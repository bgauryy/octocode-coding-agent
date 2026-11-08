import type { ProfileAgent, ProfileLayerKind } from "@octocodeai/octocode-contracts";
import { formatTokens } from "../profiler-model.ts";

/** What the context bar tells apart: the eight layer kinds fold into five groups, plus the reply the model wrote. */
export type ContextGroupKey = "tools" | "system" | "history" | "result" | "other" | "output";

const CONTEXT_GROUPS: readonly { key: ContextGroupKey; label: string }[] = [
	{ key: "tools", label: "tools" },
	{ key: "system", label: "system" },
	{ key: "history", label: "history" },
	{ key: "result", label: "tool results" },
	{ key: "other", label: "notices" },
	{ key: "output", label: "output" },
];

const GROUP_OF: Record<ProfileLayerKind, ContextGroupKey> = {
	tools: "tools",
	system: "system",
	message: "history",
	"tool-result": "result",
	notice: "other",
	steer: "other",
	interrupt: "other",
	summary: "other",
};

export const groupOfKind = (kind: ProfileLayerKind): ContextGroupKey => GROUP_OF[kind];

export const groupLabel = (key: ContextGroupKey): string =>
	CONTEXT_GROUPS.find((group) => group.key === key)?.label ?? key;

export interface ContextSegment {
	key: ContextGroupKey;
	tokens: number;
}

/** A segment narrower than this share of the track folds into `notices`, so no 1 px slivers. */
const MIN_SHARE = 0.005;

/**
 * The context's tokens by group in display order. `total` is the whole context (prompt plus the reply); what the layers
 * do not cover is the output. With `fold`, segments too thin to see merge into `other`.
 */
export function contextSegments(
	layers: readonly { kind: ProfileLayerKind; tokens: number }[] | undefined,
	total: number | undefined,
	track: number,
	fold = true,
): ContextSegment[] {
	const sums = new Map<ContextGroupKey, number>();
	for (const layer of layers ?? []) {
		if (layer.tokens > 0) sums.set(groupOfKind(layer.kind), (sums.get(groupOfKind(layer.kind)) ?? 0) + layer.tokens);
	}
	const covered = [...sums.values()].reduce((sum, tokens) => sum + tokens, 0);
	const rest = total === undefined ? 0 : Math.round(total - covered);
	if (rest > 0) sums.set("output", rest);
	if (fold && track > 0) {
		for (const [key, tokens] of Array.from(sums)) {
			if (key === "other" || tokens / track >= MIN_SHARE) continue;
			sums.delete(key);
			sums.set("other", (sums.get("other") ?? 0) + tokens);
		}
	}
	return CONTEXT_GROUPS.flatMap(({ key }) => {
		const tokens = sums.get(key);
		return tokens ? [{ key, tokens }] : [];
	});
}

export type ContextLevel = "ok" | "warn" | "danger";

/** How near compaction is: under 70% of the threshold is fine, 70 to 90% warns, from 90% it is urgent. */
export function contextLevel(tokens: number | undefined, threshold: number | undefined): ContextLevel {
	if (tokens === undefined || !threshold) return "ok";
	const used = tokens / threshold;
	return used >= 0.9 ? "danger" : used >= 0.7 ? "warn" : "ok";
}

/** What the agent compacts against: its threshold, else its window. */
export const contextThreshold = (agent: Pick<ProfileAgent, "compactAt" | "contextWindow">): number | undefined =>
	agent.compactAt ?? agent.contextWindow;

/** Share of the window in use, 0 to 1; absent without a window or a measurement. */
export function contextShare(agent: Pick<ProfileAgent, "contextTokens" | "contextWindow">): number | undefined {
	return agent.contextTokens !== undefined && agent.contextWindow
		? agent.contextTokens / agent.contextWindow
		: undefined;
}

/** `128k / 200k · 64%`, or `128k tokens` when the window is unknown; `≈` marks an estimated split. */
export function contextCaption(tokens: number, window: number | undefined): string {
	return window
		? `${formatTokens(tokens)} / ${formatTokens(window)} · ${Math.round((tokens / window) * 100)}%`
		: `${formatTokens(tokens)} tokens`;
}
