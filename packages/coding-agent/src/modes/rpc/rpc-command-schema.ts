import { MAX_COMPACTION_INSTRUCTIONS } from "../../core/compaction/manual-options.ts";
/**
 * The RPC command protocol (stdin) as one TypeBox schema. `RpcCommand` in `rpc-types.ts` is derived from it,
 * and `rpc-mode.ts` validates every parsed line against it before dispatch.
 */

import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import { type TObject, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

const command = <T extends string, P extends Record<string, TSchema> = {}>(type: T, properties: P = {} as P) =>
	Type.Object({ id: Type.Optional(Type.String()), type: Type.Literal(type), ...properties });

const ImageContentSchema = Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() });
const ImagesSchema = Type.Optional(Type.Array(ImageContentSchema));
const QueueModeSchema = Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")]);
const ThinkingLevelSchema = Type.Unsafe<ThinkingLevel>(
	Type.Union(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => Type.Literal(level))),
);

export const RpcCommandSchema = Type.Union([
	// Prompting
	command("prompt", {
		message: Type.String(),
		images: ImagesSchema,
		streamingBehavior: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")])),
		waitForCompletion: Type.Optional(Type.Boolean()),
		dispatchId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	}),
	command("steer", { message: Type.String(), images: ImagesSchema }),
	command("follow_up", { message: Type.String(), images: ImagesSchema }),
	command("abort"),
	command("clear_queue"),
	command("get_queue"),
	command("edit_queued", { queueId: Type.String(), text: Type.String() }),
	command("remove_queued", { queueId: Type.String() }),
	command("move_queued", {
		queueId: Type.String(),
		direction: Type.Union([Type.Literal("up"), Type.Literal("down")]),
	}),
	command("new_session", { parentSession: Type.Optional(Type.String()) }),

	// State
	command("plan", {
		action: Type.Union([Type.Literal("show"), Type.Literal("enter"), Type.Literal("leave"), Type.Literal("approve")]),
		revision: Type.Optional(Type.Integer({ minimum: 1 })),
	}),
	command("get_state"),

	// Model
	command("set_model", { provider: Type.String(), modelId: Type.String() }),
	command("cycle_model"),
	command("get_available_models"),

	// Thinking
	command("set_thinking_level", { level: ThinkingLevelSchema }),
	command("cycle_thinking_level"),
	command("get_available_thinking_levels"),

	// Queue modes
	command("set_steering_mode", { mode: QueueModeSchema }),
	command("set_follow_up_mode", { mode: QueueModeSchema }),

	// Compaction
	command("compact", { customInstructions: Type.Optional(Type.String({ maxLength: MAX_COMPACTION_INSTRUCTIONS })) }),

	// Retry
	command("set_auto_retry", { enabled: Type.Boolean() }),
	command("abort_retry"),

	// Bash
	command("bash", { command: Type.String(), excludeFromContext: Type.Optional(Type.Boolean()) }),
	command("abort_bash"),

	// Session
	command("get_session_stats"),
	command("persist_session"),
	command("export_html", { outputPath: Type.Optional(Type.String()) }),
	command("switch_session", { sessionPath: Type.String() }),
	command("fork", { entryId: Type.String() }),
	command("clone"),
	command("get_fork_messages"),
	command("get_entries", { since: Type.Optional(Type.String()) }),
	command("get_tree"),
	command("get_last_assistant_text"),
	command("set_session_name", { name: Type.String() }),

	// Messages
	command("get_messages"),

	// Commands (available for invocation via prompt)
	command("get_commands"),
]);

const commandSchemas = new Map<string, TObject>(
	RpcCommandSchema.anyOf.map((schema) => [schema.properties.type.const as string, schema as TObject]),
);

export type RpcCommandValidation =
	| { ok: true }
	| { ok: false; commandType: string; id: string | undefined; message: string };

/** Check a parsed stdin value against the command schema; the message names the offending field. */
export function validateRpcCommand(value: unknown): RpcCommandValidation {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, commandType: "invalid", id: undefined, message: "Invalid command: expected a JSON object" };
	}
	const { id, type } = value as { id?: unknown; type?: unknown };
	const validId = typeof id === "string" ? id : undefined;
	if (typeof type !== "string") {
		return {
			ok: false,
			commandType: "invalid",
			id: validId,
			message: 'Invalid command: field "type" is required and must be a string',
		};
	}
	const schema = commandSchemas.get(type);
	if (!schema) {
		return { ok: false, commandType: type, id: validId, message: `Unknown command: ${type}` };
	}
	const errors = [...Value.Errors(schema, value)];
	if (errors.length === 0) return { ok: true };
	const details = [...new Set(errors.map(describeError))].slice(0, 5).join("; ");
	return { ok: false, commandType: type, id: validId, message: `Invalid "${type}" command: ${details}` };
}

function describeError(error: { instancePath: string; keyword: string; message: string; params: object }): string {
	if (error.keyword === "required") {
		const missing = (error.params as { requiredProperties?: string[] }).requiredProperties ?? [];
		return `missing required field ${missing.map((name) => `"${name}"`).join(", ")}`;
	}
	const field = error.instancePath.replace(/^\//, "").replaceAll("/", ".") || "(root)";
	return `field "${field}" ${error.message}`;
}
