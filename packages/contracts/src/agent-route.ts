import { StringEnum } from "./schema.ts";
import type { Static } from "typebox";

/**
 * How a request is reached and billed: `config` (a provider set by key, `models.json` or the environment, metered),
 * `subscription` (a vendor plan, Octocode runs the loop), `remote` (a hosted agent reached with a token) and `external`
 * (an installed vendor CLI that runs its own loop).
 */
export const AGENT_ROUTES = ["config", "subscription", "remote", "external"] as const;
export const AgentRouteSchema = StringEnum(AGENT_ROUTES);
export type AgentRoute = Static<typeof AgentRouteSchema>;

/** What decides a route: never configured, always read from the facts below. */
export interface AgentRouteFacts {
	/** An installed vendor CLI runs the loop. */
	runner?: boolean | undefined;
	/** A hosted agent runs the loop. */
	remote?: boolean | undefined;
	/** The provider is billed by plan (`ModelRuntime.isUsingSubscription`). */
	subscription?: boolean | undefined;
}

/** `external` for runners, `remote` for remote agents, else `subscription` when a plan pays, else `config`. */
export function deriveAgentRoute(facts: AgentRouteFacts): AgentRoute {
	if (facts.runner) return "external";
	if (facts.remote) return "remote";
	return facts.subscription ? "subscription" : "config";
}

/** Reads a stored route; an unknown or missing value (a row an older build wrote) is undefined. */
export function parseAgentRoute(value: unknown): AgentRoute | undefined {
	return AGENT_ROUTES.find((route) => route === value);
}
