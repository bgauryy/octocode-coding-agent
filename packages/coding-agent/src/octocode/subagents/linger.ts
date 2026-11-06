import { renderInstruction } from "../../core/prompt-template.ts";
import type { ExtensionContext } from "../../core/features/index.ts";
import type { Permission } from "../permission/ask.ts";
import { getMcpSessionHandoff } from "../../../../mcp/src/session-servers.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { USER_SENDER } from "../shared/messages.ts";
import { messageText } from "../team/routing.ts";
import type { ResumeRequest } from "../team/session/send.ts";
import type { ReportStatus } from "../instructions/report.ts";
import { type AgentRuns, claimRun, maxSubagents, reachableSeconds, type Run, subagentLimitError } from "./claim.ts";
import { askSpawn, profileSelectsBrowser } from "./profiles.ts";
import { allParked, readParked, writeParked, type ParkedWorker } from "./parked.ts";
import type { AgentProfile } from "./profiles.ts";
import { childSession, childSessionFile } from "./process/session.ts";
import { retakeReservation } from "./reservation.ts";

/**
 * Finished background runs that stay reachable: a message from the parent or the user resumes their saved conversation
 * as a new background run. A sibling's message reaches it through the parent process (`team/relay.ts`), which asks
 * for the resume itself, so it passes the same check and permission prompt. Every run does for its profile's `linger` seconds, else `OCTOCODE_SUBAGENT_LINGER_SECONDS`; a run that reported `blocked`
 * or ended with an unanswered `replyRequired` message to its parent or a peer does for at least `BLOCKED_LINGER_SECONDS`
 * even when that is 0, because it waits for an answer.
 */

/** Whom a finished run's unanswered `replyRequired` asks wait on: its parent, or only other agents. */
export type AwaitedReply = "parent" | "peer";

interface LingeringRun {
	until: number;
	generation: number;
	run: Run;
	ctx: ExtensionContext;
	timer?: NodeJS.Timeout;
}

/** The message a resumed run starts with, and the text the user or parent sent. */
interface Resumption {
	text: string;
	message: string;
}

/**
 * An identity without the MCP servers the model added: their configs may hold credentials, so they are never written to
 * the parked record, and a resumed run takes the session's current ones. The skill snapshot stays: a resumed child keeps
 * the inventory it was given.
 */
function withoutServers(identity: Run["identity"]): Run["identity"] {
	const { mcpServers: _servers, mcpStopped: _stopped, ...rest } = identity;
	return rest;
}

/** A per-call browser mode is the one permitted change to the loaded profile; all other drift retires the address. */
function sameProfile(current: AgentProfile | undefined, saved: AgentProfile): boolean {
	if (!current) return false;
	if (JSON.stringify(current) === JSON.stringify(saved)) return true;
	if (typeof saved.headless !== "boolean" || !profileSelectsBrowser(current)) return false;
	const { headless: _currentHeadless, ...currentBase } = current;
	const { headless: _savedHeadless, ...savedBase } = saved;
	return JSON.stringify(currentBase) === JSON.stringify(savedBase);
}

export class Lingering {
	/** Every session's live follow-up windows, for what must not remove a folder they work in. */
	static readonly parkedChildren = allParked;
	private readonly entries = new Map<string, LingeringRun>();
	private readonly resuming = new Set<string>();
	private readonly generations = new Map<string, number>();
	private readonly profiles: () => Map<string, AgentProfile>;
	private sessionId: string | undefined;
	/** The latest context, for telling the user a parked-record write failed; the warning is given once until a write succeeds. */
	private notifier: ExtensionContext | undefined;
	private persistWarned = false;

	/**
	 * `launchSignal` joins the caller's signal with the one a permission change or shutdown aborts. `start` begins the
	 * resumed run in the background (and hands `window` back as its linger hook); a throw there releases the run.
	 */
	readonly permission: Permission;
	private readonly runs: AgentRuns;
	private readonly launchSignal: (signal?: AbortSignal) => AbortSignal;
	private readonly start: (run: Run, ctx: ExtensionContext, resumption: Resumption) => void;
	constructor(
		runs: AgentRuns,
		permission: Permission,
		launchSignal: (signal?: AbortSignal) => AbortSignal,
		start: (run: Run, ctx: ExtensionContext, resumption: Resumption) => void,
		profiles: () => Map<string, AgentProfile>,
	) {
		this.runs = runs;
		this.permission = permission;
		this.launchSignal = launchSignal;
		this.start = start;
		this.profiles = profiles;
	}

