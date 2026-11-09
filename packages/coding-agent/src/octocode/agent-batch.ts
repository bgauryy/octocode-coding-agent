import { type JsonObject, validateToolArguments } from "@octocodeai/octocode-ai";
import type { TSchema } from "typebox";
import type { ToolDefinition } from "../core/features/index.ts";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { agentCall } from "./child-sessions/agent-call.ts";
import { declaresReason } from "./shared/reason.ts";

/** The task type's `tasks` field: start several children in one call. */
export const TASKS_FIELD = "tasks";

type Execute = ToolDefinition["execute"];
type Result = Awaited<ReturnType<Execute>>;
type Fields = Record<string, unknown>;

/** The `tasks` property: entries are task-field objects, each validated by the task mode itself, so no field is spelled out here. */
export function tasksSchema(): TSchema & { description: string } {
	return {
		type: "array",
		items: { type: "object" },
		description: "task: several at once, each with the task fields; top-level task fields are defaults.",
	} as unknown as TSchema & { description: string };
}

/**
 * A row's head word: `error` when the entry never ran; otherwise the child's own outcome when it is not `done`
 * (`failed`, `partial`, `blocked`), so a child that ran and failed does not read `ok`; else `ok`.
 */
function rowLabel(each: { ok: boolean; details?: unknown }): string {
	if (!each.ok) return "error";
	const outcome = isRecord(each.details) ? each.details.outcome : undefined;
	return typeof outcome === "string" && outcome && outcome !== "done" ? outcome : "ok";
}

const textOf = (result: Result) =>
	result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");

interface Outcome {
	goal: string;
	ok: boolean;
	text: string;
	details?: unknown;
}

/** Whether `args` is a task batch: render it as a list, not as one call. */
export const batchOf = (args: unknown): Fields[] | undefined => {
	const tasks = isRecord(args) ? args[TASKS_FIELD] : undefined;
	return Array.isArray(tasks) ? tasks.filter(isRecord) : undefined;
};

/** The call line of a batch, one goal per entry; `agent-tool.ts` wraps it, so the SDK entry does not reach the TUI here. */
export function batchCallText(args: unknown): string {
	const { tasks: _tasks, type: _type, ...defaults } = isRecord(args) ? args : ({} as Fields);
	const lines = (batchOf(args) ?? []).map((entry, index) => {
		const goal = entry.goal ?? defaults.goal;
		return `  ${index + 1}. ${typeof goal === "string" ? goal : "(no goal)"}`;
	});
	return `Agent task ×${lines.length}\n${lines.join("\n")}`;
}

/**
 * Start every entry through the task mode's own `execute`, as separate calls: each is validated like a single call and
 * takes its own spawn ask, slot and reservations. One failure leaves the rest running; the result has one section per entry.
 */
export async function runBatch(
	tool: ToolDefinition,
	id: string,
	fields: Fields,
	reason: string | undefined,
	call: { signal: AbortSignal | undefined; onUpdate: Parameters<Execute>[3]; ctx: Parameters<Execute>[4] },
): Promise<Result> {
	const { [TASKS_FIELD]: tasks, ...defaults } = fields;
	if (!Array.isArray(tasks) || tasks.length === 0 || !tasks.every(isRecord))
		throw new Error("tasks must be a non-empty array of task objects.");
	const allowed = new Set(
		Object.keys(isRecord(tool.parameters) ? ((tool.parameters as { properties?: Fields }).properties ?? {}) : {}),
	);
	const latest = new Map<number, string>();
	const announce = () =>
		call.onUpdate?.({
			content: [{ type: "text", text: [...latest].map(([index, text]) => `#${index + 1} ${text}`).join("\n") }],
			details: { agentType: "task", batch: [] },
		});
	const runs = tasks.map(async (entry, index): Promise<Outcome> => {
		const merged = { ...defaults, ...entry };
		const goal = typeof merged.goal === "string" ? merged.goal : "(no goal)";
		const foreign = Object.keys(entry).filter((field) => !allowed.has(field));
		if (foreign.length > 0) throw Object.assign(new Error(`does not take ${foreign.join(", ")}.`), { goal });
		const own = agentCall({ type: "task", ...merged }).input;
		if (reason !== undefined && own.reason === undefined && declaresReason(tool.parameters)) own.reason = reason;
		const entryId = `${id}#${index + 1}`;
		let input: Fields;
		try {
			input = validateToolArguments(
				{ name: "agent task", description: tool.description, parameters: tool.parameters },
				{ type: "toolCall", id: entryId, name: "agent task", arguments: own as JsonObject },
			);
		} catch (error) {
			throw Object.assign(new Error(`Invalid agent task call. ${errorMessage(error)}`), { goal });
		}
		const result = await tool.execute(
			entryId,
			input,
			call.signal,
			call.onUpdate
				? (update) => {
						latest.set(index, textOf(update));
						announce();
					}
				: undefined,
			call.ctx,
		);
		return { goal, ok: true, text: textOf(result), details: result.details };
	});
	const settled = await Promise.allSettled(runs);
	const outcomes = settled.map((each): Outcome => {
		if (each.status === "fulfilled") return each.value;
		const goal =
			(isRecord(each.reason) && typeof each.reason.goal === "string" ? each.reason.goal : undefined) ?? "(no goal)";
		return { goal, ok: false, text: errorMessage(each.reason) };
	});
	const text = outcomes
		.map((each, index) => `#${index + 1} ${rowLabel(each)}: ${each.goal}\n${each.text}`)
		.join("\n\n");
	if (outcomes.every((each) => !each.ok)) throw new Error(text);
	return {
		content: [{ type: "text", text }],
		details: {
			agentType: "task",
			batch: outcomes.map(({ goal, ok, details, text: message }) => ({
				goal,
				ok,
				...(ok ? { details } : { error: message }),
			})),
		},
	};
}
