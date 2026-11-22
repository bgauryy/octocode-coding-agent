/** Why a credential entry is not one Octocode reads, or undefined when it is. */
export function invalidEntryReason(credential: unknown): string | undefined {
	if (typeof credential !== "object" || credential === null || Array.isArray(credential)) return "not an object";
	const value = credential as Record<string, unknown>;
	if (value.type === "api_key") {
		const validKey = value.key === undefined || typeof value.key === "string";
		const validEnv =
			value.env === undefined ||
			(typeof value.env === "object" &&
				value.env !== null &&
				!Array.isArray(value.env) &&
				Object.values(value.env).every((entry) => typeof entry === "string"));
		const endpoint = value.endpoint as Record<string, unknown> | undefined;
		const validEndpoint =
			endpoint === undefined ||
			(typeof endpoint === "object" &&
				endpoint !== null &&
				typeof endpoint.baseUrl === "string" &&
				(endpoint.region === undefined || typeof endpoint.region === "string") &&
				(endpoint.api === undefined || typeof endpoint.api === "string"));
		const validReference = value.keychain === undefined || typeof value.keychain === "string";
		if (!validKey || !validEnv) return "an api_key entry needs a string key and string env values";
		return validEndpoint && validReference
			? undefined
			: "an api_key entry has an invalid endpoint or keychain reference";
	}
	if (value.type === "oauth") {
		const valid =
			typeof value.access === "string" &&
			typeof value.refresh === "string" &&
			typeof value.expires === "number" &&
			Number.isFinite(value.expires);
		return valid ? undefined : "an oauth entry needs string access and refresh tokens and a numeric expires";
	}
	return typeof value.type === "string" ? `type "${value.type}" is not api_key or oauth` : "it has no type";
}
