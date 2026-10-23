import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "../../core/extensions/index.ts";
import { sharedAgentDb } from "../agentdb/db.ts";
import type { Permission } from "../permission/ask.ts";
import type { Subcommands } from "../shared/commands.ts";
import { envFlag, MEMORY_AUTO_ENV } from "../shared/env.ts";
import { repoKey } from "../shared/home.ts";
import { projectTrustNow } from "../shared/trust.ts";
import { contentText } from "../shared/util.ts";
import { registerMemoryCommand } from "./command.ts";
import { injectedIds, MEMORY_MESSAGE_TYPE, selectInjection, unchangedIds } from "./inject.ts";
import { MemoryStore } from "./store.ts";
import { registerMemoryTool } from "./tool.ts";

/** BM25 hits injected per prompt beside the pinned memories: fewer in a subagent, whose task is narrow. */
const TOP_K = 5;
const SUBAGENT_TOP_K = 3;

/** The memory store of `cwd`'s repository in the shared agent DB (the DB reopens when its path changes). */
export function memoryStore(cwd: string, env: NodeJS.ProcessEnv = process.env): MemoryStore {
	return new MemoryStore(sharedAgentDb(env), repoKey(cwd).key);
}

/** Text that started the run. A user prompt is `prompt`; an idle custom message carries its own content. */
function agentStartQuery(event: BeforeAgentStartEvent): string {
	if (event.messageType === "custom") {
		return contentText(event.message.content);
	}
	return event.prompt;
}

/**
 * Durable memories: the `memory` tool, automatic injection of pinned and relevant memories before each prompt (hidden
 * from the transcript), and `/memory`. Project memories reach the model only in a trusted project.
 */
export function registerMemory(
	pi: ExtensionAPI,
	options: { commands: Subcommands; isSubagent: boolean; permission: Permission; env?: NodeJS.ProcessEnv },
): void {
	const env = options.env ?? process.env;
	const storeFor = (ctx: Pick<ExtensionContext, "cwd">) => memoryStore(ctx.cwd, env);
	const autoEnv = () => envFlag(env, MEMORY_AUTO_ENV, true);

	registerMemoryTool(pi, storeFor, { isSubagent: options.isSubagent, permission: options.permission });

	pi.on("before_agent_start", async (event, ctx) => {
		if (!autoEnv()) return undefined;
		try {
			const store = storeFor(ctx);
			if (!store.autoSetting()) return undefined;
			const injection = selectInjection(store, {
				query: agentStartQuery(event),
				scope: projectTrustNow(ctx) === true ? "all" : "global",
				seen: unchangedIds(store, injectedIds(ctx.sessionManager.getBranch())),
				topK: options.isSubagent ? SUBAGENT_TOP_K : TOP_K,
				// A subagent's parent already holds the pinned memories and briefs it through the task.
				pinned: !options.isSubagent,
			});
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
			// A missing or foreign agent DB never blocks a prompt; the tool and command report the error.
			return undefined;
		}
	});

	pi.on("message_end", async (event, ctx) => {
		const { message } = event;
		if (message.role !== "custom" || message.customType !== MEMORY_MESSAGE_TYPE) return;
		const ids = (message.details as { ids?: unknown } | undefined)?.ids;
		if (!Array.isArray(ids)) return;
		try {
			storeFor(ctx).markUsed(ids.filter((id): id is number => typeof id === "number"));
		} catch {
			// A missing agent DB never blocks a turn.
		}
	});

	if (!options.isSubagent) registerMemoryCommand(options.commands, { store: storeFor, autoEnv });
}
