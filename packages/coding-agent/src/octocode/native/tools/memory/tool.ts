import { StringEnum } from "@octocodeai/octocode-ai";
import { type TObject, type TSchema, Type } from "typebox";
import type { FeatureContext } from "../../../../core/features/index.ts";
import { renderPrompt } from "../../../../core/prompt-template.ts";
import type { Permission } from "../../../permission/ask.ts";
import { textResultDisplay } from "../../../render/display.ts";
import { timedTool, timingOf } from "../../../render/rows.ts";
import { resultBlock, toolHeader } from "../../../render/tool.ts";
import { exclusive } from "../../../shared/locks.ts";
import { clip } from "../../../shared/text.ts";
import { contentText, textResult } from "../../../shared/util.ts";
import { batchEntries } from "../../../shared/batch.ts";
import { withReason } from "../../../shared/reason.ts";
import { MEMORY_TOOL_NAME } from "../../../memory/inject.ts";
import { parseMemoryId } from "../../../memory/query.ts";
import { compileQuery } from "../../../memory/safe-pattern.ts";
import { noteLabel, parseNoteId } from "../../../memory/session-notes.ts";
import {
	type AppendEntry,
	deleteNote,
	getNote,
	noteForPromotion,
	readNotes,
	saveNote,
} from "../../../memory/session-notes-tool.ts";
import type { MemoryFileSync } from "../../../memory/file/sync.ts";
import { getMemory, readMemories } from "../../../memory/reads.ts";
import { MEMORY_KINDS, type MemoryStore } from "../../../memory/store.ts";
import { type MemoryWriteParams, writeMemory } from "../../../memory/write.ts";

