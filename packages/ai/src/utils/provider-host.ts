/** Whether `baseUrl` points at exactly `host`; a lookalike path or subdomain (`proxy.example/openrouter.ai/v1`) does not match. */
export function matchesHost(baseUrl: string, host: string): boolean {
	try {
		return new URL(baseUrl).hostname === host;
	} catch {
		return false;
	}
}

/**
 * Whether `baseUrl`'s host is one of `domains` or a subdomain of one (`api.cerebras.ai` for `cerebras.ai`). Like
 * matchesHost, a domain named only in the path or inside a longer label (`notcerebras.ai`) does not match.
 */
export function matchesDomain(baseUrl: string, ...domains: string[]): boolean {
	let hostname: string;
	try {
		hostname = new URL(baseUrl).hostname;
	} catch {
		return false;
	}
	return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

/** OpenRouter itself, by provider id or by its API host. The one definition every adapter and host attribution shares. */
export function isOpenRouterModel(model: { provider: string; baseUrl: string }): boolean {
	return model.provider === "openrouter" || matchesHost(model.baseUrl, "openrouter.ai");
}

/** Amazon Bedrock's public inference endpoints, including FIPS, dual-stack and China partitions. */
export function isBedrockInferenceHost(baseUrl: string): boolean {
	if (!URL.canParse(baseUrl)) return false;
	return /^bedrock-(?:runtime|mantle)(?:-fips)?\.[a-z0-9-]+\.(?:amazonaws\.com(?:\.cn)?|api\.aws)$/.test(
		new URL(baseUrl).hostname,
	);
}
