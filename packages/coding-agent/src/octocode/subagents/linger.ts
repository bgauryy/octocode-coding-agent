import type { ExtensionContext } from "../../core/extensions/index.ts";
import type { Permission } from "../permission/ask.ts";
import { USER_SENDER } from "../shared/messages.ts";
import type { ReportStatus } from "../instructions/report.ts";
import { type AgentRuns, claimRun, maxSubagents, reachableSeconds, type Run, subagentLimitError } from "./claim.ts";
import { askSpawn } from "./profiles.ts";

/**
 * Finished background runs that stay reachable: a message from the parent or the user resumes their saved conversation
 * as a new background run. Every run does for `OCTOCODE_SUBAGENT_LINGER_SECONDS`; a run that reported `blocked` does for
 * at least `BLOCKED_LINGER_SECONDS` even when that is 0, because it waits for an answer.
 */

interface LingeringRun {
	until: number;
	run: Run;
	ctx: ExtensionContext;
	timer?: NodeJS.Timeout;
}

/** The message a resumed run starts with, and the text the user or parent sent. */
interface Resumption {
	text: string;
	message: string;
}

export class Lingering {
	private readonly entries = new Map<string, LingeringRun>();
	private readonly resuming = new Set<string>();

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
	) {
		this.runs = runs;
		this.permission = permission;
		this.launchSignal = launchSignal;
		this.start = start;
	}

	/** Ends a run's window; whether it was lingering. */
	forget(id: string): boolean {
		clearTimeout(this.entries.get(id)?.timer);
		return this.entries.delete(id);
	}

	forgetAll(): void {
		for (const id of Array.from(this.entries.keys())) this.forget(id);
	}

	/** Called when the run reported (with its outcome): it stays reachable for the window, and the report says so. */
	window(run: Run, ctx: ExtensionContext): (outcome?: ReportStatus) => string {
		const session = this.runs.session;
		return (outcome?: ReportStatus): string => {
			const seconds = reachableSeconds(outcome);
			if (session !== this.runs.session || seconds === 0) return "";
			const id = run.identity.id;
			this.forget(id);
			const entry: LingeringRun = { until: Date.now() + seconds * 1000, run, ctx };
			this.entries.set(id, entry);
			// Release the saved context when the window ends, even if nobody messages this name again.
			const expire = () => {
				const remaining = entry.until - Date.now();
				if (remaining <= 0) {
					this.forget(id);
					return;
				}
				entry.timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
				entry.timer.unref();
			};
			expire();
			const stop = `type \`coordinate\` with action \`stop\` and id ${id} ends that`;
			if (outcome === "blocked")
				return `\n\n${id} is blocked and stays resumable for ${seconds} s: answer it with \`agent\` type \`message\` to ${id} and it continues this conversation; ${stop}.`;
			return `\n\n${id} stays reachable for ${seconds} s: \`agent\` type \`message\` to it continues this conversation; ${stop}.`;
		};
	}

	/** A message to a lingering run, from its parent or the user, resumes it in the background; undefined when it does not linger. */
	async resume(id: string, text: string, from: string, signal?: AbortSignal): Promise<string | undefined> {
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
		try {
			const grants = await askSpawn(
				permission,
				ctx,
				last.profile,
				text,
				launchSignal,
				runs.pi.getSettings().defaultTools,
				{ goal: last.identity.goal },
			);
			launchSignal.throwIfAborted();
			if (this.entries.get(id) !== prior) throw new Error(`Subagent ${id} is no longer available to resume.`);
			// Keep the saved conversation and model, but renew authorization from the parent's current policy.
			const identity = {
				...last.identity,
				relay: ctx.hasUI,
				permission: { mode: permission.mode, grants: [...new Set([...grants, ...permission.childGrants()])] },
			};
			run = claimRun(runs, last, { goal: last.identity.goal }, ctx, [], identity);
			this.start(run, ctx, {
				text,
				message: `Follow-up from ${from === USER_SENDER ? "the user" : "your parent"}:\n${text}`,
			});
			this.forget(id);
		} catch (error) {
			if (run) run.release();
			else runs.slots.give();
			throw error;
		} finally {
			this.resuming.delete(id);
		}
		return `Resumed ${id} with your message; its reply arrives as a background report.`;
	}
}
