import type { ToolExecutionComponent } from "../components/tool-execution.ts";

export interface SessionRenderOptions {
	updateFooter?: boolean;
	populateHistory?: boolean;
	/** Shared only across the chronological ranges rendered by one history operation. */
	toolState?: Map<string, ToolExecutionComponent>;
	/** Explicitly retained, unresolved tools from a same-session rebuild. */
	liveTools?: ReadonlyMap<string, ToolExecutionComponent>;
	/** Entry ids of the failed attempts the session retried (`retriedAttemptIds`), found once for all ranges of one rebuild. */
	retriedIds?: ReadonlySet<string>;
	/** The messages of those attempts among the items rendered: they read as retried, not as the turn's failure. */
	retriedMessages?: WeakSet<object>;
}
