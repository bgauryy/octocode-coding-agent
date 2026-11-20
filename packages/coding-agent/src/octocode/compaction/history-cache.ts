import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { CLEARED_RESULTS_TYPE } from "../files/reads.ts";
import { BranchIndex, type BranchSource } from "../shared/branch-index.ts";

interface Input {
	at: number;
	editable: boolean;
	blocks: boolean;
	content: unknown;
	/** A result's saved copy once cleared; for an assistant message, the calls whose `file` payload was cleared. */
	saved?: string;
	epoch?: number;
	baseline?: { content: unknown; saved?: string };
}
interface History {
	length: number;
	epoch: number;
	boundary: number;
	floor: number;
	replaced: boolean;
	entries: Map<string, Input>;
	results: Map<string, Input[]>;
	/** The assistant message that holds each tool call, by call id. */
	calls: Map<string, Input>;
	changed: Set<Input>;
}

/** An edit compares only its affected entry, never the complete conversation on each request. */
function change(state: History, input: Input, update: () => void): void {
	const cached = input.at >= state.floor && input.at < state.boundary;
	if (cached && input.epoch !== state.epoch) {
		input.epoch = state.epoch;
		input.baseline = { content: input.content, saved: input.saved };
	}
	update();
	if (!cached || !input.baseline) return;
	const same =
		input.content === input.baseline.content ||
		JSON.stringify(input.content) === JSON.stringify(input.baseline.content);
	if (same && (input.content === null || input.saved === input.baseline.saved)) state.changed.delete(input);
	else state.changed.add(input);
}

function noteHistory(state: History, value: unknown): void {
	const at = state.length++;
	if (!isRecord(value)) return;
	const message = value.type === "message" && isRecord(value.message) ? value.message : undefined;
	const editable =
		value.type === "custom_message" ||
		(!!message && ["user", "assistant", "toolResult", "custom"].includes(String(message.role)));
	const input: Input = {
		at,
		editable,
		blocks: message?.role === "assistant" || message?.role === "toolResult",
		content: message ? message.content : value.content,
	};
	if (typeof value.id === "string") state.entries.set(value.id, input);
	if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
		const results = state.results.get(message.toolCallId) ?? [];
		results.push(input);
		state.results.set(message.toolCallId, results);
	}
	if (message?.role === "assistant" && Array.isArray(message.content))
		for (const part of message.content)
			if (isRecord(part) && part.type === "toolCall" && typeof part.id === "string") state.calls.set(part.id, input);
	if (message?.role === "assistant") {
		const usage = isRecord(message.usage) ? message.usage : undefined;
		if (!usage || Number(usage.cacheRead) > 0 || Number(usage.cacheWrite) > 0) {
			state.boundary = at;
			state.epoch++;
			state.replaced = false;
			state.changed.clear();
		}
	}
	if (value.type === "compaction") {
		state.floor =
			typeof value.firstKeptEntryId === "string" ? (state.entries.get(value.firstKeptEntryId)?.at ?? at) : at;
		state.replaced = true;
		state.changed.clear();
	}
	if (value.type === "context_edit" && typeof value.targetId === "string") {
		const target = state.entries.get(value.targetId);
		if (target?.editable)
			change(state, target, () => {
				const content =
					value.replacement === null ? null : isRecord(value.replacement) ? value.replacement.content : target.content;
				// The canonical projection represents assistant/tool strings as text blocks, including legacy edits.
				target.content = target.blocks && typeof content === "string" ? [{ type: "text", text: content }] : content;
			});
	}
	if (
		value.type === "custom" &&
		value.customType === CLEARED_RESULTS_TYPE &&
		isRecord(value.data) &&
		Array.isArray(value.data.results)
	) {
		for (const result of value.data.results) {
			if (!isRecord(result) || typeof result.id !== "string" || typeof result.saved !== "string") continue;
			const saved = result.saved;
			for (const target of state.results.get(result.id) ?? [])
				change(state, target, () => {
					target.saved = saved;
				});
		}
	}
	// A cleared `file` payload changes the assistant message that holds the call.
	if (value.type === "custom" && value.customType === CLEARED_RESULTS_TYPE && isRecord(value.data)) {
		const inputs = Array.isArray(value.data.inputs) ? value.data.inputs : [];
		for (const id of inputs) {
			const target = typeof id === "string" ? state.calls.get(id) : undefined;
			if (target)
				change(state, target, () => {
					target.saved = `${target.saved ?? ""}${id}\n`;
				});
		}
	}
}

const history = new BranchIndex<History>(
	() => ({
		length: 0,
		epoch: 0,
		boundary: -1,
		floor: 0,
		replaced: false,
		entries: new Map(),
		results: new Map(),
		calls: new Map(),
		changed: new Set(),
	}),
	noteHistory,
);

/**
 * Whether the current active history differs from the last cache-using assistant's input. Appended messages and edits
 * to that assistant's own output were not in that input. A warmer receipt cannot prove that changed content was sent.
 * Instruction prefixes remain independently reusable. The incremental fold follows branch order, not timestamps.
 */
export function historyPrefixRewritten(session: BranchSource): boolean {
	const state = history.read(session);
	return state.replaced || state.changed.size > 0;
}

/** Whether a compaction replaced the history since the last cache-using reply: the next request writes all of it again. */
export function historyReplaced(session: BranchSource): boolean {
	return history.read(session).replaced;
}
