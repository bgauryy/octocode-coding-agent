/** Helpers the event dispatchers share. */

import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import { getCurrentSystemMessage } from "@octocodeai/octocode-ai";
import type { FeatureError, FeatureRuntime, UserBashEventResult } from "../types.ts";

export function isUserBashEventResult(value: unknown): value is UserBashEventResult {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	const hasOperations = candidate.operations !== undefined;
	const hasResult = candidate.result !== undefined;
	if (hasOperations === hasResult) return false;

	if (hasOperations) {
		const operations = candidate.operations;
		if (typeof operations !== "object" || operations === null) return false;
		return typeof (operations as Record<string, unknown>).exec === "function";
	}

	const result = candidate.result;
	if (typeof result !== "object" || result === null) return false;
	const resultRecord = result as Record<string, unknown>;
	return (
		typeof resultRecord.output === "string" &&
		"exitCode" in resultRecord &&
		(resultRecord.exitCode === undefined || typeof resultRecord.exitCode === "number") &&
		typeof resultRecord.cancelled === "boolean" &&
		typeof resultRecord.truncated === "boolean" &&
		(resultRecord.fullOutputPath === undefined || typeof resultRecord.fullOutputPath === "string")
	);
}

/** The same message objects in the same order. */
export function sameMessages(left: readonly AgentMessage[], right: readonly AgentMessage[]): boolean {
	return left.length === right.length && left.every((message, index) => message === right[index]);
}

/** What identifies an edited copy of a message: same role, time and tool call. */
const turnKey = (message: AgentMessage): string =>
	`${message.role}|${message.timestamp}|${"toolCallId" in message ? message.toolCallId : ""}`;

/**
 * Finds where a handler's message stood in `visible`, at or after `cursor`: the message itself first, then the first
 * edited copy (same `turnKey`). Built once per call so long histories stay linear.
 */
function survivorIndex(visible: AgentMessage[]): (message: AgentMessage, cursor: number) => number {
	const byIdentity = new Map<AgentMessage, number>();
	const byTurn = new Map<string, number[]>();
	visible.forEach((message, index) => {
		byIdentity.set(message, index);
		const key = turnKey(message);
		const list = byTurn.get(key);
		if (list) list.push(index);
		else byTurn.set(key, [index]);
	});
	return (message, cursor) => {
		const exact = byIdentity.get(message);
		if (exact !== undefined) return exact >= cursor ? exact : -1;
		return byTurn.get(turnKey(message))?.find((index) => index >= cursor) ?? -1;
	};
}

/**
 * Re-attach the prompt and tool state after a `context` handler. Handlers only see the
 * conversation; the system messages belong to Octocode. An unchanged conversation keeps every
 * system message in place.
 *
 * A changed one (a handler fenced or cleared a result, or windowed the history) keeps the leading
 * system message exactly as it was and puts each later update back before the message it preceded;
 * when that message is gone, before the next one that survives, or at the end. Folding the updates
 * into the leading message instead would change the prompt the provider has cached with every
 * update (a new day rewrote the whole history). A message the handler wrote itself stays where it
 * is. Without a leading system message there is no head to keep, so the system messages fold into one.
 */
export function restoreSystemMessages(
	current: AgentMessage[],
	visible: AgentMessage[],
	returned: AgentMessage[],
): AgentMessage[] {
	if (sameMessages(returned, visible)) return current;
	if (current[0]?.role !== "system") {
		const head = getCurrentSystemMessage(current);
		return head ? [head, ...returned] : returned;
	}

	// For each update, the index in `visible` of the first conversation message after it.
	const updates: { message: AgentMessage; before: number }[] = [];
	let seen = 0;
	for (const message of current.slice(1)) {
		if (message.role === "system") updates.push({ message, before: seen });
		else seen++;
	}

	const indexOf = survivorIndex(visible);
	const restored: AgentMessage[] = [current[0]];
	let next = 0;
	let cursor = 0;
	const place = (through: number) => {
		while (next < updates.length && updates[next].before <= through) restored.push(updates[next++].message);
	};
	for (const message of returned) {
		const at = message.role === "system" ? -1 : indexOf(message, cursor);
		if (at >= 0) {
			place(at);
			cursor = at + 1;
		}
		restored.push(message);
	}
	place(Number.POSITIVE_INFINITY);
	return restored;
}

/** Report each registered MCP server once as unconnected; see `FeatureHost.reportUnhandledMcpServers()`. */
export function reportMcpServersOnce(
	runtime: FeatureRuntime,
	reported: Set<string>,
	emitError: (error: FeatureError) => void,
): void {
	for (const server of runtime.mcpServers.list()) {
		if (reported.has(server.name)) continue;
		reported.add(server.name);
		emitError({
			source: server.source,
			event: "register_mcp_server",
			error: `MCP server "${server.name}" is registered, but no loaded feature connects MCP servers; another feature may have replaced the built-in MCP support`,
		});
	}
}
