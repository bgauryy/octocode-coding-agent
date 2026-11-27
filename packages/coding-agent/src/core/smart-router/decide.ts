import type { Api, AssistantMessage, Message, Model, ModelThinkingLevel } from "@octocodeai/octocode-ai";
import { effortCapacity, effortIndex, snapEffort } from "./effort.ts";
import { billingOf, hardReject, modelKey, type RequestNeeds } from "./filters.ts";
import { rankCandidates } from "./rank.ts";
import {
	assessComplexity,
	baseEffortIndex,
	classifyFailure,
	estimateInputTokens,
	hasPendingImage,
	requiredTier,
	tierOf,
} from "./signals.ts";
import { activeCooldowns, withCooldown } from "./state.ts";
import {
	type Candidate,
	type CandidateFacts,
	type FailureKind,
	MAX_NOTES,
	MAX_REJECTED_LISTED,
	type RouteExplanation,
	type RouteOutcome,
	type SmartRouterOptions,
	type SmartRouterState,
} from "./types.ts";

export interface DecisionInput {
	reason: "user" | "continuation" | "retry" | "direct";
	/** The thinking level selected for the virtual model: the effort ceiling. */
	thinkingLevel: ModelThinkingLevel;
	messages: readonly Message[];
	previous?: { model: Model<Api>; thinkingLevel?: ModelThinkingLevel };
	failed?: { model: Model<Api>; message: AssistantMessage };
	state: SmartRouterState;
	facts: readonly CandidateFacts[];
	options: SmartRouterOptions;
}

export interface Decision {
	model: Model<Api>;
	thinkingLevel: ModelThinkingLevel;
	state: SmartRouterState;
	explanation: RouteExplanation;
}

/** Raised when no model passes the hard filters. The message lists reasons and counts, never prompt content. */
export class SmartRouterError extends Error {
	readonly rejected: RouteExplanation["rejected"];

	constructor(message: string, rejected: RouteExplanation["rejected"]) {
		super(message);
		this.name = "SmartRouterError";
		this.rejected = rejected;
	}
}

const DEFAULT_COOLDOWN = 4;
const DEFAULT_OUTPUT_RESERVE = 8192;
const MARGIN = 1.15;
const OVERFLOW_MARGIN = 1.4;

function pushLimited<T>(list: T[], item: T, max: number): void {
	if (list.length < max) list.push(item);
}

