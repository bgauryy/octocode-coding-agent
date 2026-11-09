import { renderInstruction } from "../../core/prompt-template.ts";
import { StringEnum } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import type { ExtensionContext } from "../../core/features/index.ts";
import type { Permission } from "../permission/ask.ts";
import { textResult } from "../shared/util.ts";
import { memoryLabel, parseMemoryId } from "./query.ts";
import {
	MEMORY_KINDS,
	MemoryError,
	type MemoryStore,
	memoryLine,
	memoryTags,
	memoryToolLine,
	refuseMemorySecrets,
} from "./store.ts";
import { timedTool } from "../render/rows.ts";

/** Why an agent's global or pinned change asks: the system's reason line on the card. */
const WIDE_REASON =
	"Global memories reach every workspace; pinned memories are recalled automatically within their scope.";

/** The private memory capability consumed by Archive: the description says what it is, `op` owns the operations, the guidelines only when to use it. */
function memoryPrompt(subagent: boolean): {
	ops: string;
	promptGuidelines: string[];
} {
	const ops =
		"search: topic keywords or regex query; get: full record by id; list: newest, pinned first" +
		(subagent ? "" : "; set: add a memory (title required) or update one by id; delete: remove id");
	return {
		ops,
		promptGuidelines: renderInstruction("tools/archive/memory-guidelines.md", { subagent }).split("\n"),
	};
}

/** Every field the full (non-subagent) schema accepts. */
type MemoryParams = {
	op: "search" | "get" | "list" | "set" | "delete";
	id?: string;
	scope?: "workspace" | "project" | "global" | "all";
	title?: string;
	body?: string;
	keywords?: string;
	kind?: (typeof MEMORY_KINDS)[number];
	pinned?: boolean;
};

/** Characters of a body in a search, list or save line; a longer body ends its line with the Archive reference that reads it whole. */
const SAVED_BODY_CHARS = 60;
/** A saved body longer than this keeps its save but gets a warning: an injected line is cut at 600 characters. */
const BODY_SOFT_MAX = 500;
/** Other memories named after a save, so the agent can merge overlapping ones. */
const RELATED_COUNT = 2;

