import fs from "node:fs";
import path from "node:path";
import { Text } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import { getAgentDir } from "../../config.ts";
import { cleanTitle } from "../../core/session-manager/title.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { sharedAgentDb } from "../agentdb/api.ts";
import type { Subcommands } from "../shared/commands.ts";
import { notify } from "../shared/commands.ts";
import { SpendScan } from "../shared/spend.ts";
import { currentSessionId } from "../shared/home.ts";
import { repoKey } from "../shared/home/repo.ts";
import { expandKey, plural } from "../shared/render/text.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { CLAIM_MARKER, pendingReportsDir } from "../subagents/handoff/pending.ts";
import {
	addUsage,
	contentText,
	emptyUsage,
	type Spend,
	type ModelLookup,
	modelLookup,
	spendOf,
	unpricedModel,
} from "../shared/util.ts";
import { type BriefInput, latestRequest, ongoingBrief, openTasksBrief, resumeBrief } from "./brief.ts";
import { recordSession, recordTitle } from "./catalog.ts";
import { registerSessionsCommand } from "./command.ts";
import { gitCommitsBetween, gitDirty, gitState, SessionIndex } from "./store.ts";
import { type CompleteTitle, createAutoTitler } from "./title.ts";
import { sweepSessions } from "./sweep.ts";
import { describeWork, unreportedWork } from "./work.ts";

/** Custom message type of the resume brief. */
export const RESUME_MESSAGE_TYPE = "octocode-resume";
/** Custom message type of the running-work note added after a compaction. */
export const RUNNING_WORK_TYPE = "octocode-running-work";

interface SessionsOptions {
	commands: Subcommands;
	/** A subagent keeps its output in its own session folder but gets no index row, sweep, command or brief. */
	isSubagent: boolean;
	/** Distinct files the agent changed in this session (the checkpoint journal). */
	filesChanged?: () => number;
	/** A subagent's goal: it names the child's session (`session_info` with source `goal`). */
	goal?: string;
	/** The model call that writes an auto title, and how long it may take (tests replace both). */
	titleCall?: { complete?: CompleteTitle; timeoutMs?: number };
}

type Entry = {
	type?: string;
	timestamp?: string;
	message?: { role?: string; usage?: unknown; details?: unknown };
	customType?: string;
	details?: unknown;
};

/**
 * Cost and tokens of a session, read once at start; later replies are added as they end. A fork (or clone) starts with
 * its parent's history copied in, entries keeping their original times: those were paid for in the parent, so with a
 * `parentSession` only entries from the fork's own start (its header time) on count. The footer's and /session's entries
 * count (`SpendScan`): replies, a foreground subagent's `agent` result, a background subagent's report, `usage` entries
 * (compaction summaries, cache refreshes, side questions) and compaction and branch summaries.
 */
function totals(
	entries: readonly Entry[],
	header: { timestamp?: string; parentSession?: string } | null | undefined,
	find: ModelLookup,
	scan: SpendScan,
): { usage: ReturnType<typeof emptyUsage>; unpriced: boolean } {
	const forkedAt = header?.parentSession ? Date.parse(header.timestamp ?? "") : Number.NaN;
	const usage = emptyUsage();
	let unpriced = false;
	for (const entry of entries) {
		const spend = scan.entry(entry);
		if (!spend) continue;
		if (Number.isFinite(forkedAt) && Date.parse(entry.timestamp ?? "") < forkedAt) continue;
		addUsage(usage, spend.usage);
		unpriced ||= unpricedModel(spend, find) !== undefined;
	}
	return { usage, unpriced };
}

/** When the session was last active: its last entry's time, or undefined when Octocode recorded none. */
function lastActive(entries: readonly Entry[]): number | undefined {
	const at = Date.parse(entries.at(-1)?.timestamp ?? "");
	return Number.isFinite(at) ? at : undefined;
}

/** The session's current branch (what the model sees), or all entries when Octocode offers no branch. */
const branchOf = (ctx: ExtensionContext): readonly unknown[] =>
	ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? [];

/**
 * After a compaction, a non-waking reorient brief: the work still running (background bash jobs and subagents started
 * since this session started in this process, without a report yet), this session's ongoing backlog items with their
 * goal, why, paths, links and last notes, its open tasks, and the latest user request. The summary may have dropped them, and the
 * running work's reports will arrive later as messages. Every part is capped (see brief.ts).
 */
