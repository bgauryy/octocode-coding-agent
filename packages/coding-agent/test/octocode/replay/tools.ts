import { Type } from "typebox";
import type { ToolDefinition } from "../../../src/core/features/index.ts";
import type { Recording } from "./recording.ts";

/**
 * Stand-ins for every tool the recording calls, under the recorded names. They replace the session's own tools of the
 * same name (SDK tools win over built-in and native ones), so a replayed `bash` or `file` call never runs a command or
 * writes a file: each returns the recorded result for its call id, or an error result when the recording has none.
 */

export interface ReplayToolObservations {
	/** Calls answered from the recording. */
	replayed: number;
	/** Calls the recording has no result for (`tool toolCallId`). */
	notRecorded: string[];
	/** Calls by tool name, as executed. */
	byName: Map<string, number>;
	/** Call ids a stand-in answered: a call that ended without one was refused before it ran. */
	ran: Set<string>;
}

export function replayTools(recording: Recording): { tools: ToolDefinition[]; seen: ReplayToolObservations } {
	const seen: ReplayToolObservations = { replayed: 0, notRecorded: [], byName: new Map(), ran: new Set() };
	const tools = recording.toolNames.map((name): ToolDefinition => ({
		name,
		label: name,
		description: `Replays the recorded result of the ${name} tool.`,
		// Recorded arguments come from tools with other schemas: accept any object, check nothing.
		parameters: Type.Object({}, { additionalProperties: true }),
		async execute(toolCallId) {
			// A tool's result arrives as I/O: the event loop turns, as it does when a real tool runs.
			await new Promise((resolve) => setImmediate(resolve));
			seen.byName.set(name, (seen.byName.get(name) ?? 0) + 1);
			seen.ran.add(toolCallId);
			const recorded = recording.results.get(toolCallId)?.shift();
			if (!recorded) {
				seen.notRecorded.push(`${name} ${toolCallId}`);
				return {
					content: [{ type: "text", text: `[replay] The recording has no result for this ${name} call.` }],
					details: {},
					isError: true,
				};
			}
			seen.replayed += 1;
			return { content: recorded.content, details: recorded.details ?? {}, isError: recorded.isError };
		},
	}));
	return { tools, seen };
}
