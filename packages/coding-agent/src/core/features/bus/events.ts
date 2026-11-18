import type { FeatureEvent } from "../types.ts";

/**
 * How the session bus dispatches an event; every handler runs in feature load order, then registration order.
 * - notify: no result; a throw is reported and the next handler runs.
 * - cancel: the last result is kept; the first `cancel: true` returns.
 * - observe-clone: the native handler gets the live event and its result counts; others get a copy and are ignored.
 * - boundary: `entries` and `continue` chain; the context is rebuilt after each handler.
 * - transform-context, transform-prompt, transform-input, transform-message: each handler sees the previous result.
 * - collect: results are joined; `user_input` stops once the run is aborted.
 * - last-override: the last defined answer wins.
 * - merge-result: fields merge one by one.
 * - gate: the first block or defer returns; a throw is not contained.
 * - first-result: the first valid result wins; a throw is reported and rethrown.
 * - sync-all, sync-cleanup: synchronous; true only if every handler says so, or every handler runs and failures are dropped.
 */
export type EventKind =
	| "notify"
	| "cancel"
	| "observe-clone"
	| "boundary"
	| "transform-context"
	| "transform-prompt"
	| "transform-input"
	| "transform-message"
	| "collect"
	| "last-override"
	| "merge-result"
	| "gate"
	| "first-result"
	| "sync-all"
	| "sync-cleanup";

/** Every event a feature may subscribe to. */
export type BusEventType = FeatureEvent["type"] | "tool_call_early_start" | "tool_call_discarded";

/** The dispatch kind of each event: the one place the dispatch rules are named. */
export const EVENT_KINDS = {
	session_start: "notify",
	session_shutdown: "notify",
	session_info_changed: "notify",
	session_compact: "notify",
	session_compact_prewarm: "notify",
	session_compact_failed: "notify",
	session_tree: "notify",
	mcp_servers_change: "notify",
	agent_start: "notify",
	agent_end: "notify",
	agent_interrupted: "notify",
	agent_settled: "notify",
	agent_settle_end: "notify",
	ui_prompt_start: "notify",
	ui_prompt_end: "notify",
	turn_start: "notify",
	turn_prompt: "notify",
	message_start: "notify",
	message_update: "notify",
	tool_execution_start: "notify",
	tool_execution_update: "notify",
	tool_execution_end: "notify",
	model_select: "notify",
	thinking_level_select: "notify",
	session_before_switch: "cancel",
	session_before_fork: "cancel",
	session_before_quit: "cancel",
	session_before_tree: "cancel",
	session_before_compact: "observe-clone",
	turn_end: "boundary",
	agent_before_settle: "boundary",
	context: "transform-context",
	before_agent_start: "transform-prompt",
	input: "transform-input",
	message_end: "transform-message",
	resources_discover: "collect",
	user_input: "collect",
	cache_warming_decision: "last-override",
	tool_result: "merge-result",
	tool_call: "gate",
	user_bash: "first-result",
	tool_call_early_start: "sync-all",
	tool_call_discarded: "sync-cleanup",
} as const satisfies Record<BusEventType, EventKind>;