function registerRunningWork(api: ExtensionAPI): void {
	let since = Date.now();
	api.on("session_start", async () => {
		since = Date.now();
	});
	api.on("session_compact", async (_event, ctx) => {
		const branch = branchOf(ctx);
		const running = unreportedWork(branch, since).map((work) => describeWork(work, false));
		let ongoing: string[] = [];
		try {
			const [agent, repo, session] = [sharedAgentDb(), repoKey(ctx.cwd).key, ctx.sessionManager.getSessionId()];
			ongoing = [...ongoingBrief(agent, repo, session), ...openTasksBrief(agent, repo, session)];
		} catch {
			// The agent database is unavailable: the running work and the request alone still help.
		}
		const request = latestRequest(branch);
		if (running.length === 0 && ongoing.length === 0 && !request) return;
		const lines = [
			...(running.length > 0 ? [`Still running (their reports arrive as messages): ${running.join("; ")}.`] : []),
			...ongoing,
			...(request ? [`Latest user request: "${request}"`] : []),
		];
		const content = `[After compaction] ${lines.join("\n")}`;
		try {
			void api.sendMessage(
				{ customType: RUNNING_WORK_TYPE, content, display: false },
				{ triggerTurn: false, deliverAs: "followUp" },
			);
		} catch {
			// The session was replaced.
		}
	});
}

/**
 * Ids of the subagents whose reports wait for this session's start (`reports/pending`, saved or being delivered): they
 * did not stop without a report, it arrives as a message. Empty when there are none or they cannot be read.
 */
function pendingReportIds(sessionId: string): Set<string> {
	const ids = new Set<string>();
	try {
		const dir = pendingReportsDir(sessionId);
		for (const name of fs.readdirSync(dir)) {
			if (!name.endsWith(".json") && !name.includes(`.json${CLAIM_MARKER}`)) continue;
			try {
				const id: unknown = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))?.details?.id;
				if (typeof id === "string") ids.add(id);
			} catch {
				// Delivered (removed) meanwhile, or not a report.
			}
		}
	} catch {
		// No reports wait for this session.
	}
	return ids;
}

/** A subagent's session is named for its goal, unless it already has a name (a resumed one). */
function registerGoalName(api: ExtensionAPI, goal: string | undefined): void {
	const name = goal ? cleanTitle(goal, GOAL_NAME_MAX) : "";
	if (!name) return;
	api.on("session_start", async (_event, ctx) => {
		try {
			if (!ctx.sessionManager.getSessionName()) api.setSessionName(name, "goal");
		} catch {
			// The session was replaced: it keeps no goal name.
		}
	});
}

const GOAL_NAME_MAX = 200;

const hasUserMessage = (entries: readonly Entry[]) =>
	entries.some((entry) => entry.type === "message" && entry.message?.role === "user");

/**
 * The session extras (`sessions` table of the agent database), its retention sweep, `/resume` (`/sessions`)
 * and the resume brief shown when a saved session is resumed. Octocode owns the sessions themselves (files, names, first
 * messages). Database failures never break the session: the feature warns once and stays out of the way. Git runs off
 * the event loop, so a slow repository never stalls a turn.
 */
