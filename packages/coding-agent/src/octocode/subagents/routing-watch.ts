import { modelAvailableToChild, modelEnabled } from "./task-model-visibility.ts";
import type { FeatureContext } from "../../core/features/index.ts";
import { renderPrompt } from "../../core/prompt-template.ts";
import { type Catalog, readCatalog } from "./catalog.ts";
import { registryBilling } from "./model.ts";
import { type RoutingFacts, routingFacts } from "./models-command.ts";
import { providerHealth } from "./provider-health.ts";
import { providerCount } from "../native/prompts/policy.ts";
import type { AgentProfile } from "./profiles.ts";
import { isModelTier } from "./tier.ts";

/** The custom message type of the routing notice. */
export const ROUTING_NOTICE_ID = "octocode-routing";

/** One reading of the routing facts, and the models.dev index it was read with. */
export interface RoutingReading {
	facts: RoutingFacts | undefined;
	catalog: Catalog | undefined;
	/** The same registry and profiles read against another index. */
	under(catalog: Catalog | undefined): RoutingFacts | undefined;
}

/** The routing facts for this session's model and providers now, from the saved models.dev index only (no fetch). */
export function currentRouting(
	ctx: Pick<FeatureContext, "model" | "modelRegistry">,
	profiles: Iterable<AgentProfile>,
): RoutingReading {
	const model = ctx.model;
	const catalog = readCatalog();
	// Without a session model nothing routes (`routingFacts`), so the registry is not read.
	if (!model) return { facts: undefined, catalog, under: () => undefined };
	const available = ctx.modelRegistry
		.getAvailable()
		.filter((candidate) => modelAvailableToChild(ctx.modelRegistry, candidate));
	const billing = registryBilling(ctx.modelRegistry);
	const list = [...profiles];
	const gone = unavailablePins(ctx.modelRegistry, list, available);
	const under = (index: Catalog | undefined) =>
		withReplacedProfileModels(
			routingFacts(
				available,
				modelEnabled(ctx.modelRegistry, model) && modelAvailableToChild(ctx.modelRegistry, model) ? model : undefined,
				list,
				index,
				undefined,
				undefined,
				billing,
			),
			list,
			gone,
		);
	return { facts: under(catalog), catalog, under };
}

/** Why each model a profile pins is not offered now (hidden by the user, or no longer served); empty when all are offered. */
function unavailablePins(
	registry: Pick<FeatureContext["modelRegistry"], "getAll" | "isModelHidden">,
	profiles: readonly AgentProfile[],
	available: readonly { provider: string; id: string }[],
): Map<string, string> {
	const pinned = new Set(
		profiles.flatMap((profile) => {
			const asked = profile.model?.split(":")[0];
			return asked && !isModelTier(asked) ? [asked] : [];
		}),
	);
	const gone = new Map<string, string>();
	if (pinned.size === 0) return gone;
	const offered = new Set(available.flatMap((model) => [model.id, `${model.provider}/${model.id}`]));
	for (const asked of pinned) if (!offered.has(asked)) gone.set(asked, "no longer available");
	if (gone.size === 0) return gone;
	for (const model of registry.getAll()) {
		for (const name of [model.id, `${model.provider}/${model.id}`]) {
			if (gone.has(name) && registry.isModelHidden(model)) gone.set(name, "hidden in /providers");
		}
	}
	return gone;
}

/**
 * A profile whose configured model is hidden or gone (its provider was removed or disabled) runs on the model routing
 * picks instead; its entry names both, so the agent and the user do not read the fallback as the profile's own choice.
 */
export function withReplacedProfileModels(
	facts: RoutingFacts | undefined,
	profiles: readonly AgentProfile[],
	gone: ReadonlyMap<string, string>,
): RoutingFacts | undefined {
	if (!facts || gone.size === 0) return facts;
	const notes = profiles.flatMap((profile) => {
		const asked = profile.model?.split(":")[0];
		const why = asked ? gone.get(asked) : undefined;
		return asked && why && profile.name in facts.profiles
			? [[profile.name, `${facts.profiles[profile.name]} (${asked} is gone: ${why})`] as const]
			: [];
	});
	return notes.length === 0 ? facts : { ...facts, profiles: { ...facts.profiles, ...Object.fromEntries(notes) } };
}

