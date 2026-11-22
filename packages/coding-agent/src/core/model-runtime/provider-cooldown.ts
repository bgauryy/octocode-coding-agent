/**
 * Per-provider rate-limit cool-downs. A session, up to six subagent processes, its side calls and peers in other
 * terminals all send with the same key, and each retries on its own; without a shared pause the next request of any of
 * them meets the same throttle. A request that ends in a rate limit records a cool-down for its provider, and every model
 * request start through the runtime waits out what is left of it (`cooldown-request.ts`). This process keeps its own
 * copy, so it sees a record at once and keeps working when the shared store fails; the store (`cooldown-store.ts`, the
 * agent database) shares it with every other process.
 *
 * Keyed by `model.provider` alone. Octocode holds one credential per provider id, so every process on this machine sends a
 * provider's requests with the same key; a custom endpoint is its own provider id in models.json; and providers meter
 * rate limits per account or organization, which several keys can share. A key hash would put credential-derived data
 * in the shared file, and could only be known after auth resolution.
 */

import { isRateLimitedText, isUsageLimitError } from "@octocodeai/octocode-ai";
import { createAbortError, sleepUnlessAborted } from "@octocodeai/octocode-ai/utils/abort";
import { recordProblem } from "../diagnostics-log.ts";
import { agentDbCooldownStore, type Cooldown, type CooldownStore } from "./cooldown-store.ts";

/**
 * The pause after a rate limit that names no wait: the first session retry's backoff (`retry.baseDelayMs`), enough for a
 * per-second bucket to refill, and cheap when the limit was a one-off of one model.
 */
export const COOLDOWN_INITIAL_MS = 2_000;
/**
 * The longest such pause. Per-minute windows refill within 60 s; half of one, beside the session retry's own wait,
 * covers it without holding the provider's other requests for a whole minute.
 */
export const COOLDOWN_MAX_MS = 30_000;
/** A rate limit this long after the last cool-down ended starts the doubling over: one calm per-minute window. */
const COOLDOWN_FORGET_MS = 60_000;
/**
 * The longest cool-down one rate limit records, also when the provider asked for longer. The record outlives the request
 * and holds every process on the machine, so a long `retry-after` (an hour) would block the provider that long even after
 * the user changed its key. Past this, one request goes out again and the provider's answer sets the next cool-down: at
 * most one extra request per minute, never one before the provider's wait while it is in force. The session retry still
 * ends at once on a wait past `retry.maxAgentDelayMs` (`retryAfterBeyondCap`).
 */
export const COOLDOWN_RETRY_AFTER_MAX_MS = 60_000;

/** One rate-limited request: when it failed, when it went out (undefined when unknown) and the wait the provider asked for. */
interface RateLimitFailure {
	now: number;
	startedAt?: number;
	retryAfterMs?: number;
}

/**
 * The cool-down after `failure`, given the one last recorded (ended or not). A provider's wait is kept to the
 * millisecond, up to {@link COOLDOWN_RETRY_AFTER_MAX_MS}. Without one the pause starts at {@link COOLDOWN_INITIAL_MS} and doubles, up to {@link COOLDOWN_MAX_MS}, only
 * for a request that went out after the previous pause ended: the pause was too short. A request already out during it
 * met the same throttle, so siblings failing together never escalate it one after another. An end is never moved earlier.
 */
export function nextCooldown(previous: Cooldown | undefined, failure: RateLimitFailure): Cooldown {
	const recent = previous && failure.now - previous.until <= COOLDOWN_FORGET_MS ? previous : undefined;
	const floor = recent?.until ?? 0;
	if (failure.retryAfterMs !== undefined && failure.retryAfterMs > 0) {
		const askedMs = Math.min(failure.retryAfterMs, COOLDOWN_RETRY_AFTER_MAX_MS);
		return { until: Math.max(floor, failure.now + askedMs), pauseMs: recent?.pauseMs ?? 0 };
	}
	const escalate = recent !== undefined && failure.startedAt !== undefined && failure.startedAt >= recent.until;
	const pauseMs = !recent?.pauseMs
		? COOLDOWN_INITIAL_MS
		: escalate
			? Math.min(recent.pauseMs * 2, COOLDOWN_MAX_MS)
			: recent.pauseMs;
	return { until: Math.max(floor, failure.now + pauseMs), pauseMs };
}

