/** The token of a model provider outside a session, for MCP servers with `auth.provider`. */

import { join } from "node:path";
import type { ModelRuntime } from "../../../coding-agent/src/core/model-runtime.ts";

/**
 * Reads the token like a session does (stored `/login` credentials, `models.json`, environment). The
 * model runtime loads on the first request, so commands without such servers never pay for it.
 */
export function storedProviderToken(agentDir: string): (provider: string) => Promise<string | undefined> {
	let runtime: Promise<ModelRuntime> | undefined;
	return async (provider) => {
		try {
			runtime ??= import("../../../coding-agent/src/core/model-runtime.ts").then(({ ModelRuntime }) =>
				ModelRuntime.create({
					authPath: join(agentDir, "auth.json"),
					modelsPath: join(agentDir, "models.json"),
					allowModelNetwork: false,
					refreshOnCreate: false,
				}),
			);
			return (await (await runtime).getAuth(provider))?.auth.apiKey;
		} catch {
			return undefined;
		}
	};
}
