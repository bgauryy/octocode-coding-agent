/** The token of a model provider outside a session, for MCP servers with `auth.provider`. */

import { hostModels } from "../host.ts";

/**
 * Reads the token like a session does (stored `/login` credentials, `models.json`, environment). The host loads its
 * model runtime on the first request, so commands without such servers never pay for it.
 */
export function storedProviderToken(agentDir: string): (provider: string) => Promise<string | undefined> {
	return (provider) => hostModels().storedProviderToken(agentDir, provider);
}