	/** A session reopen restores addresses only; no worker executes until a direct authorized follow-up. */
	reopen(ctx: ExtensionContext): void {
		this.close();
		const session = ctx.sessionManager.getSessionId();
		this.sessionId = session;
		this.notifier = ctx;
		const profiles = this.profiles();
		const savedWorkers = readParked(session, ctx.cwd);
		if (savedWorkers.length === 0) return;
		let parentId: string;
		try {
			parentId = this.runs.team.join().id;
		} catch {
			return;
		}
		for (const saved of savedWorkers) {
			const { run } = saved;
			const current = run.profile?.name ? profiles.get(run.profile.name) : undefined;
			if (run.profile && !sameProfile(current, run.profile)) continue;
			const restored: Run = {
				...run,
				identity: { ...run.identity, parentId },
				release: () => undefined,
			};
			this.generations.set(restored.identity.id, saved.generation);
			this.hold({ ...saved, run: restored, ctx });
			this.runs.team.rememberFinished(restored.identity.id, "its earlier report reached this session.");
		}
		this.persist();
	}

	/**
	 * Saves the parked addresses. Best effort: a failed write (a full disk, a read-only or symlinked folder) is told
	 * once and never thrown, because callers run inside a report or a timer; the in-memory windows still work.
	 */
	private persist(): void {
		if (!this.sessionId) return;
		try {
			writeParked(
				this.sessionId,
				[...this.entries.values()].map(({ run, until, generation, ctx }): ParkedWorker => ({
					until,
					generation,
					workspace: ctx.cwd,
					run: {
						identity: withoutServers(run.identity),
						profile: run.profile,
						route: run.route,
						teamNote: run.teamNote,
					},
				})),
			);
			this.persistWarned = false;
		} catch (error) {
			if (this.persistWarned) return;
			this.persistWarned = true;
			try {
				this.notifier?.ui.notify(
					`Subagent follow-up windows are kept in memory only: saving them failed (${errorMessage(error)}).`,
					"warning",
				);
			} catch {
				// Nothing more to tell: the windows still work in this session.
			}
		}
	}

	private hold(entry: LingeringRun): void {
		const id = entry.run.identity.id;
		this.entries.set(id, entry);
		const expire = () => {
			const remaining = entry.until - Date.now();
			if (remaining <= 0) {
				if (this.entries.get(id) === entry) this.forget(id);
				return;
			}
			entry.timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
			entry.timer.unref();
		};
		expire();
	}

	/** Ends a run's window; whether it was lingering. */
	forget(id: string): boolean {
		clearTimeout(this.entries.get(id)?.timer);
		const removed = this.entries.delete(id);
		if (removed) this.persist();
		return removed;
	}

	/** Shutdown detaches in-memory contexts but preserves parked addresses for this same session to reopen. */
	close(): void {
		for (const entry of this.entries.values()) clearTimeout(entry.timer);
		this.entries.clear();
		this.sessionId = undefined;
	}

	/** Called when the run reported (with its outcome): it stays reachable for the window, and the report says so. */
	window(run: Run, ctx: ExtensionContext): (outcome?: ReportStatus, awaited?: AwaitedReply) => string {
		const session = this.runs.session;
		return (outcome?: ReportStatus, awaited?: AwaitedReply): string => {
			const seconds = reachableSeconds(outcome, process.env, run.profile?.linger, awaited !== undefined);
			if (session !== this.runs.session || seconds === 0) return "";
			this.sessionId ??= ctx.sessionManager.getSessionId();
			this.notifier = ctx;
			const id = run.identity.id;
			this.forget(id);
			const generation = (this.generations.get(id) ?? 0) + 1;
			this.generations.set(id, generation);
			const entry: LingeringRun = { until: Date.now() + seconds * 1000, generation, run, ctx };
			this.hold(entry);
			this.persist();
			const blocked = outcome === "blocked";
			const peer = !blocked && awaited === "peer";
			const parent = !blocked && awaited === "parent";
			const note = renderInstruction("notices/subagents/lingering.md", {
				id,
				seconds,
				blocked,
				peer,
				parent,
				reachable: !blocked && !peer && !parent,
			});
			return `\n\n${note}`;
		};
	}

