import { renderPrompt } from "../../core/prompt-template.ts";
import { envInt } from "@octocodeai/octocode-common/env";
import type { AgentProfile } from "./profiles.ts";
import { type ResultContract, unavailableResult } from "./result-schema.ts";
import type { SubagentOutcome } from "./process/outcome.ts";
import type { RunDetails } from "./run-types.ts";
import { stopFacts } from "./stop-facts.ts";
import type { BudgetStanding } from "../team/model.ts";
import type { Team } from "../team/session.ts";
import type { Usage } from "@octocodeai/octocode-ai";

/**
 * A subagent task's request budget: how many model requests the child may make before the parent tells it where it stands
 * (the soft limit) and, past `HARD_LIMIT_FACTOR` times that, stops it. The parent counts one request per assistant reply
 * (`reduceEvent`); a compaction summary is not a reply. Resuming the same child continues its saved request count.
 * The child may ask for more; its parent can grant more to this run (`RunningBudgets`), and a resume at or past the soft
 * limit is itself a grant. Nothing waits for an answer: without one the child stops at the hard limit, as ever.
 */

export const MAX_REQUESTS_ENV = "OCTOCODE_SUBAGENT_MAX_REQUESTS";

/**
 * The soft limit when neither the profile nor the environment sets one. In 154 measured subagent runs
 * (p50 40, p95 120, p99 219, max 236 requests), the steer reached about 4% of runs and the hard limit (240)
 * exceeded the observed maximum. That historical sample is not a guarantee for future tasks. 0 turns the budget off.
 */
export const DEFAULT_MAX_REQUESTS = 160;

/** The hard limit, as a multiple of the soft limit. */
const HARD_LIMIT_FACTOR = 1.5;

export const hardLimit = (soft: number): number => Math.ceil(soft * HARD_LIMIT_FACTOR);

/**
 * The soft limit of a run: the profile's `maxRequests` (0 there turns the budget off for that profile), else
 * `OCTOCODE_SUBAGENT_MAX_REQUESTS` (a non-negative integer, 0 turning it off; anything else is ignored), else
 * `DEFAULT_MAX_REQUESTS`.
 */
export function maxRequests(profile?: Pick<AgentProfile, "maxRequests">, env: NodeJS.ProcessEnv = process.env): number {
	if (profile?.maxRequests !== undefined) return profile.maxRequests;
	const value = envInt(env, MAX_REQUESTS_ENV, DEFAULT_MAX_REQUESTS);
	return value >= 0 ? value : DEFAULT_MAX_REQUESTS;
}

/**
 * The soft limit of one task: its own `maxRequests` (`cap`), which may only lower its profile's limit (`maxRequests`;
 * any cap lowers a budget that is off), else that limit. The hard limit scales with it (`hardLimit`). Throws the
 * refusal, naming that limit, for a cap that is not a positive integer or is above it.
 */
export function taskRequestLimit(
	profile: Pick<AgentProfile, "name" | "maxRequests"> | undefined,
	cap: unknown,
	env: NodeJS.ProcessEnv = process.env,
): number {
	const limit = maxRequests(profile, env);
	if (cap === undefined) return limit;
	if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1)
		throw new Error(`maxRequests must be a positive integer, not ${JSON.stringify(cap)}.`);
	if (limit > 0 && cap > limit)
		throw new Error(
			`maxRequests ${cap} is above ${profile ? `the ${profile.name} profile's` : "the default"} limit of ${limit} requests: pass at most ${limit}, or omit it.`,
		);
	return cap;
}

/**
 * What the parent tells a child that reached its soft limit. `ask`: the parent can answer during this run, so the child
 * may ask it for more; else (a foreground run, or no team) it can only say so in its report. `continued`: a resumed task.
 */
export const steerMessage = (
	used: number,
	soft: number,
	hard: number = hardLimit(soft),
	options: { continued?: boolean; ask?: boolean } = {},
): string =>
	renderPrompt("notices/subagents/budget-steer.md", {
		used,
		soft,
		hard,
		left: Math.max(0, hard - used),
		continued: options.continued === true,
		ask: options.ask === true,
	});

