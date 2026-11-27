import type { Api, Model, ModelThinkingLevel, ProviderPlan } from "@octocodeai/octocode-ai";

/** `provider/id`, with `*` matching any run of characters (for example `openai/*` or `openai/gpt-5*`). */
export type ModelPattern = string;

/** Capability tier: 1 light, 2 general, 3 frontier. */
export type CapabilityTier = 1 | 2 | 3;

/** Measured behavior of one model, supplied by the host. Every field is optional; absent means unknown. */
export interface ModelStatistics {
	/** Fraction of requests that finished without an error, 0..1. */
	successRate?: number;
	/** Requests behind `successRate`; a rate with few samples is not trusted. */
	samples?: number;
	/** Median time to the full response, in milliseconds. */
	medianLatencyMs?: number;
	/** Observed cost of an average request in USD; replaces the price-derived estimate. */
	costPerRequestUsd?: number;
}

type StatisticsSource = (model: Model<Api>) => ModelStatistics | undefined;

export interface SmartRouterOptions {
	/** Provider the virtual model is listed under. Default `octocode`. */
	provider?: string;
	/** Default `auto-code`. */
	id?: string;
	name?: string;
	/** Thinking levels offered for selection; the selected level caps the effort the router uses. */
	thinkingLevels?: readonly ModelThinkingLevel[];
	/** Only these models may be chosen. Empty or absent: every available model. */
	allow?: readonly ModelPattern[];
	/** These models are never chosen. Deny wins over allow. */
	deny?: readonly ModelPattern[];
	/** Capability tier per model, replacing the tier derived from catalog metadata. The first matching pattern wins. */
	tiers?: Readonly<Record<ModelPattern, CapabilityTier>>;
	/**
	 * Whether a session that already ran on a flat-rate plan may move to a per-token model. Default false: the
	 * router fails the request instead of silently spending money.
	 */
	allowPlanToMeteredEscalation?: boolean;
	/** Exclude per-token models altogether. Default false. */
	planOnly?: boolean;
	/** The run has no interactive user: skip plans that forbid unattended use. Default false. */
	unattended?: boolean;
	/** Supplies measured reliability, latency and cost. Called synchronously once per candidate per request. */
	statistics?: StatisticsSource;
	/** Requests a failed model sits out. Default 4. */
	cooldownRequests?: number;
	/** Tokens kept free for the answer when checking context room. Default 8192, capped by the model's `maxTokens`. */
	outputReserveTokens?: number;
	/** Receives each route explanation. It never contains prompt content. */
	onDecision?: (explanation: RouteExplanation) => void;
}

/** Why a candidate was dropped. */
export type RejectionReason =
	| "not-allowed"
	| "denied"
	| "no-credentials"
	| "provider-disabled"
	| "plan-disabled"
	| "hidden"
	| "deprecated"
	| "access-rejected"
	| "modality"
	| "context"
	| "plan-external-only"
	| "plan-unattended"
	| "plan-only"
	| "plan-to-metered";

export type Billing = "plan" | "metered";

/** What the runtime knows about one catalog model. Built by the host adapter, read by the pure filters. */
export interface CandidateFacts {
	model: Model<Api>;
	configured: boolean;
	providerDisabled: boolean;
	hidden: boolean;
	deprecated: boolean;
	accessRejected: boolean;
	plan?: ProviderPlan;
}

export interface Candidate extends CandidateFacts {
	key: string;
	billing: Billing;
	tier: CapabilityTier;
}

export type FailureKind = "context" | "transient" | "access" | "quality" | "aborted";

/** A model that failed recently. `until` counts routed requests (`State.seq`), not time. */
export interface Cooldown {
	key: string;
	until: number;
	kind: FailureKind;
}

/** Router state stored on the session branch. JSON, bounded by `MAX_COOLDOWNS`. */
export interface SmartRouterState {
	v: 1;
	/** Routed requests so far on this branch. */
	seq: number;
	sticky?: { key: string; effort: ModelThinkingLevel };
	/** The session has used a flat-rate plan model. */
	usedPlan?: boolean;
	/** Failed requests in a row. */
	failures: number;
	cooldowns: Cooldown[];
	last?: RouteExplanation;
}

export type RouteOutcome = "sticky" | "selected" | "effort-raised" | "model-switched" | "failover";

export interface RouteExplanation {
	outcome: RouteOutcome;
	reason: string;
	selected: string;
	effort: ModelThinkingLevel;
	complexity: { level: 0 | 1 | 2 | 3; signals: string[] };
	requiredTier: CapabilityTier;
	selectedTier: CapabilityTier;
	billing: Billing;
	estimatedInputTokens: number;
	candidates: number;
	/** Dropped candidates by reason, with at most `MAX_REJECTED_LISTED` model keys each. */
	rejected: Partial<Record<RejectionReason, { count: number; models: string[] }>>;
	failure?: { model: string; kind: FailureKind };
	notes: string[];
}

export const MAX_COOLDOWNS = 16;
export const MAX_REJECTED_LISTED = 5;
export const MAX_NOTES = 6;
