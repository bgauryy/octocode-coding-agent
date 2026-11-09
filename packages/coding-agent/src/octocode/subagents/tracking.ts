import { renderInstruction } from "../../core/prompt-template.ts";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Usage } from "@octocodeai/octocode-ai";
import type { ExtensionContext } from "../../core/features/index.ts";
import { notify } from "../shared/commands.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { existingLibrary } from "../history/archive.ts";
import { shortPath } from "../../utils/display-path.ts";
import { addReply, emptyTotals, finiteNumber, type ModelLookup, unpricedModel } from "../shared/util.ts";
import { type Ask, asksNote } from "../team/asks.ts";
import type { Run } from "./claim.ts";
import { noteChildCache } from "./cache-monitor.ts";
import type { ChildProgress } from "./events.ts";
import type { Identity } from "./process/env.ts";
import { StartupError } from "./process/outcome.ts";
import { type ChildSession, childSessionFile } from "./process/session.ts";
import { GENERAL_PROFILE } from "./profiles.ts";
import { archiveNote, compactionNote, sessionNote } from "./render.ts";
import { type Shot, saveShot, shotsDir } from "./screenshots.ts";
import type { ResultDetails, RunDetails } from "./run-types.ts";

export type AgentUpdate = (update: {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	details: RunDetails;
}) => void;

/** Trail lines a run keeps (tool calls, thoughts, narration); the collapsed row previews the last three. */
const ACTIVITY_KEPT = 8;

/** The row's line while a child waits for the user's answer to one of its dialogs. */
const WAITING_TEXT = "waiting for your approval";

/** The row's line while a child compacts its context. */
const COMPACTING_TEXT = "compacting its context";

/** A run's total usage so far (Octocode's `Usage`, kept up to date by the child's event stream), by its details. */
const spent = new WeakMap<RunDetails, Usage>();

/** What a background report carries of the run besides its text: its spend (the parent's footer and session index count it), its compactions and notices, its saved conversation, its questions to the parent. */
export const reportFacts = (
	details: RunDetails,
): Pick<
	ResultDetails,
	| "runId"
	| "startedAt"
	| "usage"
	| "unpriced"
	| "model"
	| "fallback"
	| "refusedBy"
	| "compactions"
	| "notices"
	| "session"
	| "asks"
	| "firstTurnTokens"
	| "requests"
	| "cache"
	| "startup"
	| "structured"
	| "reportArtifact"
> => {
	const usage = spent.get(details);
	return {
		...(details.runId ? { runId: details.runId } : {}),
		startedAt: details.startedAt,
		...(usage ? { usage, unpriced: details.unpriced } : {}),
		...(details.model ? { model: details.model } : {}),
		...(details.fallback ? { fallback: details.fallback } : {}),
		...(details.refusedBy ? { refusedBy: details.refusedBy } : {}),
		...(details.compactions ? { compactions: details.compactions } : {}),
		...(details.notices ? { notices: details.notices } : {}),
		...(details.session ? { session: details.session } : {}),
		...(details.asks ? { asks: details.asks } : {}),
		...(details.firstTurnTokens !== undefined ? { firstTurnTokens: details.firstTurnTokens } : {}),
		...(details.requests !== undefined ? { requests: details.requests } : {}),
		...(details.cache ? { cache: details.cache } : {}),
		...(details.startup ? { startup: details.startup } : {}),
		...(details.structured ? { structured: details.structured } : {}),
		...(details.reportArtifact ? { reportArtifact: details.reportArtifact } : {}),
	};
};

/**
 * The run's trusted footer lines: its compactions, its questions to the parent, and where its conversation is saved
 * (once its transcript exists, or by id when it failed): the parent reads it there, or continues it (`resume`).
 */
export const runFooter = (details: RunDetails, failed: boolean): string[] => [
	compactionNote(details),
	archiveNote(details),
	asksNote(details.asks),
	details.editedAfterVerify ? renderInstruction("notices/subagents/verify-stale.md") : "",
	failed || details.session?.file ? sessionNote(details) : "",
];

/** The prompt tokens (uncached, cache reads and writes) of an assistant reply, when it reports its usage. */
function replyPromptTokens(reply: Record<string, unknown> | undefined): number | undefined {
	const usage = reply?.usage;
	if (!isRecord(usage)) return undefined;
	const sum = ["input", "cacheRead", "cacheWrite"].reduce((total, key) => total + (finiteNumber(usage[key]) ?? 0), 0);
	return sum > 0 ? sum : undefined;
}

/**
 * Progress of a run into `details` (tool lines, usage, the latest screenshot), mirrored to `onUpdate`. A reply from a model
 * without pricing (looked up in this session's registry) marks the run's cost `n/a`.
 */
