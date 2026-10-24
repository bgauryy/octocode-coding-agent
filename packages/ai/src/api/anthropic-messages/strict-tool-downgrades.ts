import type { Model, Tool } from "../../types.ts";
import { shortHash } from "../../utils/hash.ts";

const MAX_REMEMBERED_DOWNGRADES = 64;

// Insertion-ordered, so the oldest entry is evicted first.
const downgrades = new Set<string>();

function downgradeKey(model: Model<"anthropic-messages">, tools: readonly Tool[]): string {
	const signature = shortHash(
		JSON.stringify(tools.map((tool) => [tool.name, tool.parameters, tool.constrainedSampling])),
	);
	return `${model.provider}\n${model.id}\n${model.baseUrl}\n${signature}`;
}

/**
 * Whether the provider already rejected this model, endpoint and tool set with preferred strict tools.
 * Later requests skip the failing round-trip and send the downgraded payload, which keeps the cached prefix stable.
 */
export function hasStrictToolDowngrade(model: Model<"anthropic-messages">, tools: readonly Tool[]): boolean {
	return downgrades.has(downgradeKey(model, tools));
}

export function rememberStrictToolDowngrade(model: Model<"anthropic-messages">, tools: readonly Tool[]): void {
	const key = downgradeKey(model, tools);
	downgrades.delete(key);
	downgrades.add(key);
	if (downgrades.size > MAX_REMEMBERED_DOWNGRADES) {
		const oldest = downgrades.values().next().value;
		if (oldest !== undefined) downgrades.delete(oldest);
	}
}

export function clearStrictToolDowngrades(): void {
	downgrades.clear();
}
