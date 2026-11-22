import { textResultDisplay } from "../../../render/display.ts";
import { renderPrompt } from "../../../../core/prompt-template.ts";
import { toolHeader } from "../../../render/tool.ts";
import { clip } from "../../../shared/text.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { timedTool } from "../../../render/rows.ts";
import { Type } from "typebox";
import { StringEnum } from "@octocodeai/octocode-ai";
import type { FeatureSetup } from "../../../../core/features/index.ts";
import { archiveRead, formerMemoryOp } from "../../../shared/archive-operation.ts";
import { contentText, textResult } from "../../../shared/util.ts";
import { sharedAgentDb } from "../../../../storage/database.ts";
import { agentEvents } from "../../../../../../db/src/api.ts";
import { historySessions, PAGE_CHARS } from "../../../history/transcripts.ts";
import { HistoryRepair } from "../../../archive/repair.ts";
import { repairBeforeRead } from "../../../archive/repair-stamps.ts";
import { continueLine, nextArchiveCursor, nextPage, readArchiveCursor } from "../../../archive/cursor.ts";
import { createHistoryTool, pattern } from "./history.ts";
import { scheduleArchiveIndexSync } from "../../../history/index/startup.ts";
import { getRecord, MAX_RECORDS, OVERVIEW_RECORDS, readRecords } from "../../../archive/reads.ts";
import { readProfile } from "../../../archive/profile-read.ts";
import { sessionMirrorSettled } from "../../../../core/session-manager/mirror.ts";

/** Longest a history read waits for this session's mirror writes before it reads what the database has. */
const MIRROR_WAIT_MS = 2_000;

/** What a call recorded before `memory` became its own tool carries after `opShape`: the memory op it meant. */
const FORMER = "formerMemoryOp";

/**
 * A call in the one op-based shape. `op` was optional, and a call with neither op nor source searched only session
 * history; such calls recorded by a resumed session still validate: the op they meant is filled in (get for an id or a
 * file read alone, search for query, keywords or errors, else list) and, without a source, source sessions.
 *
 * Memories were read and written here until `memory` became its own tool. A call that names them (`op` set or delete,
 * `source` memories, an `M<n>` id) keeps its fields for the row that shows it, validates as a list, and carries the op
 * it meant in `formerMemoryOp`: `execute` refuses it and names the `memory` call to make.
 */
function opShape<T>(args: T): T {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	const input = args as Record<string, unknown>;
	if (typeof input[FORMER] === "string") return args;
	const former = formerMemoryOp(input);
	if (former) return { ...input, op: "list", source: "sessions", [FORMER]: former } as T;
	if (input.op !== undefined) return args;
	const search = Boolean(input.query || input.keywords || input.errors);
	const op = input.id || (input.file && !search) ? "get" : search ? "search" : "list";
	return { ...input, op, ...(input.source === undefined ? { source: "sessions" } : {}) } as T;
}

/** `op source detail` of a call, for its row; a recorded memory call reads `set memories <title>`. */
function callSummary(raw: unknown): string {
	const args = (opShape(raw) ?? {}) as Record<string, unknown>;
	const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
	const former = text(args[FORMER]);
	const detail =
		text(args.id) ??
		text(args.title) ??
		text(args.keywords) ??
		text(args.query) ??
		(text(args.file)
			? `${text(args.file)}${typeof args.line === "number" || typeof args.line === "string" ? `:${args.line}` : ""}`
			: args.errors
				? "errors"
				: "");
	const head = former ? [former, "memories"] : [text(args.op) ?? "list", text(args.source) ?? "all"];
	return [...head, clip(detail, 100)].filter(Boolean).join(" ");
}

/** A call of the session-history part, with the page and scan position the archive cursor names. */
const historyCall = (args: object): Parameters<ReturnType<typeof createHistoryTool>["execute"]>[1] =>
	args as Parameters<ReturnType<typeof createHistoryTool>["execute"]>[1];

/** The diagnostic sources; lifecycle events remain coordinator-only. */
const DIAGNOSTIC_SOURCES = ["events", "profile"] as const;

/**
 * Session history, compaction summaries and diagnostics. Memories have their own tool (`native/tools/memory/tool.ts`). A subagent
 * reads history, summaries and its request profile; events and errors remain coordinator-only.
 */