/** Whether a failed request's text is a rate limit that clears by waiting; a usage or billing limit is final, not a pause. */
export function coolsDown(errorMessage: string | undefined): boolean {
	return !!errorMessage && isRateLimitedText(errorMessage) && !isUsageLimitError(errorMessage);
}

/** Why a request start does not wait: the cool-down left is longer than the request accepts. */
export interface CooldownRefusal {
	provider: string;
	remainingMs: number;
	maxWaitMs: number;
}

interface CooldownWaitOptions {
	signal?: AbortSignal;
	/** Longest cool-down the caller waits out; a longer one is refused at once. 0 or less: no limit. */
	maxWaitMs?: number;
	/** Hears when the wait starts (its end, ms since the epoch) and once it is over (`undefined`). */
	onWait?: (until: number | undefined) => void;
}

const later = (a: Cooldown | undefined, b: Cooldown | undefined): Cooldown | undefined =>
	!a ? b : !b ? a : b.until > a.until ? b : a;

/** The cool-downs of this process, joined with the shared store's. */
export class ProviderCooldowns {
	private readonly local = new Map<string, Cooldown>();
	private store: CooldownStore | undefined;
	/** The store failed: told once per process, then this process keeps working from its own copy. */
	private reported = false;

	private readonly openStore: () => CooldownStore;
	private readonly now: () => number;
	private readonly onStoreError: (error: unknown) => void;

	constructor(
		openStore: () => CooldownStore,
		now: () => number = () => Date.now(),
		onStoreError: (error: unknown) => void = (error) => recordProblem("provider-cooldowns", error),
	) {
		this.openStore = openStore;
		this.now = now;
		this.onStoreError = onStoreError;
	}

	/** The cool-down in force for `provider`: the later of this process's and the shared one; undefined when none was. */
	current(provider: string): Cooldown | undefined {
		return later(
			this.local.get(provider),
			this.shared((store) => store.read(provider)),
		);
	}

	/** Milliseconds until a request to `provider` may start; 0 when it is not cooling down. */
	remainingMs(provider: string): number {
		const until = this.current(provider)?.until ?? 0;
		return Math.max(0, until - this.now());
	}

	/** Records a rate limit of a request to `provider`, here at once and in the shared store behind it. */
	record(provider: string, failure: Omit<RateLimitFailure, "now">): Cooldown {
		const next = nextCooldown(this.current(provider), { ...failure, now: this.now() });
		this.local.set(provider, later(this.local.get(provider), next) ?? next);
		void this.shared((store) => store.write(provider, next))?.catch((error: unknown) => this.report(error));
		return next;
	}

	/**
	 * Waits out what is left of `provider`'s cool-down, reading it again after each wait (a peer may have extended it);
	 * returns the refusal instead when what is left exceeds `maxWaitMs`. The signal gives up the wait (an `AbortError`).
	 */
	async wait(provider: string, options: CooldownWaitOptions = {}): Promise<CooldownRefusal | undefined> {
		const { signal, maxWaitMs = 0, onWait } = options;
		let waited = false;
		try {
			for (;;) {
				signal?.throwIfAborted();
				const until = this.current(provider)?.until ?? 0;
				const remainingMs = until - this.now();
				if (remainingMs <= 0) return undefined;
				if (maxWaitMs > 0 && remainingMs > maxWaitMs) return { provider, remainingMs, maxWaitMs };
				onWait?.(until);
				waited = true;
				await sleepUnlessAborted(remainingMs, signal, createAbortError);
			}
		} finally {
			if (waited) onWait?.(undefined);
		}
	}

	/** Runs `use` on the shared store; a store that cannot open or answer is reported once and leaves this process's copy. */
	private shared<T>(use: (store: CooldownStore) => T): T | undefined {
		try {
			this.store ??= this.openStore();
			return use(this.store);
		} catch (error) {
			this.report(error);
			return undefined;
		}
	}

	private report(error: unknown): void {
		if (this.reported) return;
		this.reported = true;
		this.onStoreError(error);
	}
}

/** The process's cool-downs, shared through the agent database. */
export const providerCooldowns = new ProviderCooldowns(() => agentDbCooldownStore());