/** Pure routing decision: same input, same output. */
export function decide(input: DecisionInput): Decision {
	const { options, facts } = input;
	const seq = input.state.seq + 1;
	const notes: string[] = [];
	const note = (text: string) => pushLimited(notes, text, MAX_NOTES);
	const ceiling = effortIndex(input.thinkingLevel);

	// Failure handling: one failed request updates cooldowns and the effort floor before candidates are filtered.
	let cooldowns = activeCooldowns(input.state.cooldowns, seq);
	let failures = input.reason === "retry" ? input.state.failures : 0;
	let failure: { model: string; kind: FailureKind } | undefined;
	if (input.reason === "retry" && input.failed) {
		const failedKey = modelKey(input.failed.model);
		const kind = classifyFailure(input.failed.message, input.failed.model.contextWindow);
		failure = { model: failedKey, kind };
		if (kind !== "aborted") failures++;
		const cooldown = options.cooldownRequests ?? DEFAULT_COOLDOWN;
		if (kind === "transient") cooldowns = withCooldown(cooldowns, { key: failedKey, until: seq + cooldown, kind });
		if (kind === "access") cooldowns = withCooldown(cooldowns, { key: failedKey, until: seq + cooldown * 4, kind });
		if (kind === "aborted") note("cancelled request is not held against the model");
	}

	const byKey = new Map(facts.map((fact) => [modelKey(fact.model), fact]));
	const previousKey = input.previous && modelKey(input.previous.model);
	const previousFacts = previousKey ? byKey.get(previousKey) : undefined;
	const usedPlan =
		input.state.usedPlan === true || (previousFacts !== undefined && billingOf(previousFacts) === "plan");
	const inputTokens = estimateInputTokens(input.messages);
	const needs: RequestNeeds = {
		image: hasPendingImage(input.messages),
		inputTokens,
		margin: failure?.kind === "context" ? OVERFLOW_MARGIN : MARGIN,
		outputReserve: options.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE,
		usedPlan,
	};

	// Hard filters never relax.
	const rejected: RouteExplanation["rejected"] = {};
	const verified: Candidate[] = [];
	const unverified: Candidate[] = [];
	for (const fact of facts) {
		const key = modelKey(fact.model);
		const verdict = hardReject(fact, options, needs);
		if ("reason" in verdict) {
			const entry = rejected[verdict.reason] ?? { count: 0, models: [] };
			rejected[verdict.reason] = entry;
			entry.count++;
			pushLimited(entry.models, key, MAX_REJECTED_LISTED);
			continue;
		}
		const candidate: Candidate = {
			...fact,
			key,
			billing: billingOf(fact),
			tier: tierOf(fact.model, key, options.tiers),
		};
		(verdict.unverified ? unverified : verified).push(candidate);
	}
	let pool = verified;
	if (pool.length === 0 && unverified.length > 0) {
		pool = unverified;
		note("context window unknown for every remaining model");
	}
	if (pool.length === 0) {
		const parts = Object.entries(rejected).map(([reason, entry]) => `${reason}: ${entry?.count}`);
		throw new SmartRouterError(
			`Smart routing found no usable model (${parts.join(", ") || "no models available"}).` +
				(rejected["plan-to-metered"] ? " Per-token models need allowPlanToMeteredEscalation." : ""),
			rejected,
		);
	}

	// Cooldowns are soft: with nothing else to run, the best cooled-down model is better than failing.
	const cooled = new Set(cooldowns.map((cooldown) => cooldown.key));
	let open = pool.filter((candidate) => !cooled.has(candidate.key));
	if (open.length === 0) {
		open = pool;
		note("all candidates cooling down; cooldowns relaxed");
	}

	const complexity = assessComplexity(input.messages, failures);
	const required = requiredTier(complexity.level);
	const rank = (list: readonly Candidate[]) => rankCandidates(list, required, inputTokens, options);
	const sticky =
		input.state.sticky ??
		(input.previous && previousKey
			? { key: previousKey, effort: input.previous.thinkingLevel ?? ("off" as const) }
			: undefined);
	const current = sticky && open.find((candidate) => candidate.key === sticky.key);

	const baseWanted = (candidate: Candidate) =>
		baseEffortIndex(complexity.level) + Math.max(0, required - candidate.tier);
	let chosen: Candidate;
	let wanted: number;
	let outcome: RouteOutcome;
	if (current && sticky) {
		wanted = baseWanted(current);
		if (input.reason !== "user") wanted = Math.max(wanted, effortIndex(sticky.effort));
		const quality = failure?.kind === "quality";
		if (quality) wanted = Math.max(wanted, effortIndex(sticky.effort) + 1);
		const capacity = effortCapacity(current.model, ceiling);
		// Effort is raised before the model changes; only a real need (weak tier, quality failure) leaves the model.
		const needsMore = (quality || current.tier < required) && wanted > capacity;
		if (!needsMore || !stronger(open, current).length) {
			chosen = current;
			if (needsMore) note("effort exhausted and no stronger model is available");
			outcome = wanted > effortIndex(sticky.effort) && wanted > 0 ? "effort-raised" : "sticky";
		} else {
			// Effort headroom is used up: move to the best stronger model.
			chosen = rank(stronger(open, current))[0];
			wanted = baseWanted(chosen);
			outcome = "model-switched";
		}
	} else {
		chosen = rank(open)[0];
		wanted = baseWanted(chosen);
		outcome = sticky ? "failover" : "selected";
		if (sticky && !current) note("previous model is not usable now");
	}
	const effort = snapEffort(chosen.model, wanted, effortCapacity(chosen.model, ceiling));
	const explanation: RouteExplanation = {
		outcome,
		reason: input.reason,
		selected: chosen.key,
		effort,
		complexity,
		requiredTier: required,
		selectedTier: chosen.tier,
		billing: chosen.billing,
		estimatedInputTokens: inputTokens,
		candidates: pool.length,
		rejected,
		failure,
		notes,
	};
	const state: SmartRouterState = {
		v: 1,
		seq,
		sticky: { key: chosen.key, effort },
		usedPlan: usedPlan || chosen.billing === "plan" ? true : undefined,
		failures,
		cooldowns,
		last: explanation,
	};
	return { model: chosen.model, thinkingLevel: effort, state, explanation };
}

function stronger(open: readonly Candidate[], current: Candidate): Candidate[] {
	return open.filter((candidate) => candidate.tier > current.tier);
}