export function registerSessions(api: ExtensionAPI, options: SessionsOptions): void {
	registerRunningWork(api);
	if (options.isSubagent) {
		registerGoalName(api, options.goal);
		return;
	}
	let warned = false;
	/** A resumed session's record from before this start, briefed at the next prompt (not now: the user may come back later). */
	let pending: Omit<BriefInput, "git"> | undefined;
	/** This session's running cost and tokens, and whether part of it came from a model without pricing. */
	let usage = emptyUsage();
	const scan = new SpendScan();
	let unpriced = false;
	let gitRevision = 0;
	const index = () => new SessionIndex(sharedAgentDb());
	const titler = createAutoTitler(api, {
		...options.titleCall,
		enabled: () => api.getSettings().sessions?.autoTitle !== false,
	});
	const safely = (ctx: ExtensionContext, work: (sessions: SessionIndex) => void) => {
		try {
			work(index());
		} catch (error) {
			// A background git result can arrive after the host invalidates this
			// context. The optional warning must not turn that failure into a rejection.
			try {
				if (warned || !ctx.hasUI) return;
				warned = true;
				notify(ctx.ui, `Octocode session index unavailable: ${errorMessage(error)}`, "warning");
			} catch {
				// The UI context was replaced while the background work completed.
			}
		}
	};
	/** Records where git stands now, without waiting for it. */
	const recordGit = (ctx: ExtensionContext, id: string) => {
		const revision = ++gitRevision;
		return gitState(ctx.cwd).then((state) => {
			// A newer request or session shutdown makes this result stale, including its Octocode context.
			if (revision === gitRevision) safely(ctx, (sessions) => sessions.git(id, state));
		});
	};

	api.registerMessageRenderer(RESUME_MESSAGE_TYPE, (message, { expanded }, theme) => {
		const [head = "", ...rest] = sanitizeTerminalText(contentText(message.content)).split("\n");
		// Collapsed, the hidden lines get resultBlock's hint, so the brief reads as expandable like any tool row.
		const tail = !rest.length
			? ""
			: expanded
				? `\n  ${rest.join("\n  ")}`
				: ` … +${plural(rest.length, "line")} (${expandKey()} to expand)`;
		return new Text(theme.fg("dim", `↻ ${head}${tail}`), 1, 0);
	});

	api.on("session_start", async (event, ctx) => {
		gitRevision++;
		titler.cancel();
		pending = undefined;
		const id = ctx.sessionManager.getSessionId();
		const entries = (ctx.sessionManager.getEntries?.() ?? []) as readonly Entry[];
		({ usage, unpriced } = totals(entries, ctx.sessionManager.getHeader?.(), modelLookup(ctx), (scan.reset(), scan)));
		safely(ctx, (sessions) => {
			const previous = sessions.get(id);
			const resumed = event?.reason === "resume" || (event?.reason === "startup" && hasUserMessage(entries));
			const at = lastActive(entries);
			// Work the earlier process started and never reported: it stopped with that process (a crash, or a report lost).
			// A subagent whose report waits for this start is not one: its report is delivered as a message.
			const late = resumed ? pendingReportIds(id) : new Set<string>();
			const unreported = resumed
				? unreportedWork(branchOf(ctx))
						.filter((work) => work.kind !== "agent" || !late.has(work.id))
						.map((work) => describeWork(work))
				: [];
			if (resumed && at !== undefined) {
				const recorded = { branch: previous?.branch ?? null, head: previous?.head ?? null };
				const request = latestRequest(branchOf(ctx));
				pending = {
					previous: recorded,
					lastActive: at,
					sessionId: id,
					repoKey: repoKey(ctx.cwd).key,
					...(unreported.length > 0 ? { unreported } : {}),
					...(request ? { request } : {}),
				};
			}
			// The row keeps the dir its session runs from: the sweep keeps the session while that dir cannot be read.
			const sessionDir = ctx.sessionManager.getSessionDir?.();
			const dir = sessionDir ? path.resolve(sessionDir) : undefined;
			sessions.start(id, dir);
			recordSession(sessions, ctx.sessionManager);
			// Octocode's default listing misses sessions kept under --session-dir: the sweep must list that dir too, or it removes their folders.
			// Octocode's own listing covers every folder of `<agent dir>/sessions`; any other dir is recorded.
			if (dir && path.dirname(dir) !== path.join(getAgentDir(), "sessions")) sessions.addSessionDir(dir);
			// Off the start path; at most once per 6 h across all sessions.
			const env = { ...process.env };
			setImmediate(() => {
				void sweepSessions(sessions, currentSessionId(), { env });
				return undefined;
			});
		});
		void recordGit(ctx, id);
	});

	const add = (spend: Spend | undefined, ctx: ExtensionContext) => {
		if (!spend) return;
		addUsage(usage, spend.usage);
		unpriced ||= unpricedModel(spend, modelLookup(ctx)) !== undefined;
	};
	/** Spend recorded outside a reply (a compaction summary request, a cache refresh, a side question) since the last look. */
	const addRecorded = (ctx: ExtensionContext) => {
		for (const spend of scan.recorded(ctx.sessionManager.getEntries())) add(spend, ctx);
	};
	api.on("message_end", async (event, ctx) => {
		add(spendOf(event.message), ctx);
		return undefined;
	});
	api.on("session_compact", async (event, ctx) => {
		add(scan.entry(event.compactionEntry), ctx);
		addRecorded(ctx);
		return undefined;
	});
	api.on("session_tree", async (event, ctx) => {
		add(scan.entry(event.summaryEntry), ctx);
		return undefined;
	});

	api.on("before_agent_start", async (_event, ctx) => {
		if (!pending) return undefined;
		const input = pending;
		pending = undefined;
		const [now, dirty] = await Promise.all([gitState(ctx.cwd), gitDirty(ctx.cwd)]);
		const from = input.previous.head;
		const commitsSince =
			from && now.head && from !== now.head ? await gitCommitsBetween(ctx.cwd, from, now.head) : undefined;
		let content: string | undefined;
		safely(ctx, (sessions) => {
			content = resumeBrief(sessions.agent, {
				...input,
				git: { ...now, dirty, ...(commitsSince === undefined ? {} : { commitsSince }) },
			});
		});
		return content ? { message: { customType: RESUME_MESSAGE_TYPE, content, display: true } } : undefined;
	});

	api.on("agent_end", async (_event, ctx) => {
		addRecorded(ctx);
		const id = ctx.sessionManager.getSessionId();
		const stats = {
			cost: usage.cost.total,
			tokens: usage.totalTokens,
			filesChanged: options.filesChanged?.() ?? 0,
			unpriced,
		};
		safely(ctx, (sessions) => {
			sessions.stats(id, stats);
			recordSession(sessions, ctx.sessionManager);
		});
		void recordGit(ctx, id);
		// In the background: a turn never waits for its title.
		void titler.onAgentEnd(ctx);
	});

	// A session still unnamed when it is compacted gets one title from the summary's goal, in the background.
	api.on("session_compact", async (event, ctx) => {
		void titler.onCompact(ctx, event);
	});

	api.on("session_info_changed", async (event, ctx) => {
		safely(ctx, (sessions) => recordTitle(sessions, ctx.sessionManager, event.name, event.source));
	});

	api.on("session_shutdown", async (_event, ctx) => {
		gitRevision++;
		titler.cancel();
		safely(ctx, (sessions) => sessions.end(ctx.sessionManager.getSessionId()));
	});

	registerSessionsCommand(api, options.commands, { index, current: currentSessionId });
}