/** Private memory mutation capability. Archive owns retrieval, presentation and the public tool. */
export function createMemoryActions(
	storeFor: (ctx: ExtensionContext) => MemoryStore,
	options: { isSubagent: boolean; permission: Permission },
) {
	const ops = options.isSubagent
		? (["search", "get", "list"] as const)
		: (["search", "get", "list", "set", "delete"] as const);
	const { ops: opsDescription, ...prompt } = memoryPrompt(options.isSubagent);
	const tool = timedTool(
		{
			name: "archive",
			label: "Memory",
			description: "Internal memory mutations; exposed through Archive.",
			...prompt,
			parameters: Type.Object({
				op: StringEnum(ops, { description: opsDescription }),
				id: Type.Optional(
					Type.String({
						description: options.isSubagent ? "get: M<n>" : "get/delete: M<n>",
					}),
				),
				// A subagent only reads: the set-only fields would only cost context.
				...(options.isSubagent
					? {
							scope: Type.Optional(
								StringEnum(["workspace", "project", "global", "all"] as const, {
									description: "search/list: default all",
								}),
							),
						}
					: {
							scope: Type.Optional(
								StringEnum(["workspace", "project", "global", "all"] as const, {
									description: "set: workspace (default), project or global; search/list: default all",
								}),
							),
							title: Type.Optional(
								Type.String({
									description: "set: the rule itself in one line, not a pointer (recall can cut the body)",
								}),
							),
							body: Type.Optional(
								Type.String({
									description: "set: the note; keep it short, it may be injected into every session",
								}),
							),
							keywords: Type.Optional(
								Type.String({ description: "set: synonyms/terms that should retrieve this memory" }),
							),
							kind: Type.Optional(
								StringEnum(MEMORY_KINDS, {
									description: "set: sort of note (default fact; reference: a URL, dashboard or ticket)",
								}),
							),
							pinned: Type.Optional(
								Type.Boolean({
									description: "set: always inject this memory (keep pinned ones few and short)",
								}),
							),
						}),
			}),
			async execute(toolCallId, input, signal, _onUpdate, ctx) {
				// The subagent schema omits the set-only fields; set is refused there before they are read.
				const params = input as MemoryParams;
				signal?.throwIfAborted();
				const store = storeFor(ctx);
				/** Asks the user before a change that reaches every later session; a denial or no one to ask refuses it. A save asks in every mode: `full` runs a `file.outside` change, and this text would steer every later session. */
				const confirmWide = async (wide: boolean, title: string, what: string[], effect: string) => {
					if (!wide) return;
					const verdict = await options.permission.check(ctx, {
						action: "file.outside",
						title,
						what,
						reason: WIDE_REASON,
						...(params.op === "set" ? { reasons: ["memory.wide" as const] } : {}),
						effect,
						undo: "/memory edits or deletes it",
						risk: "text this session read could steer every later session",
						toolCallId,
						cwd: ctx.cwd,
						...(signal ? { signal } : {}),
					});
					if (!verdict.allowed) throw new MemoryError(verdict.message);
				};
				const id = params.id === undefined ? undefined : parseMemoryId(params.id);
				if (params.id !== undefined && id === undefined) throw new Error(`"${params.id}" is not a memory id (M<n>).`);
				const needId = (): number => {
					if (id === undefined) throw new Error(`${params.op} needs id.`);
					return id;
				};
				switch (params.op) {
					case "set":
					case "delete": {
						if (options.isSubagent)
							throw new Error("Memory is read-only in a subagent: report it to your coordinator instead.");
						const current = id === undefined ? undefined : store.get(id);
						if (params.op === "delete") {
							if (current) {
								await confirmWide(
									current.scope === "global" || current.pinned,
									"Delete this shared memory?",
									[`${memoryLabel(current.id)} (${memoryTags(current)}) ${current.title}`],
									"removes a memory every later session receives",
								);
							}
							const removed = store.delete(needId());
							return textResult(`Deleted ${memoryLine(removed)}`, { ids: [removed.id] });
						}
						if (params.scope === "all") throw new Error("set scope is workspace, project or global.");
						const global = (params.scope ?? current?.scope) === "global";
						const pinned = params.pinned ?? current?.pinned ?? false;
						// Refusals the store would raise come first, so the user is never asked about a save that then fails.
						refuseMemorySecrets(params);
						if (!current && !params.title?.trim()) throw new MemoryError("A new memory needs a title.");
						const body = params.body ?? current?.body ?? "";
						// Only what reaches every session after the change asks: unpinning or moving into the project narrows it.
						await confirmWide(
							global || pinned,
							current ? "Change this shared memory?" : "Save this shared memory?",
							[
								`${current ? `${memoryLabel(current.id)} ` : ""}(${global ? "global" : (params.scope ?? current?.scope ?? (store.workspaceId ? "workspace" : "project"))}${pinned ? ", pinned" : ""}) ${params.title ?? current?.title ?? ""}`,
								...(body ? [body] : []),
							],
							`${current ? "changes" : "saves"} a memory every later session receives`,
						);
						const { memory, created } = store.set({
							...(id !== undefined ? { id } : {}),
							...(params.scope ? { scope: params.scope } : {}),
							...(params.kind ? { kind: params.kind } : {}),
							...(params.title !== undefined ? { title: params.title } : {}),
							...(params.body !== undefined ? { body: params.body } : {}),
							...(params.keywords !== undefined ? { keywords: params.keywords } : {}),
							...(params.pinned !== undefined ? { pinned: params.pinned } : {}),
							author: "agent",
							sourceSession: ctx.sessionManager.getSessionId(),
						});
						const long =
							memory.body.length > BODY_SOFT_MAX
								? `\nKept, but the body is ${memory.body.length} chars: shorten it to under ${BODY_SOFT_MAX}, the rule and why.`
								: "";
						const related = store
							.search(`${memory.title} ${memory.keywords} ${memory.body}`, "all", RELATED_COUNT, new Set([memory.id]))
							.map((hit) => `${memoryLabel(hit.id)} ${hit.title.replace(/\s+/g, " ")}`);
						const neighbours = related.length > 0 ? `\nRelated: ${related.join("; ")}` : "";
						return textResult(
							`${created ? "Saved" : "Updated"} ${memoryToolLine(memory, SAVED_BODY_CHARS)}${long}${neighbours}`,
							{ ids: [memory.id] },
						);
					}
					// Archive answers the reads itself and routes only set and delete here.
					case "search":
					case "get":
					case "list":
						throw new Error(`Archive answers ${params.op}; memory actions only set and delete.`);
					default: {
						// Unreachable by type, but the op is model input at runtime.
						const unknown: never = params.op;
						throw new Error(`Unknown op ${JSON.stringify(unknown)}.`);
					}
				}
			},
		},
		{ exclusive: true },
	);
	return Object.assign(tool, { storeFor });
}
