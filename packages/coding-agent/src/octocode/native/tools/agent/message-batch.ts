import type { TSchema } from "typebox";
import { asRecord, errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import type { ToolDefinition } from "../../../../core/features/index.ts";

export const MESSAGES_FIELD = "messages";

type Result = Awaited<ReturnType<ToolDefinition["execute"]>>;
type Fields = Record<string, unknown>;

/** The `messages` property: entries are message-field objects, each checked by the single-message path, so none is spelled out here. */
export function messagesSchema(): TSchema & { description: string } {
	return {
		type: "array",
		items: {},
		description: "message: several; top-level fields default",
	} as unknown as TSchema & { description: string };
}

/** The entries of a `message` call's batch, or undefined for a single message. */
export function messageBatchOf(args: unknown): Fields[] | undefined {
	const record = asRecord(args);
	const entries = record[MESSAGES_FIELD];
	return record.type === "message" && Array.isArray(entries) ? entries.map((entry) => asRecord(entry)) : undefined;
}

/** Each entry's recipient (`?` when it names none), in order: a batch's call row lists them. */
export function messageBatchRecipients(args: unknown): string[] {
	const defaults = asRecord(args).to;
	return (messageBatchOf(args) ?? []).map((entry) => {
		const to = entry.to ?? defaults;
		return typeof to === "string" && to ? to : "?";
	});
}

/**
 * Send each entry in order through `single`, the one-message path (field checks, validation, delivery), with the
 * call's other fields as defaults. A failed entry is reported on its line and the rest still go: messages to
 * different recipients do not depend on each other. Every entry failing fails the call.
 */
export async function runMessageBatch(
	entries: readonly Fields[],
	defaults: Fields,
	single: (fields: Fields) => Promise<Result>,
): Promise<Result> {
	if (entries.length === 0) throw new Error(`${MESSAGES_FIELD} is empty; give at least one message.`);
	const lines: string[] = [];
	const batch: unknown[] = [];
	let failed = 0;
	for (const [index, entry] of entries.entries()) {
		const prefix = entries.length > 1 ? `${index + 1}. ` : "";
		try {
			const result = await single({ ...defaults, ...entry });
			const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ");
			lines.push(`${prefix}${text}`);
			batch.push(isRecord(result.details) ? result.details : {});
		} catch (error) {
			failed++;
			lines.push(`${prefix}error: ${errorMessage(error)}`);
			batch.push({ error: errorMessage(error) });
		}
	}
	if (failed === entries.length) throw new Error(lines.join("\n"));
	return { content: [{ type: "text", text: lines.join("\n") }], details: { batch } };
}
