import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "../../core/extensions/index.ts";
import { sharedAgentDb } from "../agentdb/api.ts";
import type { Permission } from "../permission/ask.ts";
import { notify, type Subcommands } from "../shared/commands.ts";
import { envFlag, MEMORY_AUTO_ENV } from "../../../../common/src/env.ts";
import { repoKey } from "../shared/home/repo.ts";
import { projectTrustNow } from "../shared/trust.ts";
import { contentText } from "../shared/util.ts";
import { registerMemoryCommand } from "./command.ts";
import { injectedIds, MEMORY_MESSAGE_TYPE, selectInjection, unchangedIds } from "./inject.ts";
import { memoryLabel } from "./query.ts";
import { MemoryStore } from "./store.ts";
import { registerMemoryTool } from "./tool.ts";

/** BM25 hits injected per prompt beside the pinned memories: fewer in a subagent, whose task is narrow. */
const TOP_K = 5;
const SUBAGENT_TOP_K = 3;

/** The memory store of `cwd`'s repository in the shared agent DB (the DB reopens when its path changes). */
export function memoryStore(cwd: string, env: NodeJS.ProcessEnv = process.env): MemoryStore {
	return new MemoryStore(sharedAgentDb(env), repoKey(cwd).key);
}

/**
 * Text that started the run. A subagent with a goal searches by it: the brief opens with shared context, so its first
 * words say little about the task. A user prompt is `prompt`; an idle custom message carries its own content.
 */
function agentStartQuery(event: BeforeAgentStartEvent, goal: string | undefined): string {
	if (goal) return goal;
	if (event.messageType === "custom") {
		return contentText(event.message.content);
	}
	return event.prompt;
}

/**
 * Durable memories: the `memory` tool, automatic injection of pinned and relevant memories before each prompt (hidden
 * from the transcript), and `/memory`. Only injection waits for trust: an untrusted project injects global memories only,
 * while the tool reads project memories whatever the trust state. The user sees which memories were recalled, and once
 * per session that an untrusted project's memories are not injected; neither notice reaches the model. `goal` is a subagent's goal (`OCTOCODE_AGENT_GOAL`), its recall query.
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
): void {
	const env = options.env ?? process.env;
	const storeFor = (ctx: Pick<ExtensionContext, "cwd">) => memoryStore(ctx.cwd, env);
	const autoEnv = () => envFlag(env, MEMORY_AUTO_ENV, true);
	const goal = options.isSubagent ? options.goal?.trim() || undefined : undefined;
	let failedSession: string | undefined;
	let hiddenNoticeSession: string | undefined;

	registerMemoryTool(api, storeFor, { isSubagent: options.isSubagent, permission: options.permission });

	/** Says once per session that project memories exist but are not injected, so a lapsed trust does not fail silently. */
	const noticeHidden = (store: MemoryStore, ctx: ExtensionContext) => {
		const session = ctx.sessionManager.getSessionId();
		if (!ctx.hasUI || options.isSubagent || hiddenNoticeSession === session) return;
		hiddenNoticeSession = session;
		const hidden = store.count("project");
		if (hidden > 0)
			notify(
				ctx.ui,
				`${hidden} project ${hidden === 1 ? "memory is" : "memories are"} not injected: this project is not trusted. /trust shows what it would load.`,
				"warning",
			);
	};

	api.on("before_agent_start", async (event, ctx) => {
		try {
			const trusted = projectTrustNow(ctx) === true;
			if (!trusted) noticeHidden(storeFor(ctx), ctx);
			if (!autoEnv()) return undefined;
			const store = storeFor(ctx);
			if (!store.autoSetting()) return undefined;
			const injection = selectInjection(store, {
				query: agentStartQuery(event, goal),
				scope: trusted ? "all" : "global",
				seen: unchangedIds(store, injectedIds(ctx.sessionManager.getBranch())),
				topK: options.isSubagent ? SUBAGENT_TOP_K : TOP_K,
				// A subagent gets no pinned memories: its task brief carries none, and it can read them with the memory tool.
				pinned: !options.isSubagent,
			});
			failedSession = undefined;
			if (!injection) return undefined;
			// Counted as used once the message is committed (`message_end`), not when it is offered: a prompt that never runs
			// does not use its memories.
			return {
				message: {
					customType: MEMORY_MESSAGE_TYPE,
					content: injection.content,
					display: false,
					details: { ids: injection.ids, updated: injection.updated },
				},
			};
		} catch {
			// A broken store never blocks a prompt; notify once until retrieval recovers.
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
			return undefined;
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
			storeFor(ctx).markUsed(used);
		} catch {
			// A missing agent DB never blocks a turn.
		}
	});

	if (!options.isSubagent) registerMemoryCommand(options.commands, { store: storeFor, autoEnv });
}