export function tracker(
	identity: Identity,
	details: RunDetails,
	find: ModelLookup,
	ctx?: Pick<ExtensionContext, "hasUI" | "ui">,
) {
	const dir = shotsDir();
	let shots = 0;
	let latest: Shot | undefined;
	return (onUpdate: AgentUpdate | undefined) =>
		({
			activity: line,
			step,
			thinking,
			usage,
			reply,
			image,
			denied,
			waiting,
			compacting,
			compactions,
			notices,
			requests,
			editedAfterVerify,
		}: ChildProgress) => {
			if (editedAfterVerify !== undefined) {
				if (editedAfterVerify) details.editedAfterVerify = true;
				else delete details.editedAfterVerify;
			}
			if (waiting !== undefined) {
				if (waiting) details.waiting = true;
				else delete details.waiting;
			}
			if (compacting !== undefined) {
				if (ctx?.hasUI) {
					const failed = (compactions?.failed ?? 0) > (details.compactions?.failed ?? 0);
					const aborted = (compactions?.aborted ?? 0) > (details.compactions?.aborted ?? 0);
					const outcome = compacting ? "started" : failed ? "failed" : aborted ? "cancelled" : "finished";
					try {
						notify(
							ctx.ui,
							`Subagent ${identity.id} (${identity.role ?? "agent"}) compaction ${outcome}.${compactions ? ` ${compactionNote({ compactions })}` : ""}`,
							failed ? "warning" : "info",
						);
					} catch {
						// The originating session may have been replaced while its child shuts down.
					}
				}
				if (compacting) details.compacting = true;
				else delete details.compacting;
			}
			if (compactions) details.compactions = compactions;
			if (notices) details.notices = notices;
			if (requests !== undefined) details.requests = requests;
			if (denied) details.denied = (details.denied ?? 0) + 1;
			if (line) details.toolCalls += 1;
			const entry = line ?? step;
			if (entry) details.activity = [...details.activity.slice(-(ACTIVITY_KEPT - 1)), entry];
			if (thinking !== undefined) {
				if (thinking) details.thinking = thinking;
				else delete details.thinking;
			}
			if (image) {
				shots += 1;
				latest = saveShot(dir, identity.id, shots, image);
				details.shot = latest.path;
			}
			const first = replyPromptTokens(reply);
			if (reply) details.cache = noteChildCache(details.cache, reply);
			if (first !== undefined && details.firstTurnTokens === undefined) details.firstTurnTokens = first;
			// `usage` is the run's total so far: the details restart from it. Cached prompt tokens count in ↑.
			const unpriced = details.unpriced || unpricedModel(reply, find) !== undefined;
			spent.set(details, usage);
			Object.assign(details, emptyTotals());
			addReply(details, usage, unpriced);
			const text = {
				type: "text" as const,
				text: details.waiting
					? WAITING_TEXT
					: details.compacting
						? COMPACTING_TEXT
						: (line ?? details.activity.at(-1) ?? "working"),
			};
			// Partial results only reach the user's screen, so the latest screenshot is drawn there but never enters the model's context.
			onUpdate?.({
				content:
					image && latest?.data ? [text, { type: "image", data: latest.data, mimeType: latest.mimeType }] : [text],
				details: { ...details },
			});
		};
}

/**
 * Once the child's run ends (however), the run's details name its transcript file (Octocode chose the file's name) and list
 * its questions to the parent with their answers (`asks`: read from the team's messages, so no one has to report them).
 */
export function recordRun<T>(
	details: RunDetails,
	session: ChildSession,
	asks: () => Ask[],
	run: Promise<T>,
): Promise<T> {
	return run
		.catch((error: unknown) => {
			if (error instanceof StartupError)
				details.startup = { failed: true, ...(error.reason ? { cause: error.reason } : {}) };
			throw error;
		})
		.finally(() => {
			const file = childSessionFile(session);
			const archive = existingLibrary(session.id);
			if (file || archive)
				details.session = {
					id: session.id,
					dir: session.dir,
					...(file ? { file } : {}),
					...(archive ? { archive: path.dirname(archive) } : {}),
				};
			const questions = asks();
			if (questions.length > 0) details.asks = questions;
		});
}

/** The row of a call waiting for a slot: who it will be, and how many run before it. */
export function waitingUpdate(
	profile: string | undefined,
	goal: string,
	running: number,
): { content: Array<{ type: "text"; text: string }>; details: RunDetails } {
	const details = startDetails({ id: "", profile: profile ?? GENERAL_PROFILE, goal, status: "waiting" });
	return { content: [{ type: "text", text: `waiting for a slot (${running} running)` }], details };
}

/** A run's details before it has spent anything. */
const startDetails = (fields: Pick<RunDetails, "id" | "profile" | "goal" | "status">): RunDetails => ({
	...fields,
	toolCalls: 0,
	activity: [],
	...emptyTotals(),
	startedAt: Date.now(),
});

/** A run's details as it starts; `session` names the folder its transcript goes to. */
export function runDetails(run: Run, session?: ChildSession): RunDetails {
	const { model, fallback, refusedBy } = run.route;
	return {
		...startDetails({ id: run.identity.id, profile: run.identity.role, goal: run.identity.goal, status: "running" }),
		runId: randomUUID(),
		session: { id: session?.id ?? run.identity.sessionId ?? run.identity.id, ...(session ? { dir: session.dir } : {}) },
		...(model ? { model } : {}),
		...(fallback ? { fallback } : {}),
		...(refusedBy ? { refusedBy } : {}),
	};
}

export const withShot = (details: RunDetails, text: string) =>
	details.shot ? `${text}\n\n(Last screenshot: ${shortPath(details.shot)})` : text;
