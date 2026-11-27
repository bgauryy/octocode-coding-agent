import type { AgentRoute } from "@octocodeai/octocode-contracts/config";

/** The stored routes (`AgentRoute`); a local list, since the writer worker runs this module without the contracts build. */
const ROUTES: readonly AgentRoute[] = ["config", "subscription", "remote", "external"];

/** Reads a stored route; an unknown or missing value is undefined. */
export function parseRoute(value: unknown): AgentRoute | undefined {
	return ROUTES.find((route) => route === value);
}
