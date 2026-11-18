/**
 * The in-use set (`mcpExposure: "recent"`) saved with the session. The set decides which tools the cached prompt declares
 * in full, and it is read when a session starts; a resumed, reloaded or forked session that read the record again would
 * declare a different set whenever this folder called another tool since, and rewrite the provider's cached prompt. So
 * the first run of a session saves the set it declared as a record no model sees, and a later start of that session in
 * the same folder declares it again. A new session, a session without the record, and a subagent (which takes its
 * coordinator's set) read the set as before.
 */

import { defersByRecentUse } from "./deferral.ts";
import type { McpContext } from "./host/types.ts";
import type { McpFeatureState } from "./state.ts";

/** The session record's `customType`. */
export const RECENT_TOOLS_ENTRY = "mcp-recent-tools";

interface SavedRecentTools {
	cwd: string;
	tools: string[];
}

/** The text a saved set is compared by: its tools in order. */
const keyOf = (tools: Iterable<string>): string => JSON.stringify([...tools].sort());

function savedOf(entry: unknown): SavedRecentTools | undefined {
	if (typeof entry !== "object" || entry === null) return undefined;
	const { type, customType, data } = entry as { type?: unknown; customType?: unknown; data?: unknown };
	if (type !== "custom" || customType !== RECENT_TOOLS_ENTRY || typeof data !== "object" || data === null)
		return undefined;
	const { cwd, tools } = data as { cwd?: unknown; tools?: unknown };
	if (typeof cwd !== "string" || !Array.isArray(tools) || !tools.every((tool) => typeof tool === "string"))
		return undefined;
	return { cwd, tools };
}

/** The set this session's current branch saved last, for this folder; undefined when it saved none. */
function savedRecentTools(ctx: McpContext): SavedRecentTools | undefined {
	let branch: readonly unknown[] | undefined;
	try {
		branch = ctx.sessionManager?.getBranch?.();
	} catch {
		return undefined;
	}
	for (let index = (branch?.length ?? 0) - 1; index >= 0; index--) {
		const saved = savedOf(branch![index]);
		if (saved) return saved.cwd === ctx.cwd ? saved : undefined;
	}
	return undefined;
}

/** What each instance's session saved (its key), so a run saves only a set the session does not hold yet. */
const savedKeys = new WeakMap<McpFeatureState, string | undefined>();

/** At `session_start`: forget the last session's set, and take the one this session saved, if any. */
export function restoreRecentTools(state: McpFeatureState, ctx: McpContext): void {
	const saved = state.recentToolsHandedIn() ? undefined : savedRecentTools(ctx);
	state.forgetRecentTools(saved && new Set(saved.tools));
	savedKeys.set(state, saved && keyOf(saved.tools));
}

/** At a run's start: save the set the session declares when the session does not hold it yet. Fails open. */
export function saveRecentTools(state: McpFeatureState): void {
	if (!state.api.session.appendEntry || state.recentToolsHandedIn() || !defersByRecentUse(state.exposureSetting()))
		return;
	const tools = state.recentTools();
	if (!tools) return;
	const key = keyOf(tools);
	if (savedKeys.get(state) === key) return;
	try {
		state.api.session.appendEntry(RECENT_TOOLS_ENTRY, { cwd: state.sessionCwd, tools: [...tools].sort() });
		savedKeys.set(state, key);
	} catch {
		// Unsaved, a later start of this session reads the record as before.
	}
}
