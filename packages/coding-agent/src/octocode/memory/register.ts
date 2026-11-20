import type { BeforeAgentStartEvent, FeatureSetup, FeatureContext } from "../../core/features/index.ts";
import type { Permission } from "../permission/ask.ts";
import { notify, type Subcommands } from "../shared/commands.ts";
import { envFlag, MEMORY_AUTO_ENV } from "@octocodeai/octocode-common/env";
import { activeItemGoal } from "./active-goal.ts";
import { registerMemoryCommand } from "./command.ts";
import { storeUnavailable } from "./errors.ts";
import type { SmallModel } from "./file/passes.ts";
import { registerMemoryReflection } from "./file/reflect.ts";
import { registerMemorySection } from "./file/section.ts";
import { memorySettings } from "./file/settings.ts";
import { fileMemberIds, type MemoryFileSync, repeatsOf } from "./file/sync.ts";
import { type Injection, MEMORY_MESSAGE_TYPE, selectInjection, sessionInjections, unchangedIds } from "./inject.ts";
import { memoryLabel } from "./query.ts";
import { noteOnlyInjection, sessionNoteLead } from "./session-notes-inject.ts";
import { sessionNotes } from "./session-notes.ts";
import { memoryStore } from "./store.ts";
import { createMemoryTool } from "../native/tools/memory/tool.ts";

/** BM25 hits injected per prompt beside the pinned memories: fewer in a subagent, whose task is narrow. */
const TOP_K = 5;
const SUBAGENT_TOP_K = 3;

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
 * Durable memories: the MEMORY.md files in the `memory` prompt section (`file/section.ts`) and the passes that keep them
 * (`file/reflect.ts`), the `memory` tool, which
 * also writes a workspace or global note's line to its file, automatic recall of pinned and relevant notes from the
 * database before each prompt (hidden from the transcript; `memory.recall` says for which sessions; a subagent's pins
 * are its pinned preferences), and `/memory`. A session only starts in a trusted folder, so project memories are always
 * eligible. The user sees which memories were recalled; the notice does not reach the model. `goal` is a subagent's
 * goal (`OCTOCODE_AGENT_GOAL`), its recall query.
 */
export function registerMemory(
	api: FeatureSetup,
	options: {
		commands: Subcommands;
		isSubagent: boolean;
		permission: Permission;
		env?: NodeJS.ProcessEnv;
		goal?: string | undefined;
		/**
		 * The `small` purpose's caller (`subagents/small-call.ts`) the reflection and consolidation passes use
		 * (`file/reflect.ts`); without it they make no model call.
		 */
		small?: SmallModel;
	},
) {
	const env = options.env ?? process.env;
	const storeFor = (ctx: Pick<FeatureContext, "cwd">) => memoryStore(ctx.cwd, env);
	const autoEnv = () => envFlag(env, MEMORY_AUTO_ENV, true);
	const goal = options.isSubagent ? options.goal?.trim() || undefined : undefined;
	const settings = () => memorySettings(api.settings.get());
	/** Recall for this session: `memory.recall` (`main` leaves subagents out) unless the environment turned it off. */
	const recallOn = () => {
		const recall = settings().recall;
		return autoEnv() && (recall === "all" || (recall === "main" && !options.isSubagent));
	};
	// The AGENTS.md files this session loaded, for the check that a new MEMORY.md line does not repeat them.
	let contextFiles: ReadonlyArray<{ path: string; content: string }> = [];
	let repeats: { files: typeof contextFiles; check: (text: string) => string | undefined } | undefined;
	const files: MemoryFileSync = {
		settings,
		repeats: () => {
			if (repeats?.files !== contextFiles) repeats = { files: contextFiles, check: repeatsOf(contextFiles) };
			return repeats.check;
		},
		env,
	};
	let failedSession: string | undefined;
	const section = registerMemorySection(api, { isSubagent: options.isSubagent, env });

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
	 * for `query`. A store that cannot serve now never blocks a request: notify once until retrieval recovers. Any other
	 * error is a defect and reaches the log.
	 */
	const injectionFor = (ctx: FeatureContext, query: string, withActiveGoal = false) => {
		// Session notes belong to the session, not to the memory store or its automatic recall: a note the model cannot see
		// is sent whatever those settings say, and a broken store does not hide it.
		const contextWindow = ctx.model?.contextWindow;
		const lead = sessionNoteLead(sessionNotes(ctx.sessionManager), contextWindow);
		const lone = () =>
			lead.lines.length > 0
				? hiddenMessage(noteOnlyInjection(lead, sessionInjections(ctx.sessionManager).headerInContext))
				: undefined;
		try {
			if (!recallOn()) return lone();
			const store = storeFor(ctx);
			const earlier = sessionInjections(ctx.sessionManager);
			// The span's first injection also searches the active item's goal: a bare "continue" prompt names nothing.
			const first = earlier.injected.size === 0 && !earlier.headerInContext;
			const itemGoal = withActiveGoal && first && query ? activeItemGoal(ctx, options) : undefined;
			const injection = selectInjection(store, {
				query: itemGoal ? `${query} ${itemGoal}` : query,
				scope: "all",
				// A note whose title is a MEMORY.md line in the prompt is already in context.
				seen: new Set([...unchangedIds(store, earlier.injected), ...fileMemberIds(store, section.lineKeys())]),
				headerInContext: earlier.headerInContext,
				topK: options.isSubagent ? SUBAGENT_TOP_K : TOP_K,
				...(contextWindow ? { contextWindow } : {}),
				// A subagent gets pinned memories of the one `memory.subagentPinnedKind` (default `preference`) within the same
				// pinned budget; other pinned kinds stay out, and it reads those with the `memory` tool.
				...(options.isSubagent ? { pinnedKind: settings().subagentPinnedKind } : {}),
				...(lead.lines.length > 0 ? { lead } : {}),
			});
			failedSession = undefined;
			return hiddenMessage(injection);
		} catch (error) {
			if (!storeUnavailable(error)) throw error;
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

	api.bus.on("before_agent_start", async (event, ctx) => {
		contextFiles = event.systemPromptOptions.contextFiles;
		return injectionFor(ctx, agentStartQuery(event, goal), event.messageType !== "custom");
	});

	// An overflow compaction retries the turn with `continue()`, which sends no `before_agent_start`: the notes and pinned
	// memories the summary replaced would stay out of the retry's request. They are sent again here, before it, only
	// when the compaction left them out of context (`seen` and the notes' context check already say so, so the retry adds
	// no bytes when a kept message still shows them).
	api.bus.on("session_compact", async (event, ctx) => {
		if (!event.willRetry) return;
		const injection = injectionFor(ctx, "");
		if (!injection) return;
		await api.session.sendMessage(injection.message, { triggerTurn: false, deliverAs: "followUp" });
	});

	api.bus.on("message_end", async (event, ctx) => {
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
		} catch (error) {
			// A missing agent DB or a busy writer never blocks a turn; only the usage mark is lost.
			if (!storeUnavailable(error)) throw error;
		}
	});

	// Its pass at the first run checks lines against the AGENTS.md files the `before_agent_start` above took.
	registerMemoryReflection(api, {
		isSubagent: options.isSubagent,
		env,
		store: storeFor,
		files,
		...(options.small ? { small: options.small } : {}),
	});
	if (!options.isSubagent) registerMemoryCommand(options.commands, { store: storeFor, autoEnv, sync: files });
	api.tools.register(
		createMemoryTool(storeFor, {
			isSubagent: options.isSubagent,
			permission: options.permission,
			appendEntry: (type, data) => api.session.appendEntry(type, data),
			files,
		}),
	);
}
