import { asRecord } from "@octocodeai/octocode-contracts/guards";

/**
 * The `agent` tool's call shape: `type` plus top-level fields, each documented "Only for: <type>". A type's fields are its
 * mode's own arguments, except where two modes name different things alike; those take the public names below. The
 * call's `reason` doubles as coordinate's lock note. Domain policy, rows and transcript readers go through `agentCall`.
 */

/** Public field name -> the mode's own argument name, for each type whose arguments collide with another type's. */
export const AGENT_FIELD_RENAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	coordinate: { subagent: "id", joinGoal: "goal" },
	external: { externalAction: "action", connection: "id", externalModel: "model", promptText: "text" },
};

/** One `agent` call as its mode reads it: the type and the mode's own arguments (the call's `reason` included). */
interface AgentCall {
	type: string | undefined;
	input: Record<string, unknown>;
}

/** The mode's argument name for public field `field` of `type`. */
const modeField = (type: string | undefined, field: string): string =>
	(type === undefined ? undefined : AGENT_FIELD_RENAMES[type]?.[field]) ?? field;

/** Read an `agent` call's arguments; anything else reads as an empty call. */
export function agentCall(args: unknown): AgentCall {
	const record = asRecord(args);
	const type = typeof record.type === "string" ? record.type : undefined;
	const input: Record<string, unknown> = {};
	for (const [field, value] of Object.entries(record)) if (field !== "type") input[modeField(type, field)] = value;
	return { type, input };
}