/** What the parent tells a child at the hard limit: its next request has no tools, so it answers. */
export const finalMessage = (hard: number): string => renderPrompt("notices/subagents/budget-final.md", { hard });

/**
 * Applies the budget to a child's replies: one steer at the soft limit, one stop at the hard limit. Both only while the
 * reply asked for tools (the child goes on); a final answer needs neither. `canAsk`: the steer may tell the child to ask its
 * parent. `resumeIsGrant`: a run resumed at or past the soft limit starts a whole allowance from there; false (a peer's
 * relayed message, which no parent decided) leaves it within the limits it had.
 */
export class RequestBudget {
	private steered = false;
	private stoppedAt: number | undefined;
	private soft: number;
	private hard: number;
	/** Replies so far, saved ones included. */
	private used: number;
	/** The requests a resume from the hard limit gets. */
	private readonly allowance: number;
	private readonly steer: (message: string) => void;
	private readonly stop: () => void;
	/** Gives the child one last request without tools; without it the hard limit stops the run at once. */
	private readonly final: ((message: string) => void) | undefined;
	private finalGiven = false;
	private stopRequested = false;
	private readonly previous: number;
	private readonly canAsk: boolean;
	/** This run continues a child that was at or past its soft limit. */
	private readonly continued: boolean;

	constructor(
		soft: number,
		steer: (message: string) => void,
		stop: () => void,
		previous = 0,
		{
			canAsk = true,
			resumeIsGrant = true,
			final,
		}: { canAsk?: boolean; resumeIsGrant?: boolean; final?: (message: string) => void } = {},
	) {
		this.final = final;
		this.allowance = soft < 1 ? 0 : hardLimit(soft);
		this.continued = soft >= 1 && previous >= soft;
		const start = this.continued && resumeIsGrant ? previous : 0;
		this.soft = soft < 1 ? 0 : soft + start;
		this.hard = this.allowance + start;
		this.steer = steer;
		this.stop = stop;
		this.previous = previous;
		this.used = previous;
		this.canAsk = canAsk;
		// Without a grant the run is past its soft limit already: the resume's own text is all it is told.
		this.steered = this.continued && !resumeIsGrant;
	}

	/** Whether the budget stopped the run; its request count. */
	get stopped(): number | undefined {
		return this.stoppedAt;
	}

	/** The limits a report names, and what a resume from them would get. */
	get limits(): { soft: number; hard: number; allowance: number } {
		return { soft: this.soft, hard: this.hard, allowance: this.allowance };
	}

	/** Where the child stands; undefined when the budget is off. */
	get usage(): BudgetStanding | undefined {
		return this.soft < 1 ? undefined : { used: this.used, soft: this.soft, hard: this.hard };
	}

	/** A task resumed at or past the soft limit is told where its run stops: its parent asked for this work, so it does it. */
	prompt(task: string): string {
		if (!this.continued) return task;
		return `${task}\n\n${steerMessage(this.previous, this.soft, this.hard, { continued: true })}`;
	}

	/** Adds `requests` to both limits of this run. A new soft limit still ahead gets its own steer, so the child can ask again. */
	grant(requests: number): BudgetStanding | undefined {
		if (this.soft < 1 || this.stoppedAt !== undefined) return undefined;
		this.soft += requests;
		this.hard += requests;
		if (this.used < this.soft) this.steered = false;
		return this.usage;
	}

	/** A reply ended: `count` replies in this process; `continues`: it asked for tools. */
	onReply(count: number, continues: boolean): void {
		this.used = count + this.previous;
		if (this.soft < 1) return;
		// Past the final turn: a provider that kept the tools may still be asking for them, and the run ends here.
		if (this.stoppedAt !== undefined) {
			if (continues && this.finalGiven && !this.stopRequested) {
				this.stopRequested = true;
				this.stop();
			}
			return;
		}
		if (!continues) return;
		if (this.used >= this.hard) {
			this.stoppedAt = this.used;
			if (this.final) {
				this.finalGiven = true;
				this.final(finalMessage(this.hard));
			} else this.stop();
		} else if (this.used >= this.soft && !this.steered) {
			this.steered = true;
			this.steer(steerMessage(this.used, this.soft, this.hard, { ask: this.canAsk }));
		}
	}
}

