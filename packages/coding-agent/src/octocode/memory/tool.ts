import { StringEnum } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import type { ExtensionContext } from "../../core/features/index.ts";
import { renderInstruction } from "../../core/prompt-template.ts";
import type { Permission } from "../permission/ask.ts";
import { textResultDisplay } from "../render/display.ts";
import { timedTool, timingOf } from "../render/rows.ts";
import { resultBlock, toolHeader } from "../render/tool.ts";
import { exclusive } from "../shared/locks.ts";
import { clip } from "../shared/text.ts";
import { contentText, textResult } from "../shared/util.ts";
import { MEMORY_TOOL_NAME } from "./inject.ts";
import { parseMemoryId } from "./query.ts";
import { compileQuery } from "./safe-pattern.ts";
import { noteLabel, parseNoteId } from "./session-notes.ts";
import { type AppendEntry, deleteNote, getNote, noteForPromotion, readNotes, saveNote } from "./session-notes-tool.ts";
import { getMemory, readMemories } from "./reads.ts";
import { MEMORY_KINDS, type MemoryStore } from "./store.ts";
import { type MemoryWriteParams, writeMemory } from "./write.ts";

/** Every field the full (non-subagent) schema accepts. */
type MemoryParams = Omit<MemoryWriteParams, "op" | "scope"> & {
	scope?: "session" | "workspace" | "project" | "global" | "all";
	op: "search" | "get" | "list" | "set" | "delete";
	id?: string;
	query?: string;
	limit?: number;
	cursor?: string;
};

interface MemoryDetails {
	/** A read: its op, how many memories it returned and the cursor that continues it. */
	mode?: "search" | "get" | "list";
	hits?: number;
	nextCursor?: string;
	/** A write: the memory it saved, updated or deleted, and the version a save shows (`MemoryWriteDetails`). */
	ids?: number[];
	updated?: number[];
}

const SCOPES = ["session", "workspace", "project", "global", "all"] as const;

/** The write path's parameters: everything but the session scope, which the session-note operations took. */
function durableParams(params: MemoryParams): Omit<MemoryWriteParams, "op"> {
	const { scope, ...rest } = params;
	return { ...rest, ...(scope && scope !== "session" ? { scope } : {}) };
}

/** `op`, then what the call names: an id, a title, keywords or a query. */
function callSummary(args: Record<string, unknown> | undefined): string {
	const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
	const detail = text(args?.id) ?? text(args?.title) ?? text(args?.keywords) ?? text(args?.query) ?? "";
	return [text(args?.op) ?? "list", clip(detail, 100)].filter(Boolean).join(" ");
}

/**
 * The `memory` tool: durable notes of this workspace (`store.ts`). The main session searches, reads, saves and deletes;
 * a subagent only reads, so its schema leaves out `set`, `delete` and the fields only a save takes. Reads run side by
 * side; writes run one at a time.
 */