/** Every field the full (non-subagent) schema accepts. */
type MemoryParams = Omit<MemoryWriteParams, "op" | "scope"> & {
	scope?: "session" | "workspace" | "project" | "global" | "all";
	op: "search" | "get" | "list" | "set" | "delete";
	id?: string;
	query?: string;
	limit?: number;
	cursor?: string;
	/** set/delete: several entries of the single-call fields, each written as its own call. */
	items?: Array<Omit<MemoryParams, "op" | "items">>;
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

/** `parameters` declaring `items`: entries of the other fields, shown short (`entryChecked` types them). */
function withItems<T extends TObject>(parameters: T): T {
	const items = {
		type: "array",
		items: { type: "object" },
		description: "set/delete: batch entries",
	};
	return { ...parameters, properties: { ...parameters.properties, items } };
}

/** `parameters` with each `items` entry typed as a single set or delete: id, scope and the set fields, nothing else. */
function entryChecked(parameters: TObject): TSchema {
	const {
		op: _op,
		query: _query,
		keywords: _keywords,
		limit: _limit,
		cursor: _cursor,
		...single
	} = parameters.properties;
	return Type.Object({
		...parameters.properties,
		items: Type.Optional(Type.Array(Type.Object(single, { additionalProperties: false }), { minItems: 1 })),
	});
}

/** `op`, then what the call names: an id, a title, keywords or a query. */
function callSummary(args: Record<string, unknown> | undefined): string {
	const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
	const detail = text(args?.id) ?? text(args?.title) ?? text(args?.keywords) ?? text(args?.query) ?? "";
	return [text(args?.op) ?? "list", clip(detail, 100)].filter(Boolean).join(" ");
}

/** The ids a batch of delete replies names (`Deleted M3 (…) …`), in order. */
const deletedIds = (replies: string[]) => replies.map((text) => /^Deleted (\S+)/.exec(text)?.[1] ?? "?").join(", ");

/**
 * The `memory` tool: durable notes of this workspace (`store.ts`). The main session searches, reads, saves and deletes;
 * a subagent only reads, so its schema leaves out `set`, `delete` and the fields only a save takes. Reads run side by
 * side; writes run one at a time.
 */
export function createMemoryTool(
	storeFor: (ctx: FeatureContext) => MemoryStore,
	options: { isSubagent: boolean; permission: Permission; appendEntry?: AppendEntry; files?: MemoryFileSync },
) {
	const subagent = options.isSubagent;
	const ops = subagent ? (["search", "get", "list"] as const) : (["search", "get", "list", "set", "delete"] as const);
	const write = exclusive(writeMemory);
	// Session-note writes share the memory writes' queue: an id is chosen from the notes the previous write appended.
	const queued = exclusive(async (run: () => unknown) => run());
	const writeNoteOp = <R>(run: () => R) => queued(run) as Promise<Awaited<R>>;
	const parameters = Type.Object({
		// A subagent's `op` enum (search, get, list) needs no description.
		op: StringEnum(ops, subagent ? {} : { description: "set: add (needs title) or update id" }),
		id: Type.Optional(
			Type.String({
				description: subagent
					? "M<n>, or S<n> for a session note"
					: "M<n>, or session note S<n> (set with a durable scope moves it)",
			}),
		),
		query: Type.Optional(
			Type.String({
				description: "search: case-insensitive regex (≤200 chars; no nested repeats like (a+)+, backreferences)",
			}),
		),
		keywords: Type.Optional(
			Type.String({
				description: subagent ? "search: topic words, ranked" : "search: topic words, ranked; set: retrieval terms",
			}),
		),
		scope: Type.Optional(
			StringEnum(SCOPES, {
				description: subagent ? "search/list: default all" : "set: default workspace; search/list: all",
			}),
		),
		// A subagent only reads: the set-only fields would only cost context.
		...(subagent
			? {}
			: {
					title: Type.Optional(
						Type.String({
							description: "set: one-line rule and why (its MEMORY.md line); recall may cut body",
						}),
					),
					body: Type.Optional(
						Type.String({
							description: "set: short; may be injected every session",
						}),
					),
					kind: Type.Optional(
						StringEnum(MEMORY_KINDS, {
							description: "set: default fact; reference: URL, dashboard, ticket",
						}),
					),
					pinned: Type.Optional(
						Type.Boolean({
							description: "set: always inject (keep pins few, short)",
						}),
					),
					sources: Type.Optional(
						Type.Array(Type.String(), {
							description: "set: ≤8 anchors",
						}),
					),
				}),
		limit: Type.Optional(Type.Integer({ description: "1–50 (default 10)" })),
		cursor: Type.Optional(Type.String({ description: "search/list: next page" })),
	});
	return timedTool({
		name: MEMORY_TOOL_NAME,
		roleVariant: true,
		label: "Memory",
		promptSnippet: renderPrompt("tools/memory/snippet.md"),
		// One description for every role (it leads the cached tool list); `op` and the field texts say what this one may do.
		description:
			"Short notes: session (this session only, survives compaction) or workspace/project/global for later sessions; list shows pinned first. A near-duplicate in scope is refused: update it. Global or pinned changes ask the user first.",
		promptGuidelines: renderPrompt("tools/memory/guidelines.md", { subagent }).split("\n"),
		// The main session's `items` batches set or delete; each entry is held to the single call's write fields.
		parameters: subagent ? parameters : withItems(parameters),
		...(subagent ? {} : { validationParameters: withReason(entryChecked(parameters)) }),
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
					const op = params.op;
					const { items, op: _op, ...shared } = params;
					if (items === undefined) return writeOne({ ...params, op }, toolCallId, store, ctx, signal);
					if (Object.values(shared).some((value) => value !== undefined))
						throw new Error("items carries each entry's fields: move the others into the entries.");
					return batchEntries(
						items,
						(entry, index) => entry.id ?? (entry.title ? `"${clip(entry.title, 60)}"` : `items[${index}]`),
						(entry) => writeOne({ ...entry, op }, toolCallId, store, ctx, signal),
						{
							operation: op,
							verb: op === "set" ? "Saved" : "Deleted",
							signal,
							// A deleted note's body is gone from the reply: the count and ids settle a batch of deletes.
							...(op === "delete" ? { condense: deletedIds } : {}),
						},
					);
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

	/** One set or delete: a session note, a promotion to a durable scope, or a durable memory write. */
	function writeOne(
		params: MemoryParams & { op: "set" | "delete" },
		toolCallId: string,
		store: MemoryStore,
		ctx: FeatureContext,
		signal: AbortSignal | undefined,
	) {
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
					files: options.files,
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
			files: options.files,
		});
	}
}
