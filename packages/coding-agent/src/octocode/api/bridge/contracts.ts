import type { ExtensionContext } from "../../../core/extensions/index.ts";
import type { MessageEnvelope } from "../../shared/messages.ts";

/** What the API needs from the team (kept as an interface so the API domain stays independent of it). */
export interface AgentDirectory {
	list(): unknown[];
	/** Sends a team message (the team saves a long body to a file and delivers a pointer); a result with `error` (unknown recipient, nobody to reach) is a refusal. */
	tell(to: string, text: string): unknown;
	/** What a reader of a message from `from` gets for `text`: the text, or (when it is long) its head and the path of a file with all of it; an `error` when it cannot be saved. */
	deliverable(text: string, from: string): string | { error: string };
}

/**
 * Where a tool call sits in the call tree. Calls a tool makes itself (`ctx.executeTool`, e.g. programmatic tool callers) carry
 * `parentToolCallId`, and Octocode names them `<parent>/<n>`; provider ids contain no `/`, so the parent's segment count is
 * the depth: `toolu_1` → 0, `toolu_1/1` (parent `toolu_1`) → 1, `toolu_1/1/2` (parent `toolu_1/1`) → 2.
 */
export function nesting(parentId: string | undefined): { depth: number; parentId?: string } {
	return parentId ? { parentId, depth: parentId.split("/").length } : { depth: 0 };
}

export interface ApiOperations {
	messageSend?(message: MessageEnvelope, ctx: ExtensionContext, signal?: AbortSignal): Promise<void>;
	externalCall?(params: unknown, ctx: ExtensionContext): Promise<unknown>;
}
