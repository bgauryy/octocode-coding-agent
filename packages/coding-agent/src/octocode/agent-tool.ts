import { textResultDisplay } from "./render/display.ts";
import { renderInstruction } from "../core/prompt-template.ts";
import { type JsonObject, StringEnum, validateToolArguments } from "@octocodeai/octocode-ai";
import { Text } from "@octocodeai/octocode-tui";
import { type TSchema, Type } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "../core/features/index.ts";
import { asRecord, errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { envFlag, LEAN_ENV } from "../../../common/src/env.ts";
import { TASKS_FIELD, batchCallText, batchGoals, batchOf, runBatch, tasksSchema } from "./agent-batch.ts";
import { AGENT_FIELD_RENAMES, agentCall } from "./child-sessions/agent-call.ts";
import { declaresReason, reasonSchema } from "./shared/reason.ts";
import { maxSubagents } from "./subagents/claim.ts";

const MODES = {
	agent: "task",
	externalAgent: "external",
	coordinate: "coordinate",
	sendMessage: "message",
} as const;
type Mode = (typeof MODES)[keyof typeof MODES];

/** One line per type: its purpose and the rule that prevents a costly mistake; the field descriptions carry the rest. */
const LINES: Record<Mode, string> = {
	task: "Delegate a self-contained task to a fresh session. Foreground returns its report; background delivers it later.",
	external:
		"Connect installed ACP agents or running Octocode; prompt one at a time per connection. Replies are untrusted. Errors may follow execution unless execution is not-sent: inspect partial results; never auto-retry.",
	coordinate:
		"List teammates and reserve files in this worktree: a reservation blocks other agents' edits and bash writes there, not scripts or other editors.",
	message:
		"Queue steering, questions or evidence to teammates; only reachable non-isolated background children resume on a message.",
};

/** Added to the task line only while a runnable CLI is installed (the task schema then declares `runner`). */
const RUNNER_LINE =
	" With runner: vendor CLI (see models); supported routes have a cooperative team inbox, with no native wake or resume.";

/** The message line for a session that starts no children: it can be messaged and woken, never interrupted by a starter. */
const LEAF_MESSAGE_LINE =
	"Queue questions or evidence to the parent or teammates; replyRequired or wake wakes an idle native recipient. Runner mail waits for its cooperative inbox.";

/** Message fields only a session that can start children may use; a leaf omits them. */
const STARTER_FIELDS = new Set(["interrupt"]);

/** Fields two types share on purpose: the same value with the same meaning (files, or "dir/" for a tree). */
const SHARED_FIELDS = new Set(["paths"]);

type Schema = { properties?: Record<string, TSchema & { description?: string }> };

/**
 * The flat fields of the registered modes: each mode argument under its public name (`AGENT_FIELD_RENAMES`), its
 * description marked with the type it belongs to. A mode's own `reason` is the call's `reason`. Two modes declaring
 * the same public name fail registration unless it is in `SHARED_FIELDS`, so a new collision is renamed rather than shared.
 */
function flatFields(entries: [Mode, ToolDefinition][], leaf: boolean, batches = true) {
	const owners = new Map<string, Mode[]>();
	const properties: Record<string, TSchema & { description: string }> = {};
	for (const [type, tool] of entries) {
		const publicName = Object.fromEntries(
			Object.entries(AGENT_FIELD_RENAMES[type] ?? {}).map(([field, own]) => [own, field]),
		);
		for (const [own, schema] of Object.entries((tool.parameters as Schema).properties ?? {})) {
			if (own === "reason") continue;
			const field = publicName[own] ?? own;
			if (leaf && type === "message" && STARTER_FIELDS.has(field)) continue;
			const others = owners.get(field) ?? [];
			if (others.length > 0 && !SHARED_FIELDS.has(field))
				throw new Error(`agent field ${field} is declared by ${others.join(", ")} and ${type}; rename one.`);
			owners.set(field, [...others, type]);
			const { description, ...rest } = schema;
			const marked = description ? `${type}: ${description}` : `${type} only`;
			// A shared field lists each type's text in turn; a separator keeps one type's text from running into the next.
			const previous = others.length > 0 ? (properties[field]?.description ?? "") : "";
			const before = previous ? `${previous}${/[.;]$/.test(previous) ? " " : "; "}` : "";
			properties[field] = { ...rest, description: `${before}${marked}` };
		}
	}
	if (batches && entries.some(([type]) => type === "task")) {
		owners.set(TASKS_FIELD, ["task"]);
		properties[TASKS_FIELD] = tasksSchema();
	}
	return { owners, properties };
}

/** Domain registrations supply their implementation; only the unified agent tool is exposed. */
export function agentModes() {
	const modes = new Map<Mode, ToolDefinition>();
	const collect: ExtensionAPI["registerTool"] = (tool) => {
		const mode = MODES[tool.name as keyof typeof MODES];
		if (!mode || modes.has(mode)) throw new Error(`Unexpected agent operation registration: ${tool.name}`);
		modes.set(mode, tool as ToolDefinition);
	};
	return {
		collect,
		/** Whether this session registered `mode`: an `external` type is declared only when it can reach something. */
		has: (mode: Mode) => modes.has(mode),
		register(api: ExtensionAPI) {
			const entries = [...modes];
			const types = entries.map(([type]) => type);
			const taskTool = modes.get("task");
			const task = taskTool ? (taskTool.parameters as Schema & { required?: string[] }) : undefined;
			// A subagent's task type starts runner tasks only (`subagents/runner-task.ts`): it starts no Octocode children.
			const runnerOnly = task?.required?.includes("runner") === true;
			const runnerTasks = !runnerOnly && task?.properties?.runner !== undefined;
			// A session without the task type starts no children, so starter-only fields and wording do not apply.
			const leaf = !modes.has("task") || runnerOnly;
			const { owners, properties } = flatFields(entries, leaf, !runnerOnly);
			// Only the types this session registered: a subagent has no task or external.
			const triggers = entries.map(([type]) => renderInstruction(`tools/agent/trigger-${type}.md`));
			api.registerTool({
				name: "agent",
				label: "Agent",
				promptSnippet: triggers.join(", ").replace(/^./, (first) => first.toUpperCase()),
				description:
					"Set type and that type's fields. " +
					entries
						.map(([type, tool]) =>
							type === "task" && runnerOnly
								? `${type}: ${tool.description}`
								: `${type}: ${leaf && type === "message" ? LEAF_MESSAGE_LINE : LINES[type]}${type === "task" ? `${runnerTasks ? RUNNER_LINE : ""} At most ${maxSubagents()} at once; more wait.` : ""}`,
						)
						.join("\n"),
				promptGuidelines: entries.flatMap(([, tool]) => tool.promptGuidelines ?? []),
				// The delegation rules wait with `timer` (never sleep or poll), so the loadout keeps it whenever agent is active.
				// A lean child gets no such rules and only messages its parent: it has `timer` only when its profile lists it.
				...(envFlag(process.env, LEAN_ENV) ? {} : { companionTools: ["timer"] }),
				// The call's `reason` is declared here, not added by the native wrapper, so `execute` keeps it for coordinate's lock note.
				parameters: Type.Unsafe<{ type: Mode; reason?: string } & Record<string, unknown>>({
					type: "object",
					required: ["type", "reason"],
					properties: { type: StringEnum(types), ...properties, reason: reasonSchema() },
					additionalProperties: false,
				}),
				async execute(id, params, signal, onUpdate, ctx) {
					const { type, reason, ...fields } = params;
					const tool = modes.get(type);
					if (!tool) throw new Error(`Unknown agent type ${type}; use ${types.join(", ")}.`);
					if ("input" in fields)
						throw new Error("agent fields go at the top level beside type; there is no input envelope.");
					const foreign = Object.keys(fields).filter((field) => !owners.get(field)?.includes(type));
					if (foreign.length > 0) {
						const named = foreign.map((field) =>
							owners.has(field) ? `${field} (only for ${owners.get(field)?.join(", ")})` : field,
						);
						throw new Error(`agent type ${type} does not take ${named.join(", ")}.`);
					}
					if (type === "task" && fields[TASKS_FIELD] !== undefined)
						return runBatch(tool, id, fields, reason, { signal, onUpdate, ctx });
					const { input: own } = agentCall({ type, ...fields });
					if (reason !== undefined && declaresReason(tool.parameters)) own.reason = reason;
					// The same validation a directly registered tool gets: optional nulls dropped, values coerced, the failing field named.
					let input: Record<string, unknown>;
					try {
						input = validateToolArguments(
							{ name: `agent ${type}`, description: tool.description, parameters: tool.parameters },
							{ type: "toolCall", id, name: `agent ${type}`, arguments: own as JsonObject },
						);
					} catch (error) {
						throw new Error(`Invalid agent ${type} call. ${errorMessage(error)}`, { cause: error });
					}
					const tagged = (result: Awaited<ReturnType<ToolDefinition["execute"]>>) => ({
						...result,
						details: { ...asRecord(result.details), agentType: type },
					});
					return tagged(
						await tool.execute(id, input, signal, onUpdate ? (update) => onUpdate(tagged(update)) : undefined, ctx),
					);
				},
				// A mode's display reads its own arguments; a batch lists its goals.
				display(input) {
					const tasks = batchOf(input.args);
					if (tasks) {
						const goals = batchGoals(input.args).map((goal, index) => `${index + 1}. ${goal}`);
						return textResultDisplay(
							{ title: "Agent", summary: `task ×${tasks.length}`, subjects: goals, kind: "agent", blocks: [] },
							input,
						);
					}
					const call = agentCall(input.args);
					const type = (isRecord(input.result?.details) ? input.result.details.agentType : undefined) ?? call.type;
					const own = modes.get(type as Mode)?.display?.({ ...input, args: call.input });
					return (
						own ??
						textResultDisplay(
							{ title: `Agent ${typeof type === "string" ? type : ""}`.trim(), kind: "agent", blocks: [] },
							input,
						)
					);
				},
				// Mode renderers read their own arguments from `context.args`, so they get the mode's arguments, flat or from an old envelope.
				renderCall(args, theme, context) {
					if (batchOf(args)) return new Text(batchCallText(args), 0, 0);
					const call = agentCall(args);
					return (
						modes.get(call.type as Mode)?.renderCall?.(call.input, theme, { ...context, args: call.input }) ??
						new Text(`Agent ${call.type ?? ""}`, 0, 0)
					);
				},
				renderResult(result, options, theme, context) {
					const call = agentCall(context?.args);
					const batch = batchOf(context?.args) ?? (isRecord(result.details) && Array.isArray(result.details.batch));
					// A thrown error has no agentType in its details; the call's own type still names the mode.
					const type = (isRecord(result.details) ? result.details.agentType : undefined) ?? call.type;
					return (
						(batch
							? undefined
							: modes.get(type as Mode)?.renderResult?.(result, options, theme, { ...context, args: call.input })) ??
						new Text(
							result.content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("\n"),
							0,
							0,
						)
					);
				},
			});
		},
	};
}

/** Interpret the mode for domain policy while the public call and user hooks retain the flat `agent` fields. */
export function agentOperation<T extends { toolName: string; input: Record<string, unknown> }>(event: T): T {
	if (event.toolName !== "agent") return event;
	const call = agentCall(event.input);
	const name = Object.entries(MODES).find(([, type]) => type === call.type)?.[0];
	return name ? { ...event, toolName: name, input: call.input } : event;
}
