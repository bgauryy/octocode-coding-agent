import { renderInstruction } from "../../core/prompt-template.ts";
import { toolHeader } from "../shared/render.ts";
import { clip } from "../shared/render/text.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { timedTool } from "../shared/render/rows.ts";
import { Type } from "typebox";
import { StringEnum } from "@octocodeai/octocode-ai";
import type { ExtensionAPI } from "../../core/features/index.ts";
import type { createMemoryActions } from "../memory/tool.ts";
import { archiveMutation, archiveRead } from "../shared/archive-operation.ts";
import { contentText, textResult } from "../shared/util.ts";
import { sharedAgentDb } from "../../config/database.ts";
import { agentEvents } from "../../../../db/src/api.ts";
import { historyScope, PAGE_CHARS } from "../shared/history.ts";
import { HistoryRepair } from "./repair.ts";
import { createHistoryTool, pattern } from "./history-tool.ts";
import { getRecord, readRecords } from "./reads.ts";

type MemoryTool = ReturnType<typeof createMemoryActions>;

/**
 * A call in the one op-based shape. `op` was optional, and a call with neither op nor source searched only session
 * history; such calls recorded by a resumed session still validate: the op they meant is filled in (get for an id or a
 * file read alone, search for query, keywords or errors, else list) and, without a source, source sessions.
 */
function opShape<T>(args: T): T {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	const input = args as Record<string, unknown>;
	if (input.op !== undefined) return args;
	const search = Boolean(input.query || input.keywords || input.errors);
	const op = input.id || (input.file && !search) ? "get" : search ? "search" : "list";
	return { ...input, op, ...(input.source === undefined ? { source: "sessions" } : {}) } as T;
}

