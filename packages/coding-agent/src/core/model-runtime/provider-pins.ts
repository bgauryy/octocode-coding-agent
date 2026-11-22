import { createModels, type Provider } from "@octocodeai/octocode-ai";
import type { RuntimeCredentials } from "../runtime-credentials.ts";
import type { ModelRequestHost } from "./requests.ts";
import { streamSimpleChatModel } from "./requests.ts";

/** How long a provider a reload removed stays usable for requests that already hold one of its models. */
const RETIRED_TTL_MS = 15 * 60_000;

/**
 * Keeps providers a reload removed serving the requests of turns and compactions that started with one of their
 * models, so editing models.json mid-turn cannot fail them with "Unknown provider". New model lookups never see a
 * retired provider; it expires and leaves when its id is defined again.
 */
export class ProviderPins {
	private readonly retired = new Map<string, { provider: Provider; at: number }>();
	private readonly listeners = new Set<(providerIds: readonly string[]) => void>();
	private readonly credentials: RuntimeCredentials;

	constructor(credentials: RuntimeCredentials) {
		this.credentials = credentials;
	}

	/** Calls `listener` with the ids of providers a reload removed. Returns the unsubscribe. */
	onRemoved(listener: (providerIds: readonly string[]) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	clearListeners(): void {
		this.listeners.clear();
	}

	/** Retire what `before` had and `after` lacks, forget what is defined again, and tell the listeners once. */
	settle(before: readonly Provider[], after: readonly Provider[], now = Date.now()): void {
		const live = new Set(after.map((provider) => provider.id));
		for (const id of live) this.retired.delete(id);
		for (const [id, entry] of this.retired) if (now - entry.at > RETIRED_TTL_MS) this.retired.delete(id);
		const removed = before.filter((provider) => !live.has(provider.id));
		for (const provider of removed) this.retired.set(provider.id, { provider, at: now });
		if (removed.length === 0) return;
		const ids = removed.map((provider) => provider.id);
		for (const listener of this.listeners) listener(ids);
	}

	private retiredProvider(id: string): Provider | undefined {
		const entry = this.retired.get(id);
		return entry && Date.now() - entry.at <= RETIRED_TTL_MS ? entry.provider : undefined;
	}

	/** A request host that falls back to a retired provider, for its lookup and its auth, when the live one is gone. */
	host(live: ModelRequestHost): ModelRequestHost {
		const pinned: ModelRequestHost = {
			getProvider: (id) => live.getProvider(id) ?? this.retiredProvider(id),
			getAuth: (model, overrides) => {
				const retired = live.getProvider(model.provider) ? undefined : this.retiredProvider(model.provider);
				if (!retired) return live.getAuth(model, overrides);
				const models = createModels({ credentials: this.credentials });
				models.setProvider(retired);
				return models.getAuth(model, overrides);
			},
			getCachePolicy: (model, options) => live.getCachePolicy(model, options),
			resolveModel: (model, messages, options) => live.resolveModel(model, messages, options),
			streamSimple: (model, context, options) => streamSimpleChatModel(pinned, model, context, options),
		};
		return pinned;
	}
}
