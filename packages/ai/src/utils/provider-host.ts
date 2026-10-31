/** Whether `baseUrl` points at exactly `host`; a lookalike path or subdomain (`proxy.example/openrouter.ai/v1`) does not match. */
export function matchesHost(baseUrl: string, host: string): boolean {
	try {
		return new URL(baseUrl).hostname === host;
	} catch {
		return false;
	}
}

/** OpenRouter itself, by provider id or by its API host. The one definition every adapter and host attribution shares. */
export function isOpenRouterModel(model: { provider: string; baseUrl: string }): boolean {
	return model.provider === "openrouter" || matchesHost(model.baseUrl, "openrouter.ai");
}
