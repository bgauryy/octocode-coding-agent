import { isRecord } from "../../utils/guards.ts";
import { redactSecrets } from "../shared/sanitize.ts";
import { saveContentCopy } from "../shared/spill.ts";

/**
 * What the model reads of an external result. A reply's protocol updates repeat its text and carry every tool update,
 * so the model gets the text, stop reason and ids plus `updatesSaved`, the path of a content-hashed JSONL copy of the
 * updates. The tool result's `details` keep the full updates for the UI and SDK consumers. A failure's `partial` reply
 * gets the same treatment. When the copy cannot be written, the updates stay inline.
 */
export function externalModelView(data: unknown): unknown {
	if (!isRecord(data)) return data;
	let view = data;
	for (const key of ["reply", "partial"] as const) {
		const reply = data[key];
		if (!isRecord(reply) || !Array.isArray(reply.updates)) continue;
		const { updates, ...rest } = reply;
		view = { ...view, [key]: { ...rest, ...savedUpdates(updates) } };
	}
	return view;
}

function savedUpdates(updates: unknown[]): Record<string, unknown> {
	if (!updates.length) return {};
	const lines = updates.map((update) => redactSecrets(JSON.stringify(update))).join("\n");
	const saved = saveContentCopy(`${lines}\n`, "external-updates", "jsonl");
	return saved
		? { updatesSaved: `${updates.length} update${updates.length === 1 ? "" : "s"} at ${saved}` }
		: { updates };
}
