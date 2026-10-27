import path from "node:path";
import type { Usage } from "@octocodeai/octocode-ai";
import { isRecord } from "../../utils/guards.ts";
import { existingLibrary } from "../shared/archive.ts";
import { shortPath } from "../shared/format.ts";
import { addReply, emptyTotals, finiteNumber, type ModelLookup, unpricedModel } from "../shared/util.ts";
import { type Ask, asksNote } from "../team/asks.ts";
import type { Run } from "./claim.ts";
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
	| "usage"
	| "unpriced"
	| "model"
	| "fallback"
	| "compactions"
	| "notices"
	| "session"
	| "asks"
	| "firstTurnTokens"
	| "requests"
	| "startup"
	| "structured"
> => {
	const usage = spent.get(details);
	return {
		...(usage ? { usage, unpriced: details.unpriced } : {}),
		...(details.model ? { model: details.model } : {}),
		...(details.fallback ? { fallback: details.fallback } : {}),
		...(details.compactions ? { compactions: details.compactions } : {}),
		...(details.notices ? { notices: details.notices } : {}),
		...(details.session ? { session: details.session } : {}),
		...(details.asks ? { asks: details.asks } : {}),
		...(details.firstTurnTokens !== undefined ? { firstTurnTokens: details.firstTurnTokens } : {}),
		...(details.requests !== undefined ? { requests: details.requests } : {}),
		...(details.startup ? { startup: details.startup } : {}),
		...(details.structured ? { structured: details.structured } : {}),
	};
};

/** The run's trusted footer lines: its compactions, its questions to the parent, and where its conversation is saved when it failed. */
export const runFooter = (details: RunDetails, failed: boolean): string[] => [
	compactionNote(details),
	archiveNote(details),
	asksNote(details.asks),
	failed ? sessionNote(details) : "",
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
export function tracker(identity: Identity, details: RunDetails, find: ModelLookup) {
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
		}: ChildProgress) => {
			if (waiting !== undefined) {
				if (waiting) details.waiting = true;
				else delete details.waiting;
			}
			if (compacting !== undefined) {
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

/** A run's details as it starts. */
export function runDetails(run: Run): RunDetails {
	const { model, fallback } = run.route;
	return {
		...startDetails({ id: run.identity.id, profile: run.identity.role, goal: run.identity.goal, status: "running" }),
		session: { id: run.identity.id },
		...(model ? { model } : {}),
		...(fallback ? { fallback } : {}),
	};
}

export const withShot = (details: RunDetails, text: string) =>
	details.shot ? `${text}\n\n(Last screenshot: ${shortPath(details.shot)})` : text;
