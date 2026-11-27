import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { redactSecrets } from "@octocodeai/octocode-common/sanitize";

/**
 * Session files are copied, exported and shared, so what a tool printed must not keep a credential. Every string of an
 * entry is passed through `redactSecrets` (the credential values this process resolved, and the credential patterns) as it
 * is encoded for a file or an export. The entry in memory, which the model reads, is left alone; a session read back from the
 * file holds the redacted text.
 *
 * Left as written, because they hold no tool output and other lines refer to them by content: system messages and
 * compaction system states (`codec-snapshots.ts`), request traces (`codec-trace.ts`), reference objects, provider
 * signatures and image data.
 */

type Record_ = Record<string, unknown>;

const UNTOUCHED_KEYS = new Set(["requestTrace", "systemMessage", "systemBase", "$ref"]);

const isSignatureKey = (key: string): boolean => /signature$/i.test(key);

function redactValue(value: unknown): unknown {
	if (typeof value === "string") return redactSecrets(value);
	if (Array.isArray(value)) {
		let copy: unknown[] | undefined;
		value.forEach((item, index) => {
			const next = redactValue(item);
			if (next !== item) (copy ??= [...value])[index] = next;
		});
		return copy ?? value;
	}
	if (!isRecord(value) || value.type === "image") return value;
	return redactRecord(value);
}

function redactRecord(record: Record_): Record_ {
	let copy: Record_ | undefined;
	for (const [key, value] of Object.entries(record)) {
		if (UNTOUCHED_KEYS.has(key) || isSignatureKey(key)) continue;
		const next = redactValue(value);
		if (next !== value) (copy ??= { ...record })[key] = next;
	}
	return copy ?? record;
}

/** `entry` with credentials removed from its text; the same object when it holds none. */
export function redactEntry<T extends object>(entry: T): T {
	const record = entry as unknown as Record_;
	const message = isRecord(record.message) ? record.message : undefined;
	if (record.type === "message" && message?.role === "system") return entry;
	return redactRecord(record) as unknown as T;
}
