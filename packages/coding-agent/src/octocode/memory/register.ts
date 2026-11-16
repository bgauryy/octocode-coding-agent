import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import type { Permission } from "../permission/ask.ts";
import { notify, type Subcommands } from "../shared/commands.ts";
import { envFlag, MEMORY_AUTO_ENV } from "@octocodeai/octocode-common/env";
import { registerMemoryCommand } from "./command.ts";
import { type Injection, MEMORY_MESSAGE_TYPE, selectInjection, sessionInjections, unchangedIds } from "./inject.ts";
import { memoryLabel } from "./query.ts";
import { noteOnlyInjection, sessionNoteLead } from "./session-notes-inject.ts";
import { sessionNotes } from "./session-notes.ts";
import { memoryStore } from "./store.ts";
import { createMemoryTool } from "./tool.ts";

/** BM25 hits injected per prompt beside the pinned memories: fewer in a subagent, whose task is narrow. */
const TOP_K = 5;
const SUBAGENT_TOP_K = 3;
/** The one kind of pinned memory a subagent is given. */
const SUBAGENT_PINNED_KIND = "preference";

/**
 * What recall searches by: a user's prompt, or a subagent's goal (its brief opens with shared context, so its first words
 * say little about the task). A run a custom message started (an agent's result, a bash job's notice, the resume after a
 * compaction, a digest, a timer) searches nothing: its text is machine-written, so it gets the unseen pinned memories
 * only, and the next prompt recalls by what the user asked.
 */
function agentStartQuery(event: BeforeAgentStartEvent, goal: string | undefined): string {
	if (event.messageType === "custom") return "";
	return goal ?? event.prompt;
}

/**
 * Durable memories: the `memory` tool, automatic injection of pinned and relevant memories before each prompt (hidden
 * from the transcript; a subagent's pins are its pinned preferences), and `/memory`. A session only starts in a trusted folder, so project memories are always
 * eligible. The user sees which memories were recalled; the notice does not reach the model. `goal` is a subagent's
 * goal (`OCTOCODE_AGENT_GOAL`), its recall query.
 */
export function registerMemory(
	api: ExtensionAPI,
	options: {
		commands: Subcommands;
		isSubagent: boolean;
		permission: Permission;
		env?: NodeJS.ProcessEnv;
		goal?: string | undefined;
	},
) {
	const env = options.env ?? process.env;
	const storeFor = (ctx: Pick<ExtensionContext, "cwd">) => memoryStore(ctx.cwd, env);
	const autoEnv = () => envFlag(env, MEMORY_AUTO_ENV, true);
	const goal = options.isSubagent ? options.goal?.trim() || undefined : undefined;
	let failedSession: string | undefined;

	/** Memories' recall, with the session's notes the model cannot see in front; either alone makes a message. */
	const hiddenMessage = (injection: Injection | undefined) =>
		injection && {
			message: {
				customType: MEMORY_MESSAGE_TYPE,
				content: injection.content,
				display: false,
				// Counted as used once the message is committed (`message_end`), not when it is offered: a prompt that never runs
				// does not use its memories.
				details: {
					ids: injection.ids,
					updated: injection.updated,
					...(injection.sessionNotes ? { sessionNotes: injection.sessionNotes } : {}),
				},
			},
		};

	/**
	 * What to send before a request: the session notes the model cannot see, then (with recall on) pinned and relevant memories
	 * for `query`. A broken store never blocks a request; notify once until retrieval recovers.
	 */
	const injectionFor = (ctx: ExtensionContext, query: string) => {
		// Session notes belong to the session, not to the memory store or its automatic recall: a note the model cannot see
		// is sent whatever those settings say, and a broken store does not hide it.
		const contextWindow = ctx.model?.contextWindow;
		const lead = sessionNoteLead(sessionNotes(ctx.sessionManager), contextWindow);
		const lone = () =>
			lead.lines.length > 0
				? hiddenMessage(noteOnlyInjection(lead, sessionInjections(ctx.sessionManager).headerInContext))
				: undefined;
		try {
			if (!autoEnv()) return lone();
			const store = storeFor(ctx);
			if (!store.autoSetting()) return lone();
			const earlier = sessionInjections(ctx.sessionManager);
			const injection = selectInjection(store, {
				query,
				scope: "all",
				seen: unchangedIds(store, earlier.injected),
				headerInContext: earlier.headerInContext,
				topK: options.isSubagent ? SUBAGENT_TOP_K : TOP_K,
				...(contextWindow ? { contextWindow } : {}),
				// Owner decision, 2026-11-11: a subagent gets pinned memories of kind `preference` only, within the same
				// pinned budget; pinned facts, decisions and other kinds stay out, and it reads those with the `memory` tool.
				...(options.isSubagent ? { pinnedKind: SUBAGENT_PINNED_KIND } : {}),
				...(lead.lines.length > 0 ? { lead } : {}),
			});
			failedSession = undefined;
			return hiddenMessage(injection);
		} catch {
			const session = ctx.sessionManager.getSessionId();
			if (failedSession !== session) {
				failedSession = session;
				if (autoEnv())
					notify(
						ctx.ui,
						"Memory injection failed; saved memories were not loaded. Use /memory to inspect the error.",
						"warning",
					);
			}
			return lone();
		}
	};

	api.on("before_agent_start", async (event, ctx) => injectionFor(ctx, agentStartQuery(event, goal)));

	// An overflow compaction retries the turn with `continue()`, which sends no `before_agent_start`: the notes and pinned
	// memories the summary replaced would stay out of the retry's request. They are sent again here, before it, only
	// when the compaction left them out of context (`seen` and the notes' context check already say so, so the retry adds
	// no bytes when a kept message still shows them).
	api.on("session_compact", async (event, ctx) => {
		if (!event.willRetry) return;
		const injection = injectionFor(ctx, "");
		if (!injection) return;
		try {
			void api.sendMessage(injection.message, { triggerTurn: false, deliverAs: "followUp" });
		} catch {
			// The session was replaced.
		}
	});

	api.on("message_end", async (event, ctx) => {
		const { message } = event;
		if (message.role !== "custom" || message.customType !== MEMORY_MESSAGE_TYPE) return;
		const ids = (message.details as { ids?: unknown } | undefined)?.ids;
		if (!Array.isArray(ids)) return;
		const used = ids.filter((id): id is number => typeof id === "number");
		if (ctx.hasUI && !options.isSubagent && used.length > 0)
			notify(ctx.ui, `Recalled ${used.map(memoryLabel).join(", ")} (/memory last shows them)`, "info");
		try {
			// Through the database writer: another process holding the write lock never stalls this thread.
			await storeFor(ctx).markUsed(used);
		} catch {
			// A missing agent DB or a busy writer never blocks a turn; only the usage mark is lost.
		}
	});

	if (!options.isSubagent) registerMemoryCommand(options.commands, { store: storeFor, autoEnv });
	api.registerTool(
		createMemoryTool(storeFor, {
			isSubagent: options.isSubagent,
			permission: options.permission,
			appendEntry: (type, data) => api.appendEntry(type, data),
		}),
	);
}
