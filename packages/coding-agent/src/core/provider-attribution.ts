import type { Api, Model, ProviderHeaders } from "@octocodeai/octocode-ai";
import { getBuiltinProviders } from "@octocodeai/octocode-ai/providers/all";
import { matchesHost } from "@octocodeai/octocode-ai/utils/provider-host";
import { isOpenRouterModel } from "@octocodeai/octocode-ai/utils/provider-profile";
import { VERSION } from "../config.ts";
import { AGENT_ID_ENV, AGENT_ROLE_ENV, PARENT_ID_ENV } from "@octocodeai/octocode-common/env";
import { getOctocodeUserAgent } from "../utils/user-agent.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { isInstallTelemetryEnabled } from "./telemetry.ts";

const NVIDIA_NIM_HOST = "integrate.api.nvidia.com";
const CLOUDFLARE_API_HOST = "api.cloudflare.com";
const CLOUDFLARE_AI_GATEWAY_HOST = "gateway.ai.cloudflare.com";
const OPENCODE_HOST = "opencode.ai";

function isNvidiaNimModel(model: Model<Api>): boolean {
	return model.provider === "nvidia" || matchesHost(model.baseUrl, NVIDIA_NIM_HOST);
}

function isCloudflareModel(model: Model<Api>): boolean {
	return (
		model.provider === "cloudflare-workers-ai" ||
		model.provider === "cloudflare-ai-gateway" ||
		matchesHost(model.baseUrl, CLOUDFLARE_API_HOST) ||
		matchesHost(model.baseUrl, CLOUDFLARE_AI_GATEWAY_HOST)
	);
}

function getDefaultAttributionHeaders(
	model: Model<Api>,
	settingsManager: SettingsManager,
): Record<string, string> | undefined {
	if (!isInstallTelemetryEnabled(settingsManager)) {
		return undefined;
	}

	if (isOpenRouterModel(model)) {
		return {
			"HTTP-Referer": "https://github.com/bgauryy/octocodecode",
			"X-OpenRouter-Title": "octocode",
			"X-OpenRouter-Categories": "cli-agent",
		};
	}

	if (isNvidiaNimModel(model)) {
		return {
			"X-BILLING-INVOKE-ORIGIN": "Octocode",
		};
	}

	if (isCloudflareModel(model)) {
		return {
			"User-Agent": "octocode",
		};
	}

	return undefined;
}

function getSessionHeaders(model: Model<Api>, sessionId: string | undefined): Record<string, string> | undefined {
	if (model.provider !== "opencode" && model.provider !== "opencode-go" && !matchesHost(model.baseUrl, OPENCODE_HOST)) {
		return undefined;
	}
	return {
		...(sessionId ? { "x-opencode-session": sessionId } : {}),
		"x-opencode-client": "octocode",
		"User-Agent": getOctocodeUserAgent(VERSION),
	};
}

/** Opt-in: label each request of a custom provider with the agent that sent it (`docs/configuration.md`). */
const REQUEST_AGENT_HEADERS_ENV = "OCTOCODE_REQUEST_AGENT_HEADERS";

/**
 * `x-octocode-agent` (the subagent id, `main` for the session itself), `x-octocode-role` and `x-octocode-parent` for a
 * provider that is not built in (a `models.json` or feature provider), so a gateway or test server can tell a child's
 * requests from its parent's. Built-in vendors never receive them.
 */
function getAgentHeaders(model: Model<Api>, env: NodeJS.ProcessEnv): Record<string, string> | undefined {
	if (env[REQUEST_AGENT_HEADERS_ENV] !== "1") return undefined;
	if ((getBuiltinProviders() as string[]).includes(model.provider)) return undefined;
	const role = env[AGENT_ROLE_ENV];
	const parent = env[PARENT_ID_ENV];
	return {
		"x-octocode-agent": env[AGENT_ID_ENV] || "main",
		...(role ? { "x-octocode-role": role } : {}),
		...(parent ? { "x-octocode-parent": parent } : {}),
	};
}

export function mergeProviderAttributionHeaders(
	model: Model<Api>,
	settingsManager: SettingsManager,
	sessionId: string | undefined,
	...headerSources: Array<ProviderHeaders | undefined>
): ProviderHeaders | undefined {
	const merged: ProviderHeaders = {
		...getAgentHeaders(model, process.env),
		...getSessionHeaders(model, sessionId),
		...getDefaultAttributionHeaders(model, settingsManager),
	};

	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}

	return Object.keys(merged).length > 0 ? merged : undefined;
}
