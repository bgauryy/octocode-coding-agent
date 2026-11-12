import type { ExtensionContext } from "../../core/features/index.ts";
import { renderInstruction } from "../../core/prompt-template.ts";
import { type Catalog, readCatalog } from "./catalog.ts";
import { registryBilling } from "./model.ts";
import { type RoutingFacts, routingFacts } from "./models-command.ts";
import { providerCount } from "../instructions/policy.ts";
import type { AgentProfile } from "./profiles.ts";

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
	ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
	profiles: Iterable<AgentProfile>,
): RoutingReading {
	const model = ctx.model;
	const catalog = readCatalog();
	// Without a session model nothing routes (`routingFacts`), so the registry is not read.
	if (!model) return { facts: undefined, catalog, under: () => undefined };
	const available = ctx.modelRegistry.getAvailable();
	const billing = registryBilling(ctx.modelRegistry);
	const list = [...profiles];
	const under = (index: Catalog | undefined) =>
		routingFacts(available, model, list, index, undefined, undefined, billing);
	return { facts: under(catalog), catalog, under };
}

const quote = (value: string) => (/\s/.test(value) ? value : `\`${value}\``);

/**
 * The coordinator's prompt states routing once per session: the first reading after a reset (session start, resume,
 * reload) is kept, so the cached prefix does not change mid-session. A later change made through a command (a provider
 * enabled, disabled or signed in, a model switch) reaches the running agent as one short hidden notice instead; the
 * next reload states the new facts in the prompt. A models.dev index saved since (the refresh each session starts)
 * changes no fact on its own: the agent hears of it only with a change of the registry.
 */
export class RoutingWatch {
	#frozen = false;
	#prompted: RoutingFacts | undefined;
	/** What the agent last learned, prompt or notice, as compared text. */
	#told = "";
	/** The models.dev index of that reading. */
	#catalog: Catalog | undefined;

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
		return renderInstruction("notices/routing-changed.md", {
			id: ROUTING_NOTICE_ID,
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

	reset(): void {
		this.#frozen = false;
		this.#prompted = undefined;
		this.#told = "";
		this.#catalog = undefined;
	}
}
