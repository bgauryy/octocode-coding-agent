import { sleepUnlessAborted } from "@octocodeai/octocode-ai/utils/abort";
import { referenceProvider } from "../../core/model-reference.ts";
import { type ProviderCooldowns, providerCooldowns } from "../../core/model-runtime/provider-cooldown.ts";

/** The provider a run's requests go to: its routed model's (`provider/id[:thinking]`), else the parent session's. */
export function routeProvider(route: { model?: string; parent?: string }): string | undefined {
	return referenceProvider(route.model ?? route.parent);
}

/**
 * Holds subagent starts on a provider while it cools down from a rate limit. The cool-down is the one every model
 * request start waits on (`provider-cooldown.ts`): recorded by whichever request met the limit (this session's, a child's
 * or a peer's in another terminal) and shared through the agent database, so several siblings failing on one throttle
 * pause it once. A child started now would only wait inside its first request and be released with all the others at
 * once; a cool-down on one provider never holds a child routed to another.
 */
export class StartGate {
	private readonly cooldowns: Pick<ProviderCooldowns, "remainingMs">;

	constructor(cooldowns: Pick<ProviderCooldowns, "remainingMs"> = providerCooldowns) {
		this.cooldowns = cooldowns;
	}

	/** Milliseconds a run on `route` must still wait before it starts: what is left of its provider's cool-down. */
	holds(route: { model?: string; parent?: string }): () => number {
		const provider = routeProvider(route);
		return () => (provider ? this.cooldowns.remainingMs(provider) : 0);
	}

	/** Waits until `route`'s provider is not cooling down, looking again after each wait; the signal gives up the wait. */
	async wait(route: { model?: string; parent?: string }, signal?: AbortSignal): Promise<void> {
		const held = this.holds(route);
		for (;;) {
			signal?.throwIfAborted();
			const remaining = held();
			if (remaining <= 0) return;
			await sleepUnlessAborted(remaining, signal, () => new Error("Cancelled while waiting out a rate limit."));
		}
	}
}

/** The gate of this process's subagent starts. */
export const startGate = new StartGate();
