import {
	getCurrentTools,
	getToolStateChanges,
	type SystemMessage,
	type ToolStateChanges,
	toToolDeclaration,
} from "@octocodeai/octocode-ai";
import type { AgentContext, AgentMessage } from "../types.ts";
import type { AgentEventSink } from "./events.ts";

export function inputCommitter(context: AgentContext, recorded: AgentMessage[], emit: AgentEventSink) {
	const committed = new Set<AgentMessage>();
	return async (messages: AgentMessage[], signal?: AbortSignal): Promise<void> => {
		const pending = messages.filter((message) => !committed.has(message));
		if (signal?.aborted) return;
		for (const message of declareToolChanges(context, pending)) {
			if (signal?.aborted) break;
			committed.add(message);
			await emit({ type: "message_start", message });
			await emit({ type: "message_end", message });
			context.messages.push(message);
			recorded.push(message);
		}
	};
}

/**
 * Declare tool loadout changes to the model.
 *
 * `context.tools` is what the runtime can execute; the transcript's system messages declare
 * what the model may call. Before each request the difference becomes `toolsAdded` and
 * `toolsRemoved` on a system message. When a pending system message exists, its tool fields
 * are treated as intent and replaced with the delta between the committed transcript and
 * the executable set, so replay always yields exactly `context.tools`, plus the declared tools
 * in `context.pendingToolNames` that are not executable yet. Otherwise a new
 * system message is inserted before the first non-system pending message.
 */
function declareToolChanges(context: AgentContext, pendingMessages: AgentMessage[]): AgentMessage[] {
	let systemIndex = -1;
	for (let i = pendingMessages.length - 1; i >= 0; i--) {
		if (pendingMessages[i].role === "system") {
			systemIndex = i;
			break;
		}
	}
	const pending = pendingMessages[systemIndex] as SystemMessage | undefined;
	const baseline = pending
		? pendingMessages.map((message, index) => (index === systemIndex ? withToolChanges(pending, NO_CHANGES) : message))
		: pendingMessages;
	const delta = getToolStateChanges(
		getCurrentTools([...context.messages, ...baseline]),
		(context.tools ?? []).map(toToolDeclaration),
	);
	// Pending tools keep their previous declaration until they register or the host drops them.
	const awaiting = context.pendingToolNames?.();
	const changes = awaiting?.size
		? { ...delta, toolsRemoved: delta.toolsRemoved.filter((tool) => !awaiting.has(tool.name)) }
		: delta;
	/* B134-DEBUG */ if (process.env.OCTOCODE_DEBUG_PENDING === "1")
		void import("node:fs").then((fs) =>
			fs.appendFileSync(
				"/tmp/b134-debug.log",
				`${new Date().toISOString()} pid=${process.pid} declare ${JSON.stringify({ awaiting: awaiting ? [...awaiting] : null, removedRaw: delta.toolsRemoved.map((t) => t.name), removed: changes.toolsRemoved.map((t) => t.name), tools: (context.tools ?? []).length })}\n`,
			),
		);
	const unchanged = changes.toolsAdded.length === 0 && changes.toolsRemoved.length === 0;

	if (pending) {
		// Keep the caller's message object when it already declares no tool changes.
		if (unchanged && !pending.toolsAdded?.length && !pending.toolsRemoved?.length) return pendingMessages;
		return baseline.map((message, index) => (index === systemIndex ? withToolChanges(pending, changes) : message));
	}
	if (unchanged) return pendingMessages;
	const update = withToolChanges({ role: "system", content: "", timestamp: Date.now() }, changes);
	const insertIndex = pendingMessages.findIndex((message) => message.role !== "system");
	const index = insertIndex === -1 ? pendingMessages.length : insertIndex;
	return [...pendingMessages.slice(0, index), update, ...pendingMessages.slice(index)];
}

const NO_CHANGES: ToolStateChanges = { toolsAdded: [], toolsRemoved: [] };

/** Copy a system message with its tool fields replaced by `changes`; empty lists omit the field. */
function withToolChanges(message: SystemMessage, { toolsAdded, toolsRemoved }: ToolStateChanges): SystemMessage {
	const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message;
	return {
		...rest,
		...(toolsAdded.length > 0 ? { toolsAdded } : {}),
		...(toolsRemoved.length > 0 ? { toolsRemoved } : {}),
	};
}
