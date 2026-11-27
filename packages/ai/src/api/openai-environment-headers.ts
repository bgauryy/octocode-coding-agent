import { OPENAI_CUSTOM_HEADERS_ENV } from "../env-api-keys.ts";
import type { ProviderEnv, ProviderHeaders } from "../types.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";

/** Defaults previously supplied by the OpenAI SDK; explicit model/request headers take precedence. */
export function openAIEnvironmentHeaders(env?: ProviderEnv): ProviderHeaders {
	const headers: ProviderHeaders = {};
	const organization = getProviderEnvValue("OPENAI_ORG_ID", env);
	const project = getProviderEnvValue("OPENAI_PROJECT_ID", env);
	if (organization) headers["OpenAI-Organization"] = organization;
	if (project) headers["OpenAI-Project"] = project;
	for (const line of getProviderEnvValue(OPENAI_CUSTOM_HEADERS_ENV, env)?.split("\n") ?? []) {
		const colon = line.indexOf(":");
		if (colon >= 0) headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
	}
	return headers;
}
