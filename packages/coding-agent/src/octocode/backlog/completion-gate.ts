import type { FeatureContext } from "../../core/features/index.ts";
import type { CompletionInfo } from "../shared/completion-info.ts";
import type { Item } from "./item.ts";

export type { CompletionInfo };

/**
 * Asks the TaskCompleted hooks, before the write, whether the item may end. A returned reason refuses the write and is
 * shown to the agent; undefined lets it go ahead. Only the process that writes can ask: a write from another process or
 * the web board has already happened.
 */
export type CompletionGate = (
	info: CompletionInfo,
	ctx: FeatureContext,
	signal?: AbortSignal,
) => Promise<string | undefined>;

export const completionInfo = (
	item: Item,
	change: CompletionInfo["change"],
	args: { completion?: unknown; close?: unknown },
): CompletionInfo => ({
	ref: item.ref,
	title: item.title,
	goal: item.goal,
	...(item.assignee ? { assignee: item.assignee } : {}),
	change,
	...(args.completion !== undefined ? { completion: args.completion } : {}),
	...(args.close !== undefined ? { close: args.close } : {}),
});