const quote = (value: string) => (/\s/.test(value) ? value : `\`${value}\``);

/**
 * The coordinator's prompt states routing once per session: the first reading after a reset (session start, resume,
 * reload) is kept, so the cached prefix does not change mid-session. A later change made through a command (a provider
 * enabled, disabled or signed in, a model switch) reaches the running agent as one short hidden notice instead; the
 * next reload states the new facts in the prompt. A notice names its cause: a provider that refused its credential or
 * accepts it again (`isRefused`, the provider health the routing read), otherwise the user. A models.dev index saved since (the refresh each session starts)
 * changes no fact on its own: the agent hears of it only with a change of the registry.
 */
export class RoutingWatch {
	#frozen = false;
	#prompted: RoutingFacts | undefined;
	/** What the agent last learned, prompt or notice, as compared text. */
	#told = "";
	/** The models.dev index of that reading. */
	#catalog: Catalog | undefined;
	readonly #isRefused: (provider: string) => boolean;
	/** Providers the agent was told left because they refused their credential. */
	#refusedOff = new Set<string>();

	constructor(isRefused: (provider: string) => boolean = (provider) => providerHealth.refused(provider)) {
		this.#isRefused = isRefused;
	}

	/** The facts this session's prompt states: frozen at the first call after a reset. */
	prompt(current: RoutingFacts | undefined, catalog?: Catalog): RoutingFacts | undefined {
		if (!this.#frozen) {
			this.#frozen = true;
			this.#prompted = current;
			this.#told = JSON.stringify(current ?? null);
			this.#catalog = catalog;
		}
		return this.#prompted;
	}

	/**
	 * The notice for a change the agent has not heard of yet, once; undefined when nothing changed or nothing is frozen.
	 * `reading` is where `current` came from: when only its index differs (the registry read against the index the agent
	 * was told about gives what it was told), the reading becomes the baseline without a notice.
	 */
	notice(current: RoutingFacts | undefined, reading?: Omit<RoutingReading, "facts">): string | undefined {
		if (!this.#frozen || !current) return undefined;
		const key = JSON.stringify(current);
		if (key === this.#told) return undefined;
		if (reading && reading.catalog !== this.#catalog) {
			const indexOnly = JSON.stringify(reading.under(this.#catalog) ?? null) === this.#told;
			this.#catalog = reading.catalog;
			if (indexOnly) {
				this.#told = key;
				return undefined;
			}
		}
		const before = JSON.parse(this.#told) as RoutingFacts | null;
		this.#told = key;
		const was = (before?.providers ?? []).map((provider) => provider.id);
		const now = current.providers.map((provider) => provider.id);
		const off = was.filter((provider) => !now.includes(provider));
		const on = now.filter((provider) => !was.includes(provider));
		const refused = off.filter(this.#isRefused);
		const recovered = on.filter((provider) => this.#refusedOff.has(provider));
		const user =
			off.length + on.length === 0 ||
			refused.length < off.length ||
			recovered.length < on.length ||
			before?.sessionModel !== current.sessionModel;
		this.#refusedOff = new Set([...this.#refusedOff, ...refused].filter((provider) => !now.includes(provider)));
		return renderPrompt("notices/routing-changed.md", {
			id: ROUTING_NOTICE_ID,
			user,
			refused: refused.map(quote).join(", "),
			recovered: recovered.map(quote).join(", "),
			sessionModel: quote(current.sessionModel),
			providers: current.providers.map(providerCount).join(", "),
			on: on.map(quote).join(", "),
			off: off.map(quote).join(", "),
			small: quote(current.small),
			medium: quote(current.medium),
			profiles: Object.entries(current.profiles)
				.map(([name, model]) => `${name} ${quote(model)}`)
				.join(", "),
		});
	}

	/**
	 * Compaction summarized the notices away while the prompt still states the frozen facts: the agent now knows only
	 * those, so a change since is told again.
	 */
	compacted(): void {
		if (this.#frozen) this.#told = JSON.stringify(this.#prompted ?? null);
	}

	reset(): void {
		this.#frozen = false;
		this.#prompted = undefined;
		this.#told = "";
		this.#catalog = undefined;
		this.#refusedOff = new Set();
	}
}
