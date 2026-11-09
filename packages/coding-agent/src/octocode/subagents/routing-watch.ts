import type { ExtensionContext } from "../../core/features/index.ts";
import { renderInstruction } from "../../core/prompt-template.ts";
import { readCatalog } from "./catalog.ts";
import { type RoutingFacts, routingFacts } from "./models-command.ts";
import { providerCount } from "../instructions/policy.ts";
import type { AgentProfile } from "./profiles.ts";

/** The custom message type of the routing notice. */
export const ROUTING_NOTICE_ID = "octocode-routing";

/** The routing facts for this session's model and providers now, from the saved models.dev index only (no fetch). */
export function currentRouting(
	ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
	profiles: Iterable<AgentProfile>,
): RoutingFacts | undefined {
	// Without a session model nothing routes (`routingFacts`), so the registry is not read.
	if (!ctx.model) return undefined;
	return routingFacts(ctx.modelRegistry.getAvailable(), ctx.model, profiles, readCatalog());
}

const quote = (value: string) => (/\s/.test(value) ? value : `\`${value}\``);

/**
 * The coordinator's prompt states routing once per session: the first reading after a reset (session start, resume,
 * reload) is kept, so the cached prefix does not change mid-session. A later change made through a command (a provider
 * enabled, disabled or signed in, a model switch) reaches the running agent as one short hidden notice instead; the
 * next reload states the new facts in the prompt.
 */
export class RoutingWatch {
	#frozen = false;
	#prompted: RoutingFacts | undefined;
	/** What the agent last learned, prompt or notice, as compared text. */
	#told = "";

	/** The facts this session's prompt states: frozen at the first call after a reset. */
	prompt(current: RoutingFacts | undefined): RoutingFacts | undefined {
		if (!this.#frozen) {
			this.#frozen = true;
			this.#prompted = current;
			this.#told = JSON.stringify(current ?? null);
		}
		return this.#prompted;
	}

	/** The notice for a change the agent has not heard of yet, once; undefined when nothing changed or nothing is frozen. */
	notice(current: RoutingFacts | undefined): string | undefined {
		if (!this.#frozen || !current) return undefined;
		const key = JSON.stringify(current);
		if (key === this.#told) return undefined;
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
	}
}
