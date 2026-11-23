import { shortHash } from "@octocodeai/octocode-common/atomic-file";
import type { EntityInput } from "@octocodeai/octocode-contracts/backlogs";

/** A completion as the model may send it: the retry key is optional. */
export type CompletionArgument = Omit<NonNullable<EntityInput["completion"]>, "operationKey" | "receipt" | "qa"> & {
	operationKey?: string;
	/** The receipt the call cites (an id or `latest`); the write turns it into the facts the completion stores. */
	receipt?: string;
};

/** A completion with its retry key, its receipt still the reference the caller gave. */
export type KeyedCompletion = CompletionArgument & { operationKey: string };

/** JSON with object keys sorted, so equal content hashes equally whatever order the caller wrote it in. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/**
 * The key that makes a completion retryable. An explicit key wins. Otherwise it is derived from the item id and the
 * completion's content (not the item version, which the completion itself bumps): resending the same completion
 * yields the same key, so the store replays it instead of writing a second one, and a different result gets a new key.
 */
export function withOperationKey(completion: CompletionArgument, itemId: string | undefined): KeyedCompletion {
	if (completion.operationKey !== undefined && completion.operationKey.trim()) {
		return completion as KeyedCompletion;
	}
	const { operationKey: _unused, ...content } = completion;
	return {
		...content,
		operationKey: `auto-${shortHash(canonical({ item: itemId?.trim().toUpperCase() ?? "", ...content }))}`,
	};
}