/** One public tool. Memory keeps its permission checks; session history is the `sessions` source. */
export function registerArchiveTool(api: ExtensionAPI, memory?: MemoryTool): void {
	const history = createHistoryTool();
	// The memory capability's `op` owns which operations this session has: a subagent's lists no set or delete.
	const writable =
		(memory?.parameters.properties.op as { enum?: string[] } | undefined)?.enum?.includes("set") === true;
	api.registerTool(
		timedTool({
			...history,
			promptSnippet: renderInstruction("tools/archive/snippet.md"),
			description:
				"Search workspace memories, complete compaction summaries, session history and agent lifecycle events by op and source. " +
				// One description for every role (it leads the cached tool list); `op` and the field texts say what this one may do.
				"set and delete, where op lists them, need source memories; plan mode only reads; global or pinned changes ask for approval.",
			promptGuidelines: memory?.promptGuidelines,
			parameters: Type.Object({
				...history.parameters.properties,
				...memory?.parameters.properties,
				op:
					memory?.parameters.properties.op ??
					StringEnum(["list", "search", "get"] as const, {
						description: "search: topic keywords or regex query; get: full record by id; list: newest",
					}),
				source: Type.Optional(
					StringEnum(["all", "sessions", "compactions", "memories", "agents", "events"] as const, {
						description: "Record collection (default all)",
					}),
				),
				id: Type.Optional(
					Type.String({ description: "Record reference returned by list/search; memories keep M<n> ids" }),
				),
				query: Type.Optional(
					Type.String({
						description:
							"Case-insensitive regex; keywords provides ranked topic search. With errors: filters by tool name or error text",
					}),
				),
				keywords: Type.Optional(
					Type.String({
						description: writable
							? "Search topic words; with set, the memory's retrieval keywords"
							: "Search topic words",
					}),
				),
				agentId: Type.Optional(Type.String({ description: "Events: existing agent name" })),
				sessionId: Type.Optional(Type.String({ description: "Events: exact session id" })),
				eventType: Type.Optional(StringEnum(agentEvents.EVENT_TYPES, { description: "Events: lifecycle transition" })),
				until: Type.Optional(Type.String({ description: "Events: inclusive ISO timestamp" })),
				limit: Type.Optional(Type.Integer({ description: "Records per source per page, 1–50 (default 10)" })),
				cursor: Type.Optional(Type.String({ description: "Continue the same record search with its returned cursor" })),
			}),
			// Validation runs on the result, so the declared type is checked there, not here.
			prepareArguments: (args) => opShape(args) as never,
			renderCall(raw, theme, context) {
				const args = opShape(raw);
				const detail =
					args.id ??
					("title" in args && typeof args.title === "string" ? args.title : undefined) ??
					args.keywords ??
					args.query ??
					(args.file ? `${args.file}${args.line ? `:${args.line}` : ""}` : args.errors ? "errors" : "");
				return toolHeader(
					theme,
					context,
					"Archive",
					[args.op ?? "list", args.source ?? "all", clip(detail, 100)].filter(Boolean).join(" "),
				);
			},
			async execute(callId, given, signal, onUpdate, ctx) {
				signal?.throwIfAborted();
				// SDK callers reach execute without prepareArguments.
				const input = opShape(given);

				// Recorded calls that carry the former `goal` field still replay: it is ignored.
				if (!input.reason?.trim()) throw new Error("archive needs reason (why history is needed, not the code).");
				if (!archiveRead(input) && !archiveMutation(input)) throw new Error("Unknown archive operation.");
				if (archiveMutation(input)) {
					if (input.source !== "memories") throw new Error("Only source memories supports set and delete.");
					if (!memory) throw new Error("Memory operations are unavailable in this tool loadout.");
					return memory.execute(callId, input as Parameters<MemoryTool["execute"]>[1], signal, onUpdate, ctx);
				}
				const op = input.op ?? "list";
				for (const [key, time] of [
					["since", input.since],
					["until", input.until],
				] as const)
					if (time && !Number.isFinite(Date.parse(time))) throw new Error(`${key} must be an ISO date or time.`);
				if (op === "search" && input.source === "memories" && !input.query?.trim() && !input.keywords?.trim())
					throw new Error("Memory search needs query or keywords.");
				// Every source reads query as a regular expression: an invalid one names the fix before any search runs.
				if (input.query?.trim()) pattern(input.query.trim());
				const coverage: string[] = [];
				const needsHistory = input.id
					? /^(compaction|session):/.test(input.id)
					: !input.source || ["all", "sessions", "compactions"].includes(input.source);
				if (needsHistory && ctx.sessionManager.getSessionFile()) {
					const repair = new HistoryRepair(sharedAgentDb(), process.env, signal);
					const repairs = [
						() => repair.transcript(ctx.sessionManager.getSessionFile()!),
						...historyScope(ctx.cwd).map((session) => () => repair.archive(session.folder)),
					];
					for (const run of repairs) {
						signal?.throwIfAborted();
						try {
							await run();
						} catch (error) {
							signal?.throwIfAborted();
							coverage.push(`Historical recovery incomplete: ${errorMessage(error)}`);
						}
					}
				}
				if (op === "get" && input.id) {
					const text = getRecord(ctx.cwd, input.id, memory?.storeFor(ctx));
					const page = Math.max(1, input.page ?? 1);
					const size = PAGE_CHARS;
					return textResult(text.slice((page - 1) * size, page * size), {
						mode: "read",
						page,
						pages: Math.ceil(text.length / size),
						id: input.id,
						coverage,
					});
				}
				if (op === "get" && !input.id && !input.file) throw new Error("get requires a record id or file.");
				// A file read or an error scan is session history only: its result, with any recovery gap ahead of it.
				if (input.file || input.errors) {
					const result = await history.execute(callId, input, signal, onUpdate, ctx);
					if (!coverage.length) return result;
					return {
						...result,
						content: [{ type: "text", text: [...coverage, contentText(result.content)].join("\n\n") }],
					};
				}

				const source = input.source ?? "all";
				const pieces: string[] = [...coverage];
				let historyDetails: unknown;
				const records = await readRecords(ctx.cwd, { ...input, source, op }, signal, memory?.storeFor(ctx));
				pieces.push(records.text);
				const nextCursor = records.cursor;
				const hits = records.hits;
				if (
					source === "all" ||
					source === "sessions" ||
					(source === "compactions" && (input.query || input.keywords))
				) {
					try {
						const result = await history.execute(callId, input, signal, onUpdate, ctx);
						pieces.push(contentText(result.content));
						historyDetails = result.details;
					} catch (error) {
						signal?.throwIfAborted();
						if (source === "sessions") throw error;
						pieces.push(
							`Detailed-history search incomplete: ${errorMessage(error)}. Retained-record results above remain available.`,
						);
					}
				}
				if (nextCursor)
					pieces.push(
						`More records remain. Continue with cursor ${nextCursor} and the same source/query/keywords. Keyword results are ranked within each scanned page.`,
					);
				return textResult(pieces.filter(Boolean).join("\n\n"), {
					mode: op,
					// The session-history part: its mode (list, search, rank), pages and hits.
					...(historyDetails ? { history: historyDetails } : {}),
					hits,
					nextCursor,
					reason: input.reason,
				});
			},
		}),
	);
}