/**
 * The budgets of the children running now, by id: one per registration of the `agent` tool, so a parent reaches only the
 * children it started. A run leaves as soon as it is over or stopping, and a grant then has nothing to raise.
 */
export class RunningBudgets {
	private readonly running = new Map<string, RequestBudget>();
	/** What each running child has cost so far, in dollars, read when asked. */
	private readonly costs = new Map<string, () => number>();

	add(id: string, budget: RequestBudget, cost?: () => number): void {
		this.running.set(id, budget);
		if (cost) this.costs.set(id, cost);
		else this.costs.delete(id);
	}

	remove(id: string, budget: RequestBudget): void {
		if (this.running.get(id) !== budget) return;
		this.running.delete(id);
		this.costs.delete(id);
	}

	/** What running child `id` has cost so far in this run; undefined when it is not running or nothing counts it. */
	cost(id: string): number | undefined {
		return this.running.has(id) ? this.costs.get(id)?.() : undefined;
	}

	usage(id: string): BudgetStanding | undefined {
		return this.running.get(id)?.usage;
	}

	/** Adds `requests` to child `id`'s limits for this run; the new standing, or the refusal. */
	grant(id: string, requests: number): BudgetStanding | string {
		const budget = this.running.get(id);
		if (!budget) {
			const ids = [...this.running.keys()];
			return `${id} is not running as a subagent you started: it has not started yet, or it finished or was stopped. A grant raises a running child; continue a finished one with \`agent\` type \`task\` and \`resume: ${id}\`. Running: ${ids.join(", ") || "none"}.`;
		}
		if (!budget.usage) return `${id} has no request limit: its budget is off, so there is nothing to raise.`;
		return (
			budget.grant(requests) ??
			`${id} is not running: the budget has just stopped it. Continue it with \`agent\` type \`task\` and \`resume: ${id}\`.`
		);
	}
}

/** The first line of a report from a run the budget stopped. */
export const budgetHeading = (requests: number, soft: number, hard: number = hardLimit(soft)): string =>
	renderPrompt("notices/subagents/budget-stop.md", {
		outcome: "partial",
		requests,
		soft,
		hard,
	});

/** The child a budget stop reports on: who to resume, whether it can be, and the result it never delivered. */
export interface BudgetChild {
	id: string;
	isolation?: unknown;
	resultContract?: ResultContract;
}

/**
 * The outcome of a run the hard limit stopped: `partial`, led by a line naming the budget and one saying how to continue
 * the child, then its last progress. `unavailable` when the run has a result contract: a stopped child never delivered
 * the result. Nothing is lost by the stop: the work and the transcript stay, and a resume picks them up.
 */
export function budgetOutcome(
	requests: number,
	limits: { soft: number; hard: number; allowance: number },
	child: BudgetChild,
	lastProgress: string,
	usage: Usage,
): SubagentOutcome {
	const progress = lastProgress.trim();
	const next = renderPrompt("notices/subagents/budget-continue.md", {
		id: child.id,
		isolated: child.isolation !== undefined,
		allowance: limits.allowance,
	});
	const { soft, hard } = limits;
	return {
		text: `${budgetHeading(requests, soft, hard)}\n${next}${progress ? `\nLast progress:\n${progress}` : ""}`,
		...(child.resultContract ? { structured: unavailableResult(child.resultContract) } : {}),
		usage,
		outcome: "partial",
		outcomeSource: "first",
		budget: { requests, limit: soft },
	};
}

/** A budget-stopped outcome with the stop facts (last activity, changed files) its report carries; any other outcome unchanged. */
export function withStopFacts(
	outcome: SubagentOutcome,
	details: RunDetails,
	team: Pick<Team, "editLog">,
): SubagentOutcome {
	return outcome.budget ? { ...outcome, text: `${outcome.text}${stopFacts(details, team)}` } : outcome;
}
