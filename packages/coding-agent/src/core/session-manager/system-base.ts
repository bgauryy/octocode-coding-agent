import type { SystemMessage, Tool } from "@octocodeai/octocode-ai";
import {
	contentText,
	declarationsEqual,
	getCurrentSystemMessage,
	getInitialSystemMessage,
	getToolStateChanges,
} from "@octocodeai/octocode-ai";
import type { AgentMessage } from "@octocodeai/octocode-agent-core";

/**
 * A compaction folds the system prompt and tool state into one message. Providers that accept
 * mid-conversation system messages cached the original leading message, so the head of the
 * request stays that message (`systemBase`) and the changes since then replay as one update.
 */

function sameTools(left: readonly Tool[], right: readonly Tool[]): boolean {
	return left.length === right.length && left.every((tool, i) => declarationsEqual(tool, right[i]));
}

function sameState(left: SystemMessage, right: SystemMessage): boolean {
	return (
		contentText(left.content) === contentText(right.content) &&
		JSON.stringify(Object.entries(left.sections ?? {})) === JSON.stringify(Object.entries(right.sections ?? {})) &&
		sameTools(left.toolsAdded ?? [], right.toolsAdded ?? [])
	);
}

type Delta = SystemMessage | null | undefined;
// Weak on both sides: the base lives as long as the session, and each request folds a new message.
const deltas = new WeakMap<SystemMessage, WeakMap<SystemMessage, { delta: Delta }>>();

/**
 * The system-update message that turns `base` into `folded` when replayed after it.
 * Returns `undefined` when they are equal and `null` when no update can express the change
 * (for example, rewritten prompt text or reordered sections), so callers keep the folded form.
 */
export function getSystemBaseDelta(base: SystemMessage, folded: SystemMessage): Delta {
	const cached = deltas.get(base)?.get(folded);
	if (cached) return cached.delta;
	const delta = computeDelta(base, folded);
	const byFolded = deltas.get(base) ?? new WeakMap<SystemMessage, { delta: Delta }>();
	byFolded.set(folded, { delta });
	deltas.set(base, byFolded);
	return delta;
}

function computeDelta(base: SystemMessage, folded: SystemMessage): SystemMessage | null | undefined {
	const start = getCurrentSystemMessage([base]);
	if (!start) return null;
	const startText = contentText(start.content);
	const foldedText = contentText(folded.content);
	let content = "";
	if (startText.length === 0) content = foldedText;
	else if (foldedText !== startText) {
		if (!foldedText.startsWith(`${startText}\n\n`)) return null;
		content = foldedText.slice(startText.length + 2);
	}

	const sections: Record<string, string | null> = {};
	const startSections = start.sections ?? {};
	const foldedSections = folded.sections ?? {};
	for (const [name, value] of Object.entries(foldedSections)) {
		if (startSections[name] !== value) sections[name] = value;
	}
	for (const name of Object.keys(startSections)) {
		if (!(name in foldedSections)) sections[name] = null;
	}
	const { toolsAdded, toolsRemoved } = getToolStateChanges(start.toolsAdded ?? [], folded.toolsAdded ?? []);

	if (
		content.length === 0 &&
		Object.keys(sections).length === 0 &&
		toolsAdded.length === 0 &&
		toolsRemoved.length === 0
	) {
		return sameState(start, folded) ? undefined : null;
	}
	const delta: SystemMessage = {
		role: "system",
		content,
		...(Object.keys(sections).length > 0 ? { sections } : {}),
		...(toolsAdded.length > 0 ? { toolsAdded } : {}),
		...(toolsRemoved.length > 0 ? { toolsRemoved } : {}),
		timestamp: folded.timestamp,
	};
	const replayed = getCurrentSystemMessage([base, delta]);
	return replayed && sameState(replayed, folded) ? delta : null;
}

/**
 * Compaction fields for the prompt and tool state of `messages`: the folded state, plus the
 * leading message as the provider last saw it when later updates changed that state.
 */
export function getCompactionSystemFields(
	messages: readonly AgentMessage[],
	timestamp: number,
): { systemMessage?: SystemMessage; systemBase?: SystemMessage } {
	const folded = getCurrentSystemMessage(messages);
	if (!folded) return {};
	const systemMessage = { ...folded, timestamp };
	const head = getInitialSystemMessage(messages);
	if (!head || !getSystemBaseDelta(head, systemMessage)) return { systemMessage };
	return { systemMessage, systemBase: head };
}
