import type { Usage } from "@octocodeai/octocode-ai";
import type { ReportStatus } from "../instructions/report.ts";
import type { Ask } from "../team/asks.ts";
import type { ChildNotices, Compactions } from "./events.ts";

/**
 * The child's saved conversation: its session id (it names the child's Octocode folder `<home>/agent/pi/sessions/<id>`),
 * its transcript file once written, and the folder of its archive of compacted history (`shared/archive.ts`) once it
 * compacted: Markdown the parent can search with the Octocode tools.
 */
interface ChildSessionDetails {
	id: string;
	file?: string;
	archive?: string;
}

/** The `agent` tool's result details, updated as the child streams. */
export interface RunDetails {
	/** The agent's name. */
	id: string;
	/** Its role. */
	profile: string;
	goal: string;
	toolCalls: number;
	/** Tool calls the child could not run without the user's approval. */
	denied?: number | undefined;
	/** Its latest steps: tool calls (`→ bash ls`), thoughts (`✻ …`) and narration (`› …`). */
	activity: string[];
	/** The gist of the thinking it streams now. */
	thinking?: string;
	/** Every prompt token (uncached, cache reads and writes); `cacheRead` is the part read from cache. */
	input: number;
	cacheRead: number;
	output: number;
	/** Octocode's estimate; `unpriced`: part of the usage came from a model without pricing and is not in it. */
	cost: number;
	unpriced: boolean;
	startedAt: number;
	/** waiting: for a free slot; running: foreground, still working; background: returned at once, the report arrives as a message. */
	status: "waiting" | "running" | "background" | "done" | "failed";
	/** The child waits for the user's answer to one of its dialogs (shown in this session). */
	waiting?: boolean;
	/** The child compacts its context now. */
	compacting?: boolean;
	/** Its compactions so far; absent when none started. */
	compactions?: Compactions;
	/** Warnings and errors its extensions showed (a child has no screen): an inline page, then a count and the file with every one. */
	notices?: ChildNotices;
	/** Its saved conversation. */
	session?: ChildSessionDetails;
	/** Its questions to the parent (`agent` with type `message` with `replyRequired`), each with its answer and wait; set when the run ends, absent when it asked none. */
	asks?: Ask[];
	/** Someone stopped the run; it is closing (the child, an isolated run's worktree). */
	stopping?: boolean;
	/** The `provider/id` it runs on (with any `:thinking` suffix); absent when it runs on the parent's model. */
	model?: string;
	/** The profile's preferred model, unavailable here: the run fell back to the parent's model. */
	fallback?: string;
	/** The latest completed report's outcome; absent while running or when that report names none. */
	outcome?: ReportStatus;
	/** The subagent's latest screenshot, saved to this path. */
	shot?: string;
	/** Prompt tokens (uncached, cache reads and writes) of its first model reply: what its cold start cost. */
	firstTurnTokens?: number;
	/** The run failed before its first model turn (`cause`: the one error line). */
	startup?: { failed: true; cause?: string };
}

/** What the background-result message carries for its renderer: the outcome, not parsed back out of the text. */
export interface ResultDetails {
	id: string;
	reportId?: string;
	/** Its role and its goal. */
	profile?: string;
	goal?: string;
	status: "done" | "failed" | "stopped";
	/** The latest completed report's outcome (`failed` for a failed run); absent when it names none. */
	outcome?: ReportStatus;
	/** The `⎿` line, e.g. `Done (name · 4 tool calls · ↑12k ↓2k · ≈$0.12 · 38s)`. */
	summary: string;
	durationMs?: number;
	/** A stop someone asked for (`/agents kill`, `agent` with type `coordinate` and action `stop`): drawn as an outcome, not as a failure. */
	requested?: boolean;
	/** The full prompt the subagent was given, shown when the report is expanded. */
	task?: string;
	/** The run's total model usage (Octocode's `Usage`): the parent's footer and session index count it (`spendOf`). */
	usage?: Usage;
	/** Whether any of the run's replies came from a model without pricing (then `usage.cost` leaves them out). */
	unpriced?: boolean;
	/** Its compactions, warnings and errors, and saved conversation, as in `RunDetails`. */
	compactions?: Compactions;
	notices?: ChildNotices;
	session?: ChildSessionDetails;
	asks?: Ask[];
	/** As in `RunDetails`. */
	firstTurnTokens?: number;
	startup?: { failed: true; cause?: string };
}
