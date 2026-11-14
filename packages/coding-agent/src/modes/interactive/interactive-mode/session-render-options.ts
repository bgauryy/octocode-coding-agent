import type { ToolExecutionComponent } from "../components/tool-execution.ts";

export interface SessionRenderOptions {
	updateFooter?: boolean;
	populateHistory?: boolean;
	/** Shared only across the chronological ranges rendered by one history operation. */
	toolState?: Map<string, ToolExecutionComponent>;
	/** Explicitly retained, unresolved tools from a same-session rebuild. */
	liveTools?: ReadonlyMap<string, ToolExecutionComponent>;
}