	/**
	 * A message to a lingering run, from its parent or the user, resumes it in the background; undefined when it does not
	 * linger. With `request`, the run starts with the stored message framed as delivered mail (`messageText`: its id, its
	 * original sender, and the fence for anyone but the user); `from` is who asks, `request.message.from` who wrote it.
	 */
	async resume(
		id: string,
		text: string,
		from: string,
		signal?: AbortSignal,
		request?: ResumeRequest,
	): Promise<string | undefined> {
		const { runs, permission } = this;
		const prior = this.entries.get(id);
		if (!prior || (from !== prior.run.identity.parentId && from !== USER_SENDER)) return undefined;
		if (Date.now() >= prior.until) {
			this.forget(id);
			return undefined;
		}
		if (this.resuming.has(id)) throw new Error(`${id} is already awaiting permission to resume.`);
		const launchSignal = this.launchSignal(signal);
		launchSignal.throwIfAborted();
		const { run: last, ctx } = prior;
		// A message is answered now: over the limit it is refused, not left waiting for a slot.
		if (!runs.slots.tryTake()) throw new Error(subagentLimitError(runs.running.keys(), maxSubagents()));
		this.resuming.add(id);
		let run: Run | undefined;
		let retaken = "";
		try {
			const author = request?.message.from;
			// A relayed or forwarded message is named in the prompt: the user approves a resume nobody typed here.
			const asked =
				author !== undefined && author !== from ? `Message from ${author}, passed on by ${from}:\n${text}` : text;
			const grants = await askSpawn(
				permission,
				ctx,
				last.profile,
				asked,
				launchSignal,
				runs.api.getSettings().defaultTools,
				{ goal: last.identity.goal },
			);
			launchSignal.throwIfAborted();
			if (this.entries.get(id) !== prior || this.generations.get(id) !== prior.generation || Date.now() >= prior.until)
				throw new Error(`Subagent ${id} is no longer available to resume.`);
			if (!childSessionFile(childSession(last.identity), true))
				throw new Error(`Subagent ${id} cannot resume: its saved transcript is missing. Start a new task instead.`);
			// Keep the saved conversation, model and skill inventory, but renew authorization from the parent's current policy,
			// and take the session's current MCP servers, as a new run would.
			const handoff = getMcpSessionHandoff(runs.api.events);
			const { stopped } = handoff;
			// A child whose task named its servers keeps that list: the session's added servers outside it stay out.
			const only = last.identity.mcpOnly;
			const servers = only
				? Object.fromEntries(Object.entries(handoff.servers).filter(([name]) => only.includes(name)))
				: handoff.servers;
			const identity = {
				...withoutServers(last.identity),
				...(Object.keys(servers).length > 0 ? { mcpServers: servers } : {}),
				...(stopped.length > 0 ? { mcpStopped: stopped } : {}),
				// A relay's author is a peer; the parent's own forward of one is still the parent's decision.
				peerResumed: author !== undefined && author !== from && request?.message.forwardedBy !== from,
				relay: ctx.hasUI,
				permission: { mode: permission.mode, grants: [...new Set([...grants, ...permission.childGrants()])] },
			};
			run = claimRun(runs, last, { goal: last.identity.goal }, ctx, [], identity);
			retaken = retakeReservation(runs.team, run);
			// Retire the parked address before launching. A crash here never auto-replays uncertain execution.
			this.forget(id);
			runs.reports.supersede(id);
			this.start(run, ctx, {
				text,
				message: request
					? messageText(request.message, {
							parentId: last.identity.parentId,
							// The user's own message, created in this process for this resume; a relayed or forwarded one never is.
							fromUser: from === USER_SENDER && request.message.from === USER_SENDER && !request.message.forwardedBy,
						})
					: `Follow-up from ${from === USER_SENDER ? "the user" : "your coordinator"}:\n${text}`,
			});
		} catch (error) {
			if (run) run.release();
			else runs.slots.give();
			throw error;
		} finally {
			this.resuming.delete(id);
		}
		return `Resumed ${id} with your message; its reply arrives as a background report.${retaken}`;
	}
}