export function createMemoryTool(
	storeFor: (ctx: ExtensionContext) => MemoryStore,
	options: { isSubagent: boolean; permission: Permission; appendEntry?: AppendEntry },
) {
	const subagent = options.isSubagent;
	const ops = subagent ? (["search", "get", "list"] as const) : (["search", "get", "list", "set", "delete"] as const);
	const write = exclusive(writeMemory);
	// Session-note writes share the memory writes' queue: an id is chosen from the notes the previous write appended.
	const queued = exclusive(async (run: () => unknown) => run());
	const writeNoteOp = <R>(run: () => R) => queued(run) as Promise<Awaited<R>>;
	return timedTool({
		name: MEMORY_TOOL_NAME,
		roleVariant: true,
		label: "Memory",
		promptSnippet: renderInstruction("tools/memory/snippet.md"),
		// One description for every role (it leads the cached tool list); `op` and the field texts say what this one may do.
		description:
			"Short notes: session (this session only, survive compaction) or workspace/project/global for later sessions; list shows pinned first. Near-duplicates in the scope are refused: update them. Global or pinned changes ask the user first.",
		promptGuidelines: renderInstruction("tools/memory/guidelines.md", { subagent }).split("\n"),
		parameters: Type.Object({
			op: StringEnum(ops, {
				description: subagent ? "search, get or list" : "set: add a memory (needs title), or update id",
			}),
			id: Type.Optional(
				Type.String({ description: "M<n>, or S<n> for a session note (set it with a durable scope: moves it there)" }),
			),
			query: Type.Optional(
				Type.String({
					description:
						"search: case-insensitive regex filter (max 200 chars; nested repeats like (a+)+ and backreferences are rejected)",
				}),
			),
			keywords: Type.Optional(
				Type.String({
					description: subagent
						? "search: topic words, ranked"
						: "search: topic words, ranked; set: terms that retrieve it",
				}),
			),
			scope: Type.Optional(
				StringEnum(SCOPES, {
					description: subagent ? "search/list: default all" : "set: default workspace; search/list: default all",
				}),
			),
			// A subagent only reads: the set-only fields would only cost context.
			...(subagent
				? {}
				: {
						title: Type.Optional(
							Type.String({
								description: "set: one-line rule, not a pointer; recall may cut the body",
							}),
						),
						body: Type.Optional(
							Type.String({
								description: "set: keep short; may be injected into every session",
							}),
						),
						kind: Type.Optional(
							StringEnum(MEMORY_KINDS, {
								description: "set: default fact; reference: URL, dashboard or ticket",
							}),
						),
						pinned: Type.Optional(
							Type.Boolean({
								description: "set: always inject this memory (keep pinned ones few and short)",
							}),
						),
					}),
			limit: Type.Optional(Type.Integer({ description: "1–50 (default 10)" })),
			cursor: Type.Optional(Type.String({ description: "Continue a search or list" })),
		}),
		display(input) {
			const head = { title: "Memory", summary: callSummary(input.args), kind: "search" as const, blocks: [] };
			return textResultDisplay(head, input);
		},
		renderCall(args, theme, context) {
			return toolHeader(theme, context, "Memory", callSummary(args));
		},
		renderResult(result, _options, theme, context) {
			const [head = "", ...rest] = contentText(result.content).split("\n");
			return resultBlock(theme, context, { summary: head, body: rest.join("\n").trim(), ...timingOf(result.details) });
		},
		async execute(toolCallId, input, signal, _onUpdate, ctx) {
			// The subagent schema omits the set-only fields; set is refused there before they are read.
			const params = input as MemoryParams;
			signal?.throwIfAborted();
			const store = storeFor(ctx);
			switch (params.op) {
				case "set":
				case "delete": {
					if (subagent) throw new Error("Memory is read-only in a subagent: report it to your coordinator instead.");
					const note = parseNoteId(params.id);
					const { op } = params;
					if (params.id !== undefined && note !== undefined) {
						if (op === "delete") return writeNoteOp(() => deleteNote(ctx, options.appendEntry, note));
						if (params.scope === undefined || params.scope === "session")
							return writeNoteOp(() => saveNote({ ctx, append: options.appendEntry, id: note, params }));
						if (params.scope === "all") throw new Error("set scope is session, workspace, project or global.");
						// Promotion: the write path saves the durable memory (duplicate, secret and approval checks), then the note goes.
						return writeNoteOp(async () => {
							const saved = noteForPromotion(ctx, note);
							const durable = await write({
								toolCallId,
								id: undefined,
								params: {
									...durableParams(params),
									op: "set",
									title: params.title ?? saved.title,
									body: params.body ?? saved.body,
									kind: params.kind ?? saved.kind,
								},
								store,
								permission: options.permission,
								ctx,
								signal,
							});
							deleteNote(ctx, options.appendEntry, note);
							return textResult<MemoryDetails>(
								`${durable.content[0]?.text ?? ""}\nPromoted from ${noteLabel(note)}: that session note is removed.`,
								{
									ids: durable.details?.ids ?? [],
									...(durable.details?.updated ? { updated: durable.details.updated } : {}),
								},
							);
						});
					}
					if (params.scope === "session") {
						if (params.id !== undefined)
							throw new Error(`"${params.id}" is a memory: a memory cannot move into the session scope.`);
						return writeNoteOp(() => saveNote({ ctx, append: options.appendEntry, id: undefined, params }));
					}
					const id = params.id === undefined ? undefined : parseMemoryId(params.id);
					if (params.id !== undefined && id === undefined)
						throw new Error(`"${params.id}" is not a memory id (M<n> or S<n>).`);
					return write({
						toolCallId,
						id,
						params: { ...durableParams(params), op },
						store,
						permission: options.permission,
						ctx,
						signal,
					});
				}
				case "get": {
					if (!params.id) throw new Error("get needs id.");
					const note = parseNoteId(params.id);
					if (note !== undefined) return getNote(ctx, note);
					return textResult<MemoryDetails>(await getMemory(store, params.id), { mode: "get", hits: 1 });
				}
				case "search":
				case "list": {
					if (params.op === "search" && !params.query?.trim() && !params.keywords?.trim())
						throw new Error("Memory search needs query or keywords.");
					// An invalid regular expression names the fix before any row is read.
					if (params.query?.trim()) compileQuery(params.query.trim());
					const { op } = params;
					if (params.scope === "session") {
						const notes = readNotes(ctx, params);
						return textResult<MemoryDetails>(notes.text, { mode: op, hits: notes.hits });
					}
					// With scope all (the default) the session's notes come first on the first page.
					const notes = (params.scope ?? "all") === "all" && !params.cursor ? readNotes(ctx, params) : undefined;
					const read = await readMemories(store, { ...params, scope: params.scope ?? "all", op }, signal);
					const more = read.cursor
						? `\n\nMore memories remain. Continue with cursor ${read.cursor} and the same query, keywords and scope.`
						: "";
					return textResult<MemoryDetails>(`${notes && notes.hits > 0 ? `${notes.text}\n\n` : ""}${read.text}${more}`, {
						mode: op,
						hits: read.hits + (notes?.hits ?? 0),
						...(read.cursor ? { nextCursor: read.cursor } : {}),
					});
				}
				default: {
					// Unreachable by type, but the op is model input at runtime.
					const unknown: never = params.op;
					throw new Error(`Unknown op ${JSON.stringify(unknown)}.`);
				}
			}
		},
	});
}
