import { type Api, type Model, resolveModelCapabilities } from "@octocodeai/octocode-ai";
import { getAnthropicCompat } from "@octocodeai/octocode-ai/api/anthropic-messages/compat";
import type {
	CacheWarmingDecisionEvent,
	CacheWarmingDecisionEventResult,
	FeatureContext,
	SetupPick,
} from "../../core/features/index.ts";
import { BranchIndex, type BranchSource } from "../shared/branch-index.ts";
import { CACHE_RETENTION_ENV, envFlag, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { interactive } from "../shared/interactive.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

/**
 * Prompt-cache lifetimes, in seconds, for a model that declares no `promptCache` (a custom-provider model in models.json)
 * but whose replies show caching: 5 minutes for short retention and, where the model holds it, 1 hour for long (Anthropic's tiers).
 */
export const INFERRED_CACHE_TTL_SECONDS = { short: 300, long: 3600 } as const;
/** Idle gaps needed before this session's own history is trusted over Octocode's constant continuation estimate (fewer gaps are noise). */
const MIN_IDLE_SAMPLES = 5;

type PromptCache = NonNullable<Model<Api>["promptCache"]>;
type CacheModel = Pick<Model<Api>, "provider" | "id" | "api" | "promptCache" | "compat">;

/**
 * The lifetimes of a model that declares none. The long tier is a 1-hour entry only where the model is known to hold one:
 * an Anthropic-protocol model whose adapter sends the 1h tier (the adapter's own rule, so the plan matches what is sent), or
 * a model of another API that declares `supportsLongCacheRetention: true`. A model that declares neither, or whose replies
 * showed the provider granting only 5 minutes (`grantedLong` false), gets the short tier for both, so nothing is planned
 * around a 1-hour entry the adapter does not send.
 */
export function inferredPromptCache(
	model: Pick<Model<Api>, "compat"> & Partial<Pick<Model<Api>, "api" | "baseUrl" | "provider" | "id">>,
	grantedLong = true,
): PromptCache {
	const compat = model.compat;
	const holdsLong =
		model.api === "anthropic-messages" && model.baseUrl
			? getAnthropicCompat(model as Model<"anthropic-messages">).supportsLongCacheRetention
			: compat !== undefined && "supportsLongCacheRetention" in compat && compat.supportsLongCacheRetention === true;
	return {
		short: INFERRED_CACHE_TTL_SECONDS.short,
		long: grantedLong && holdsLong ? INFERRED_CACHE_TTL_SECONDS.long : INFERRED_CACHE_TTL_SECONDS.short,
	};
}

/**
 * The lifetime, in ms, of the history cache entry a session request writes: the `promptCache` tier for the history
 * retention in `env` (`long`, else short; the caller passes the retention its cache policy resolved), the tier the
 * cache warmer's `getPromptCacheTtlMs` uses, so clearing, idle-warming decisions and the warmer agree. Instructions may
 * live longer; the history entry is the first one a request loses. Undefined without that tier.
 */
export function promptCacheTtlMs(
	promptCache: PromptCache | undefined,
	env: NodeJS.ProcessEnv = process.env,
): number | undefined {
	const seconds = promptCache?.[env[CACHE_RETENTION_ENV] === "long" ? "long" : "short"];
	if (env[CACHE_RETENTION_ENV] === "none") return undefined;
	return seconds !== undefined && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/** An assistant reply's usage, when it has one. */
function usageOf(message: unknown): Record<string, unknown> | undefined {
	return isRecord(message) && message.role === "assistant" && isRecord(message.usage) ? message.usage : undefined;
}

const keyOf = (model: Pick<Model<Api>, "provider" | "id">) => `${model.provider}/${model.id}`;

/**
 * Prompt-cache lifetimes for models that declare none. Once a model's reply shows caching, it is known to cache for the
 * rest of the process (a later reply without usage, such as an aborted one, does not undo that), and:
 *
 * - idle-warming decisions use its inferred lifetime (`of`);
 * - an `anthropic-messages` model also gets those lifetimes in Octocode's model registry through `api.providers.register`, so Octocode's
 *   cache warmer, which plans with the resolved tiers, uses a learned 5-minute long tier too. The registration lists every model of
 *   the provider as the registry has it (models.json definitions, auth and headers config stay Octocode's, and a models.json
 *   `modelOverrides.promptCache` still wins, since Octocode applies overrides last); only models seen caching gain lifetimes.
 *   A provider whose models carry resolved headers (a built-in one) is left alone, and a refused registration is not retried.
 *
 * Until a reply shows otherwise, the resolved tiers apply (1 hour where the adapter sends it). A long-retention reply that
 * wrote cache with `cacheWrite1h: 0` shows the provider granted 5 minutes, and the supplied long tier drops to 300 s.
 */
export class PromptCacheLifetimes {
	private readonly caching = new Set<string>();
	private readonly shortOnly = new Set<string>();
	private readonly supplied = new Set<string>();
	private readonly refused = new Set<string>();

	/**
	 * The model's lifetimes: the inferred ones once an undeclared model was seen caching, else its resolved cache tiers
	 * (`resolveModelCapabilities`, which read a declared `promptCache` first), the tiers the cache warmer plans with. A
	 * marker model without a long tier gets its short tier as the long one, the lifetime its long requests are sent with.
	 */
	of(model: CacheModel | undefined): PromptCache | undefined {
		if (!model) return undefined;
		const key = keyOf(model);
		if (this.caching.has(key) && (!model.promptCache || this.supplied.has(key)))
			return inferredPromptCache(model, !this.shortOnly.has(key));
		const { mechanism, lifetimes } = resolveModelCapabilities(model as Model<Api>).cache;
		if (Object.keys(lifetimes).length === 0) return undefined;
		// A marker adapter sends long history at the short lifetime where the endpoint has no long tier.
		if (mechanism === "markers" && lifetimes.long === undefined && lifetimes.short !== undefined)
			return { ...lifetimes, long: lifetimes.short };
		return lifetimes;
	}

	/** Notes a turn's assistant reply; supplies lifetimes to Octocode's registry when it shows an undeclared model caching. */
	observe(
		api: SetupPick<"providers", "register">,
		ctx: Pick<FeatureContext, "modelRegistry">,
		message: unknown,
		env: NodeJS.ProcessEnv = process.env,
	): void {
		const usage = usageOf(message);
		if (!usage || !(Number(usage.cacheRead) > 0 || Number(usage.cacheWrite) > 0) || !isRecord(message)) return;
		const model = ctx.modelRegistry.find(String(message.provider), String(message.model));
		if (!model || model.api !== "anthropic-messages") return;
		const key = keyOf(model);
		if (model.promptCache && !this.supplied.has(key)) return;
		const learnedShort =
			env[CACHE_RETENTION_ENV] === "long" &&
			Number(usage.cacheWrite) > 0 &&
			usage.cacheWrite1h === 0 &&
			!this.shortOnly.has(key);
		if (learnedShort) this.shortOnly.add(key);
		if (this.caching.has(key) && !learnedShort) return;
		this.caching.add(key);
		if (this.refused.has(model.provider)) return;
		const models = ctx.modelRegistry.getAll().filter((entry) => entry.provider === model.provider);
		if (models.some((entry) => entry.headers !== undefined)) return;
		const inferred = (entry: Model<Api>) =>
			entry.api === "anthropic-messages" &&
			this.caching.has(keyOf(entry)) &&
			(!entry.promptCache || this.supplied.has(keyOf(entry)));
		try {
			api.providers.register(model.provider, {
				models: models.map((entry) =>
					inferred(entry)
						? { ...entry, promptCache: inferredPromptCache(entry, !this.shortOnly.has(keyOf(entry))) }
						: entry,
				),
			});
			for (const entry of models) if (inferred(entry)) this.supplied.add(keyOf(entry));
		} catch {
			// Idle-warming decisions still use the inferred lifetime; only Octocode's warmer stays off for this provider.
			this.refused.add(model.provider);
		}
	}
}

/**
 * Octocode's say in a cache refresh Octocode is about to send. Active runs retain the core economic decision, including
 * headless runs and subagents waiting for tools. An idle session that `expectsWake` (its children, jobs or timers still
 * run, or it waits for an answer: `warm-wait.ts`) will send its next request without a person, so its refreshes are kept
 * up while the refreshes of this wait, the next one included, cost no more than the one rewrite they save; the core's
 * idle safety limit still ends the wait. Otherwise an idle refresh is decided from this session's own idle gaps at the
 * current idle age: warm when q(t) × the miss cost beats the refresh cost. Without enough gaps, an interactive session
 * keeps Octocode's assumed 15% chance that it resumes, and a headless one or a settled subagent stops; a settled
 * subagent whose gaps show its coordinator's mail tends to come within the lifetime is refreshed.
 * Undefined keeps Octocode's decision (a streaming refresh, whose run is still going, or too little history).
 */
export function warmingDecision(
	event: Pick<CacheWarmingDecisionEvent, "action" | "warmCost" | "missCost" | "continuationProbability">,
	ctx: Pick<FeatureContext, "hasUI" | "sessionManager">,
	ttlMs: number | undefined,
	now = Date.now(),
	isSubagent = envFlag(process.env, SUBAGENT_ENV),
	expectsWake = false,
): CacheWarmingDecisionEventResult | undefined {
	if (event.continuationProbability >= 1) return undefined;
	if (expectsWake) {
		const { warms } = cacheClock(ctx.sessionManager);
		const action = (warms + 1) * event.warmCost <= event.missCost ? "warm" : "stop";
		return action === event.action ? undefined : { action };
	}
	const person = interactive(ctx, isSubagent);
	const stop = event.action === "stop" ? undefined : ({ action: "stop" } as const);
	if (!person && !isSubagent) return stop;
	if (ttlMs === undefined) return person ? undefined : stop;
	const { replyAt, gaps } = cacheClock(ctx.sessionManager);
	const q = replyAt === undefined ? undefined : idleContinuation(gaps, now - replyAt, ttlMs);
	if (q === undefined) return person ? undefined : stop;
	const action = q * event.missCost > event.warmCost ? "warm" : "stop";
	return action === event.action ? undefined : { action };
}

/**
 * q(t): the chance a refresh now is used, from this session's idle gaps (next request after a finished run). Of the gaps that
 * lasted longer than `idleMs`, the share that ended after a tenth of the lifetime (sooner, the entry is still warm
 * without the refresh) and within the lifetime (later, the refreshed entry has expired too). Undefined with too few.
 */
export function idleContinuation(gaps: readonly number[], idleMs: number, ttlMs: number): number | undefined {
	const survivors = gaps.filter((gap) => gap > idleMs);
	if (survivors.length < MIN_IDLE_SAMPLES) return undefined;
	return survivors.filter((gap) => gap > idleMs + ttlMs / 10 && gap <= idleMs + ttlMs).length / survivors.length;
}

/** What the cache clock reads off a branch: its last reply and refresh, and the idle gaps. */
interface ClockState {
	/** When the last reply was requested (its idle start). */
	replyAt: number | undefined;
	/** The latest reply that used the cache; an error with zero cache usage does not refresh it. */
	cacheAt: number;
	/** The latest refresh by Octocode's warmer, anchored to provider dispatch rather than the later usage receipt. */
	warmAt: number;
	/** Refreshes by Octocode's warmer since the last reply: what the current wait has spent. */
	warms: number;
	/**
	 * Idle gaps: from a finished run's last reply to the next request, in ms. The next request is a user prompt or a
	 * reply started by anything else that resumed the session (a child's report, a message, a job's end, a timer).
	 */
	gaps: number[];
	/** When the run that just ended finished, until the next request. */
	finished: number | undefined;
}

function noteClock(state: ClockState, entry: unknown): void {
	const { type, kind, timestamp, cacheRequestedAt, message, usage } = entry as {
		type?: string;
		kind?: string;
		usage?: { cacheRead?: number; cacheWrite?: number };
		timestamp?: string;
		cacheRequestedAt?: string;
		message?: {
			role?: string;
			timestamp?: number;
			stopReason?: string;
			usage?: { cacheRead?: number; cacheWrite?: number };
		};
	};
	if (type === "usage") {
		if (usage && !(Number(usage.cacheRead) > 0 || Number(usage.cacheWrite) > 0)) return;
		const receiptAt = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
		const requestedAt = typeof cacheRequestedAt === "string" ? Date.parse(cacheRequestedAt) : Number.NaN;
		const at =
			kind !== "cache_warm"
				? Number.NaN
				: Number.isFinite(requestedAt) && requestedAt <= receiptAt
					? requestedAt
					: receiptAt;
		if (at > state.warmAt) state.warmAt = at;
		if (kind === "cache_warm") state.warms++;
		return;
	}
	if (type !== "message" || typeof message?.timestamp !== "number") return;
	if (message.role === "assistant") {
		if (state.finished !== undefined) state.gaps.push(message.timestamp - state.finished);
		state.replyAt = message.timestamp;
		state.warms = 0;
		// Older sessions did not always record usage. Explicit zero usage, however, is not evidence of a cache refresh.
		if (!message.usage || Number(message.usage.cacheRead) > 0 || Number(message.usage.cacheWrite) > 0) {
			state.cacheAt = message.timestamp;
		}
		state.finished = message.stopReason === "stop" ? message.timestamp : undefined;
	} else if (message.role === "user" && state.finished !== undefined) {
		state.gaps.push(message.timestamp - state.finished);
		state.finished = undefined;
	}
}

const clockIndex = new BranchIndex<ClockState>(
	() => ({
		replyAt: undefined,
		cacheAt: Number.NEGATIVE_INFINITY,
		warmAt: Number.NEGATIVE_INFINITY,
		warms: 0,
		gaps: [],
		finished: undefined,
	}),
	noteClock,
);

/**
 * The prompt cache's clock on the session's branch, resumed rather than rescanned (`BranchIndex`): `replyAt`, when the
 * last reply was requested; `useAt`, when the entry was last used, the later of a reply with cache activity and a refresh
 * by Octocode's warmer (undefined without a reply or cache activity); `warms`, the warmer's refreshes since the last
 * reply; `gaps`, the idle gaps (read-only).
 */
export function cacheClock(session: BranchSource): {
	replyAt: number | undefined;
	useAt: number | undefined;
	warms: number;
	gaps: readonly number[];
} {
	const { replyAt, cacheAt, warmAt, warms, gaps } = clockIndex.read(session);
	const usedAt = Math.max(cacheAt, warmAt);
	return { replyAt, useAt: replyAt === undefined || !Number.isFinite(usedAt) ? undefined : usedAt, warms, gaps };
}

/** Whether the entry a request would read has expired: it was last used longer ago than `ttlMs`. False when either is unknown. */
export function cacheCold(session: BranchSource, ttlMs: number | undefined, now = Date.now()): boolean {
	if (ttlMs === undefined) return false;
	const { useAt } = cacheClock(session);
	return useAt !== undefined && now - useAt > ttlMs;
}
