import { type JsonObject, validateToolArguments } from "@octocodeai/octocode-ai";
import type { TSchema } from "typebox";
import type { ToolDefinition } from "../../../../core/features/index.ts";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { agentCall } from "../../../child-sessions/agent-call.ts";
import { declaresReason } from "../../../shared/reason.ts";
import { addUsage, emptyUsage } from "../../../shared/util.ts";

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
		description: "task: several; top-level fields: defaults",
	} as unknown as TSchema & { description: string };
}

/**
 * A row's head word: `error` when the entry never ran; otherwise the child's own outcome when it is not `done`
 * (`failed`, `partial`, `blocked`), so a child that ran and failed does not read `ok`; else `ok`.
 */
function rowLabel(each: { ok: boolean; isError?: boolean; details?: unknown }): string {
	if (!each.ok) return "error";
	const outcome = isRecord(each.details) ? each.details.outcome : undefined;
	return typeof outcome === "string" && outcome && outcome !== "done" ? outcome : each.isError ? "error" : "ok";
}

const textOf = (result: Result) =>
	result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");

interface Outcome {
	goal: string;
	ok: boolean;
	isError?: boolean;
	usage?: Result["usage"];
	text: string;
	details?: unknown;
}

/** Whether `args` is a task batch: render it as a list, not as one call. */
export const batchOf = (args: unknown): Fields[] | undefined => {
	const tasks = isRecord(args) ? args[TASKS_FIELD] : undefined;
	return Array.isArray(tasks) ? tasks.filter(isRecord) : undefined;
};

/** Resolve the same per-entry defaults for execution and both display surfaces. */
export function batchGoals(args: unknown): string[] {
	const defaults = isRecord(args) ? args : {};
	return (batchOf(args) ?? []).map((entry) => {
		const goal = { ...defaults, ...entry }.goal;
		return typeof goal === "string" ? goal : "(no goal)";
	});
}

/** The call line of a batch, one goal per entry; `tool.ts` wraps it, so the SDK entry does not reach the TUI here. */
export function batchCallText(args: unknown): string {
	const lines = batchGoals(args).map((goal, index) => `  ${index + 1}. ${goal}`);
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
	// Each entry's goal, its own or the batch default: a row names it whether the entry ran, was refused or crashed.
	const goals = batchGoals(fields);
	const runs = tasks.map(async (entry, index): Promise<Outcome> => {
		const merged = { ...defaults, ...entry };
		const goal = goals[index] ?? "(no goal)";
		const foreign = Object.keys(entry).filter((field) => !allowed.has(field));
		if (foreign.length > 0) throw new Error(`does not take ${foreign.join(", ")}.`);
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
			throw new Error(`Invalid agent task call. ${errorMessage(error)}`, { cause: error });
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
		return {
			goal,
			ok: true,
			isError: result.isError,
			usage: result.usage,
			text: textOf(result),
			details: result.details,
		};
	});
	const settled = await Promise.allSettled(runs);
	const outcomes = settled.map((each, index): Outcome => {
		if (each.status === "fulfilled") return each.value;
		return { goal: goals[index] ?? "(no goal)", ok: false, text: errorMessage(each.reason) };
	});
	const text = outcomes
		.map((each, index) => `#${index + 1} ${rowLabel(each)}: ${each.goal}\n${each.text}`)
		.join("\n\n");
	if (outcomes.every((each) => !each.ok)) throw new Error(text);
	const metered = outcomes.filter((each) => each.usage !== undefined);
	const usage = metered.length ? emptyUsage() : undefined;
	if (usage) for (const each of metered) addUsage(usage, each.usage);
	return {
		...(outcomes.some((each) => !each.ok || each.isError) ? { isError: true } : {}),
		...(usage ? { usage } : {}),
		content: [{ type: "text", text }],
		details: {
			agentType: "task",
			...(outcomes.some((each) => isRecord(each.details) && each.details.unpriced === true) ? { unpriced: true } : {}),
			batch: outcomes.map(({ goal, ok, isError, details, text: message }) => ({
				goal,
				ok,
				...(isError ? { isError: true } : {}),
				...(ok ? { details } : { error: message }),
			})),
		},
	};
}
