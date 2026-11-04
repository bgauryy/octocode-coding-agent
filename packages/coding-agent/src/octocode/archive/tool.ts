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
import { createHistoryTool } from "./history-tool.ts";
import { getRecord, readRecords } from "./reads.ts";

type MemoryTool = ReturnType<typeof createMemoryActions>;

/** One public tool. Memory keeps its permission checks; history keeps its legacy call shape. */
export function registerArchiveTool(api: ExtensionAPI, memory?: MemoryTool): void {
	const history = createHistoryTool();
	api.registerTool(
		timedTool({
			...history,
			promptSnippet: renderInstruction("tools/archive/snippet.md"),
			description:
				"Search workspace memories, complete compaction summaries, session history and agent lifecycle events. " +
				"Use op and source for records, or the existing query/keywords/file form for history. " +
				"Only source memories accepts set/delete; plan mode may only read. Global or pinned changes retain approval checks.",
			promptGuidelines: memory?.promptGuidelines,
			parameters: Type.Object({
				...history.parameters.properties,
				...memory?.parameters.properties,
				op: Type.Optional(
					memory?.parameters.properties.op ?? StringEnum(["list", "search", "get", "set", "delete"] as const),
				),
				source: Type.Optional(
					StringEnum(["all", "sessions", "compactions", "memories", "agents", "events"] as const, {
						description: "Record collection; set/delete require memories",
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
					Type.String({ description: "Search topic words; with set, the memory's retrieval keywords" }),
				),
				agentId: Type.Optional(Type.String({ description: "Events: existing agent name" })),
				sessionId: Type.Optional(Type.String({ description: "Events: exact session id" })),
				eventType: Type.Optional(StringEnum(agentEvents.EVENT_TYPES, { description: "Events: lifecycle transition" })),
				until: Type.Optional(Type.String({ description: "Events: inclusive ISO timestamp" })),
				limit: Type.Optional(Type.Integer({ description: "Records per source per page, 1–50 (default 10)" })),
				cursor: Type.Optional(Type.String({ description: "Continue the same record search with its returned cursor" })),
			}),
			renderCall(args, theme, context) {
				if (!args.op && !args.source) return history.renderCall!(args, theme, context);
				const detail =
					args.id ??
					("title" in args && typeof args.title === "string" ? args.title : undefined) ??
					args.keywords ??
					args.query ??
					"";
				return toolHeader(
					theme,
					context,
					"Archive",
					[args.op ?? "list", args.source ?? "all", clip(detail, 100)].filter(Boolean).join(" "),
				);
			},
			async execute(callId, input, signal, onUpdate, ctx) {
				signal?.throwIfAborted();

				// Recorded calls that carry the former `goal` field still replay: it is ignored.
				if (!input.reason?.trim()) throw new Error("archive needs reason (why history is needed, not the code).");
				if (!archiveRead(input) && !archiveMutation(input)) throw new Error("Unknown archive operation.");
				if (archiveMutation(input)) {
					if (input.source !== "memories") throw new Error("Only source memories supports set and delete.");
					if (!memory) throw new Error("Memory operations are unavailable in this tool loadout.");
					return memory.execute(callId, input as Parameters<MemoryTool["execute"]>[1], signal, onUpdate, ctx);
				}
				if (input.op === undefined && input.source === undefined) {
					return history.execute(callId, input, signal, onUpdate, ctx);
				}
				const op = input.op ?? (input.id ? "get" : input.query || input.keywords ? "search" : "list");
				for (const [key, time] of [
					["since", input.since],
					["until", input.until],
				] as const)
					if (time && !Number.isFinite(Date.parse(time))) throw new Error(`${key} must be an ISO date or time.`);
				if (op === "search" && input.source === "memories" && !input.query?.trim() && !input.keywords?.trim())
					throw new Error("Memory search needs query or keywords.");
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

				const source = input.source ?? "all";
				const pieces: string[] = [...coverage];
				let nextCursor: string | undefined;
				let hits = 0;
				if (!input.file && !input.errors) {
					const result = await readRecords(ctx.cwd, { ...input, source, op }, signal, memory?.storeFor(ctx));
					pieces.push(result.text);
					nextCursor = result.cursor;
					hits += result.hits;
				}
				if (
					source === "all" ||
					source === "sessions" ||
					input.file ||
					input.errors ||
					(source === "compactions" && (input.query || input.keywords))
				) {
					try {
						const result = await history.execute(callId, input, signal, onUpdate, ctx);
						pieces.push(contentText(result.content));
					} catch (error) {
						signal?.throwIfAborted();
						if (source === "sessions" || input.file || input.errors) throw error;
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
					hits,
					nextCursor,
					reason: input.reason,
				});
			},
		}),
	);
}
