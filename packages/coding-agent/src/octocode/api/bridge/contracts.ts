import type { FeatureContext } from "../../../core/features/index.ts";
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

/** Who an external message says it is from and what it asks: what the session's permission layer decides on. */
export interface ExternalAdmission {
	from: string;
	/**
	 * The running instance that confirmed the call (`bridge/verify.ts`): `id` (its instance id and pid) keys its grant and
	 * denial, `name` is what the user knows it by.
	 */
	process?: { id: string; name: string };
	details: string[];
	text: string;
	/** This process's own name, for what the sender reads back. */
	self: string;
	/** Set when `sessionApiTurnPermission` is `"workspace"`: the message and its turn are judged in at most this mode, whatever the session's. */
	ceiling?: TurnCeiling;
}

/** The mode a turn an API client starts is held to (`sessionApiTurnPermission`); the session's own mode applies when it is stricter. */
export type TurnCeiling = "workspace";

export interface ApiOperations {
	messageSend?(message: MessageEnvelope, ctx: FeatureContext, signal?: AbortSignal): Promise<void>;
	/** Whether this message may reach the session (a permission check); throws what the sender reads. `onAsk`: it waits for the user. */
	admit?(claim: ExternalAdmission, ctx: FeatureContext, signal?: AbortSignal, onAsk?: () => void): Promise<void>;
	/** Holds the session's tool calls to `ceiling` until it is called with `undefined`: the turn an API client started. */
	capTurn?(ceiling: TurnCeiling | undefined): void;
	externalCall?(params: unknown, ctx: FeatureContext): Promise<unknown>;
}