export function registerArchiveTool(api: FeatureSetup, options: { isSubagent?: boolean } = {}): void {
	const subagent = options.isSubagent === true;
	// One background index sync per main session; subagents of the same workspace share that index.
	if (!subagent) api.bus.on("session_start", (_event, ctx) => scheduleArchiveIndexSync(ctx.cwd));
	const history = createHistoryTool();
	const { errors: _errors, line: _line, since: _since, ...shared } = history.parameters.properties;
	const fields = {
		op: StringEnum(["list", "search", "get"] as const, {
			description: "get: full record by id; list: newest",
		}),
		id: Type.Optional(Type.String({ description: "Reference from list/search" })),
		keywords: Type.Optional(Type.String({ description: "Rank by topic" })),
		limit: Type.Optional(Type.Integer({ description: "Records/source: 1–50, default 10" })),
		cursor: Type.Optional(Type.String({ description: "Returned cursor" })),
	};
	const main = Type.Object({
		...history.parameters.properties,
		...fields,
		source: Type.Optional(
			StringEnum(["all", "sessions", "compactions", "agents", ...DIAGNOSTIC_SOURCES] as const, {
				description: "Collection; default all",
			}),
		),
		query: Type.Optional(
			Type.String({
				description: "Case-insensitive regex; errors: tool name or text",
			}),
		),
		agentId: Type.Optional(Type.String({ description: "Events/profile: agent name" })),
		request: Type.Optional(Type.Integer({ description: "Profile: request index with agentId" })),
		sessionId: Type.Optional(
			Type.String({
				description: "Session id (history also: current); profile defaults to current",
			}),
		),
		eventType: Type.Optional(StringEnum(agentEvents.EVENT_TYPES, { description: "Events: transition" })),
		until: Type.Optional(Type.String({ description: "Events: through ISO time" })),
	});
	const child = Type.Object({
		...shared,
		...fields,
		line: Type.Optional(Type.Integer({ description: "Read from this line" })),
		since: Type.Optional(Type.String({ description: "Files changed since ISO time" })),
		source: Type.Optional(
			StringEnum(["all", "sessions", "compactions", "agents", "profile"] as const, {
				description: "Record collection (default all)",
			}),
		),
		query: Type.Optional(Type.String({ description: "Case-insensitive regex filter" })),
		agentId: Type.Optional(Type.String({ description: "Profile: agent name" })),
		request: main.properties.request,
	});
	api.tools.register(
		timedTool({
			...history,
			promptSnippet: renderPrompt("tools/archive/snippet.md"),
			// One description for every role (it leads the cached tool list); `source` and the field texts say what this
			// one reads.
			description: renderPrompt("tools/archive/description.md"),
			// `execute` reads the main session's fields; a subagent's schema declares fewer of them and refuses the rest.
			parameters: subagent ? (child as unknown as typeof main) : main,
			// Validation runs on the result, so the declared type is checked there, not here.
			prepareArguments: (args) => opShape(args) as never,
			display(input) {
				const head = { title: "Archive", summary: callSummary(input.args), kind: "search" as const, blocks: [] };
				return textResultDisplay(head, input);
			},
			renderCall(raw, theme, context) {
				return toolHeader(theme, context, "Archive", callSummary(raw));
			},
			async execute(callId, given, signal, onUpdate, ctx) {
				signal?.throwIfAborted();
				// SDK callers reach execute without prepareArguments.
				const input = opShape(given) as typeof given & { page?: number; request?: number };
				const former = (input as Record<string, unknown>)[FORMER];
				if (typeof former === "string")
					throw new Error(`archive no longer reads or writes memories: call the memory tool with op "${former}".`);

				// Every argument is checked before any read or repair, so a malformed call fails at once with its fix.
				// Recorded calls that carry the former `goal` field still replay: it is ignored.
				if (!input.reason?.trim()) throw new Error("archive needs reason (why history is needed, not the code).");
				if (!archiveRead(input)) throw new Error("Unknown archive operation.");
				if (subagent) {
					const source = input.source === "events" || input.id?.startsWith("event:") ? "events" : undefined;
					const diagnostic = input.errors ? "errors" : source ? `source ${source}` : undefined;
					if (diagnostic)
						throw new Error(`${diagnostic} is read by the main session only: ask your coordinator for it.`);
				}
				const op = input.op ?? "list";
				for (const [key, time] of [
					["since", input.since],
					["until", input.until],
				] as const)
					if (time && !Number.isFinite(Date.parse(time))) throw new Error(`${key} must be an ISO date or time.`);
				if (op === "get" && !input.id && !input.file) throw new Error("get requires a record id or file.");
				// Every source reads query as a regular expression: an invalid one names the fix before any search runs.
				if (input.query?.trim()) pattern(input.query.trim());
				const from = readArchiveCursor(input.cursor);
				// A recorded call from before the cursor carried pages still names its page.
				const page = from.page ?? Math.max(1, Math.floor(input.page ?? 1));
				const capped =
					input.limit !== undefined && input.limit > MAX_RECORDS ? `limit is capped at ${MAX_RECORDS}.` : "";
				/** The result's text with the one line that continues it, when a part goes on. */
				const finish = (pieces: string[], next: Parameters<typeof nextArchiveCursor>[0], details: object) => {
					const nextCursor = nextArchiveCursor(next);
					return textResult([...pieces, capped, continueLine(nextCursor)].filter(Boolean).join("\n\n"), {
						...details,
						nextCursor,
						reason: input.reason,
					});
				};

				if (input.source === "profile") {
					const profile = readProfile(ctx.cwd, { ...input, page, request: input.request ?? input.line });
					const where = profile.pages > 1 ? `Page ${profile.page} of ${profile.pages}.` : "";
					return finish([profile.text, where], nextPage(profile.page, profile.pages), {
						mode: "profile",
						session: profile.session,
					});
				}
				const coverage: string[] = [];
				const needsHistory = input.id
					? /^(compaction|session):/.test(input.id)
					: !input.source || ["all", "sessions", "compactions"].includes(input.source);
				// This session's newest records reach the database after its file (`session-manager/mirror.ts`): wait for
				// their acknowledgement, bounded, so a search or an error scan reads them.
				if ((needsHistory || input.errors) && !(await sessionMirrorSettled(MIRROR_WAIT_MS)))
					coverage.push("The newest records of this session may be missing: the database is still saving them.");
				const sessionFile = ctx.sessionManager.getSessionFile();
				if (needsHistory && sessionFile) {
					// Repairs only what changed: this session's new lines and the transcripts whose stamp moved.
					const agent = sharedAgentDb();
					const scope = historySessions(ctx.cwd).map((session) => ({
						id: session.id,
						folder: session.folder,
						...(session.record?.transcript ? { transcript: session.record.transcript } : {}),
					}));
					coverage.push(
						...(await repairBeforeRead(
							agent,
							new HistoryRepair(agent, process.env, signal),
							sessionFile,
							scope,
							signal,
						)),
					);
				}
				if (op === "get" && input.id) {
					const text = getRecord(ctx.cwd, input.id);
					const pages = Math.max(1, Math.ceil(text.length / PAGE_CHARS));
					const shown = Math.min(page, pages);
					return finish(
						[
							...coverage,
							text.slice((shown - 1) * PAGE_CHARS, shown * PAGE_CHARS),
							pages > 1 ? `Page ${shown} of ${pages}.` : "",
						],
						nextPage(shown, pages),
						{ mode: "read", page: shown, pages, id: input.id, coverage },
					);
				}
				// A file read or an error scan is session history only: its result, with any recovery gap ahead of it.
				if (input.file || input.errors) {
					const result = await history.execute(
						callId,
						historyCall({ ...input, page, scan: from.scan }),
						signal,
						onUpdate,
						ctx,
					);
					const details = result.details as { page: number; pages: number; scan?: { from?: string; next?: string } };
					return finish(
						[...coverage, contentText(result.content)],
						nextPage(details.page, details.pages, details.scan),
						details,
					);
				}

				const source = input.source ?? "all";
				// A cursor continues only the parts it names: the others ended on an earlier page.
				const records =
					from.continued && !from.records
						? undefined
						: await readRecords(
								ctx.cwd,
								{ ...input, source, op, cursor: from.records, diagnostics: !subagent },
								signal,
							);
				const readsHistory =
					(source === "all" ||
						source === "sessions" ||
						(source === "compactions" && (input.query || input.keywords))) &&
					(!from.continued || from.page !== undefined);
				let historyText = "";
				let historyNext: { page?: number; scan?: string } = {};
				let historyDetails: Record<string, unknown> | undefined;
				if (readsHistory) {
					try {
						// The overview lists as many sessions as it lists records of each source.
						const limit = input.limit ?? (source === "all" ? OVERVIEW_RECORDS : undefined);
						const result = await history.execute(
							callId,
							historyCall({ ...input, limit, page, scan: from.scan }),
							signal,
							onUpdate,
							ctx,
						);
						historyText = contentText(result.content);
						const details = result.details as { page: number; pages: number; scan?: { from?: string; next?: string } };
						historyDetails = details;
						historyNext = nextPage(details.page, details.pages, details.scan);
					} catch (error) {
						signal?.throwIfAborted();
						if (source === "sessions") throw error;
						historyText = `Detailed-history search incomplete: ${errorMessage(error)}. Retained-record results above remain available.`;
					}
				}
				return finish(
					[...coverage, records?.text ?? "", historyText],
					{ ...(records?.cursor ? { records: records.cursor } : {}), ...historyNext },
					{
						mode: op,
						// The session-history part: its mode (list, search, rank), pages and hits.
						...(historyDetails ? { history: historyDetails } : {}),
						hits: records?.hits ?? 0,
					},
				);
			},
		}),
	);
}
