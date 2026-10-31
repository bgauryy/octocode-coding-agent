import { envInt } from "../../../../common/src/env.ts";
import type { AgentProfile } from "./profiles.ts";
import { type ResultContract, unavailableResult } from "./result-schema.ts";
import type { SubagentOutcome } from "./process/outcome.ts";
import type { RunDetails } from "./run-types.ts";
import { stopFacts } from "./stop-facts.ts";
import type { Team } from "../team/session.ts";
import type { Usage } from "@octocodeai/octocode-ai";

/**
 * A subagent task's request budget: how many model requests the child may make before the parent asks it to wrap up (the
 * soft limit) and, past `HARD_LIMIT_FACTOR` times that, stops it. The parent counts one request per assistant reply
 * (`reduceEvent`); a compaction summary is not a reply. Resuming the same child continues its saved request count.
 */

export const MAX_REQUESTS_ENV = "OCTOCODE_SUBAGENT_MAX_REQUESTS";

/**
 * The soft limit when neither the profile nor the environment sets one. In 154 measured subagent runs
 * (2026-10-26: p50 40, p95 120, p99 219, max 236 requests), the steer reached about 4% of runs and the hard limit (240)
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

/** What the parent tells a child that reached its soft limit. */
export const steerMessage = (used: number, soft: number): string =>
	`You have used ${used} of ${soft} model requests. Finish now: report what is done, what is partial, and the next step.`;

/**
 * Applies the budget to a child's replies: one steer at the soft limit, one stop at the hard limit. Both only while the
 * reply asked for tools (the child goes on); a final answer needs neither.
 */
export class RequestBudget {
	private steered = false;
	private stoppedAt: number | undefined;
	private readonly soft: number;
	private readonly steer: (message: string) => void;
	private readonly stop: () => void;
	private readonly previous: number;

	constructor(soft: number, steer: (message: string) => void, stop: () => void, previous = 0) {
		this.soft = soft;
		this.steer = steer;
		this.stop = stop;
		this.previous = previous;
	}

	/** Whether the budget stopped the run; its request count. */
	get stopped(): number | undefined {
		return this.stoppedAt;
	}

	get limit(): number {
		return this.soft;
	}

	/** A resumed task already at its soft limit sees the wrap-up instruction before spending another request. */
	prompt(task: string): string {
		if (this.soft < 1 || this.previous < this.soft) return task;
		this.steered = true;
		return `${task}\n\n${steerMessage(this.previous, this.soft)}`;
	}

	/** A reply ended: `count` replies in this process; `continues`: it asked for tools. */
	onReply(count: number, continues: boolean): void {
		count += this.previous;
		if (this.soft < 1 || this.stoppedAt !== undefined || !continues) return;
		if (count >= hardLimit(this.soft)) {
			this.stoppedAt = count;
			this.stop();
		} else if (count >= this.soft && !this.steered) {
			this.steered = true;
			this.steer(steerMessage(count, this.soft));
		}
	}
}

/** The first line of a report from a run the budget stopped. */
export const budgetHeading = (requests: number, soft: number): string =>
	`partial: stopped at the model request budget (${requests} requests; limit ${soft}, hard limit ${hardLimit(soft)}).`;

/**
 * The outcome of a run the hard limit stopped: `partial`, led by a line naming the budget, then the child's last
 * progress. `unavailable` when the run has a result contract: a stopped child never delivered the result.
 */
export function budgetOutcome(
	requests: number,
	soft: number,
	lastProgress: string,
	usage: Usage,
	contract?: ResultContract,
): SubagentOutcome {
	const progress = lastProgress.trim();
	return {
		text: `${budgetHeading(requests, soft)}${progress ? `\nLast progress:\n${progress}` : ""}`,
		...(contract ? { structured: unavailableResult(contract) } : {}),
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
