import type { RunnerBilling } from "./runner-port.ts";
import type { Usage } from "@octocodeai/octocode-ai";
import type { ChildCacheMetrics } from "./cache-monitor.ts";
import type { ReportStatus } from "../instructions/report.ts";
import type { Ask } from "../team/asks.ts";
import type { Compactions } from "./events.ts";
import type { ChildNotices } from "./notices.ts";
import type { StructuredResultV1 } from "./result-schema.ts";
import type { ReportArtifact } from "../child-sessions/report-artifact.ts";

/**
 * The child's saved conversation: its session id (it names the child's Octocode folder `<home>/agent/sessions/<id>`),
 * the folder its transcript is written to (recorded at the start, so a run that never reports can still be found), its
 * transcript file once the run ended, and the folder of its archive of compacted history (`history/archive.ts`) once it
 * compacted: Markdown the parent can search with the Octocode tools.
 */
interface ChildSessionDetails {
	id: string;
	dir?: string;
	file?: string;
	archive?: string;
}

/** The `agent` tool's result details, updated as the child streams. */
export interface RunDetails {
	/** The agent's name. */
	id: string;
	/** This execution, distinct from later continuations of the same child; absent in older transcripts. */
	runId?: string;
	/** Its role. */
	profile: string;
	goal: string;
	toolCalls: number;
	/** It edited a file after its last passing `bash verify` run. */
	editedAfterVerify?: boolean;
	/** Model requests the child made in this run (`budget.ts`); absent before its first reply. */
	requests?: number;
	/** Conversation cache usage, excluding auxiliary requests; latest is the last completed message. */
	cache?: ChildCacheMetrics;
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
	/** With `background`: every slot was taken, so it starts when one frees. Cleared as it starts. */
	queued?: boolean;
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
	/** The provider of `fallback` when it is configured but refused its credential recently. */
	refusedBy?: string;
	/** The latest completed report's outcome; absent while running or when that report names none. */
	outcome?: ReportStatus;
	/** Where that report named it: its first word (the contract's form) or a labelled last line; `/agents stats` counts both. */
	outcomeSource?: "first" | "last";
	/** Host-validated final JSON result, if the caller requested a result contract. */
	structured?: StructuredResultV1;
	/** The exact saved report version; absent in legacy session entries. */
	reportArtifact?: ReportArtifact;
	/** The subagent's latest screenshot, saved to this path. */
	shot?: string;
	/** Initial context of its first model reply: uncached input plus cache reads and writes. */
	firstTurnTokens?: number;
	/** The run failed before its first model turn (`cause`: the one error line). */
	startup?: { failed: true; cause?: string };
	/** Who paid for a runner's turns (`runner` tasks): `plan`, its own subscription, counts no cost. */
	billing?: RunnerBilling;
}

/** What the background-result message carries for its renderer: the outcome, not parsed back out of the text. */
export interface ResultDetails {
	id: string;
	/** The execution this report completes, as in RunDetails. */
	runId?: string;
	/** Its launch time; orders message-based continuations that have no task launch entry. */
	startedAt?: number;
	reportId?: string;
	/** Its role and its goal. */
	profile?: string;
	goal?: string;
	status: "done" | "failed" | "stopped";
	/** The latest completed report's outcome (`failed` for a failed run); absent when it names none. */
	outcome?: ReportStatus;
	/** As in `RunDetails`. */
	outcomeSource?: "first" | "last";
	/** Immutable contract hash and host validation verdict; valid data is available to the caller. */
	structured?: StructuredResultV1;
	reportArtifact?: ReportArtifact;
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
	/** As in `RunDetails`: where it ran, shown when the report is expanded. */
	model?: string;
	fallback?: string;
	refusedBy?: string;
	/** Its compactions, warnings and errors, and saved conversation, as in `RunDetails`. */
	compactions?: Compactions;
	notices?: ChildNotices;
	session?: ChildSessionDetails;
	asks?: Ask[];
	/** As in `RunDetails`. */
	firstTurnTokens?: number;
	requests?: number;
	cache?: ChildCacheMetrics;
	startup?: { failed: true; cause?: string };
	billing?: RunnerBilling;
}
