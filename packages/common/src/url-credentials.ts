/**
 * Credentials carried inside a URL: a `user:password@` prefix or a query parameter whose name says key, token, secret or
 * password. `urlCredentialProblem` tells a loader to refuse such a URL; `redactUrlCredentials` is for output.
 */

const SENSITIVE_QUERY_NAME =
	/(?:^|[-_.])(api[-_]?key|key|secret|token|password|passwd|credential|authorization|cookie|signature|sig)(?:$|[-_.])/i;

function parse(value: string): URL | undefined {
	try {
		return new URL(value);
	} catch {
		return undefined;
	}
}

function sensitiveQueryNames(url: URL): string[] {
	// camelCase names (`apiKey`, `accessToken`) are split first so one pattern covers every spelling.
	return [...new Set(url.searchParams.keys())].filter((name) =>
		SENSITIVE_QUERY_NAME.test(name.replace(/([a-z0-9])([A-Z])/g, "$1_$2")),
	);
}

/** What is wrong with a URL that carries a credential, without quoting the credential; undefined when it has none or does not parse. */
export function urlCredentialProblem(value: string): string | undefined {
	const url = parse(value);
	if (!url) return undefined;
	if (url.username || url.password) return "contains a user name or password";
	if (sensitiveQueryNames(url).length > 0) return "contains a key or token query parameter";
	return undefined;
}

/** The URL with any user name and password dropped and the value of each key- or token-like query parameter replaced (default `redacted`). */
export function redactUrlCredentials(value: string, replacement = "redacted"): string {
	const url = parse(value);
	if (!url) return value;
	const names = sensitiveQueryNames(url);
	if (!url.username && !url.password && names.length === 0) return value;
	url.username = "";
	url.password = "";
	for (const name of names) url.searchParams.set(name, replacement);
	return url.toString();
}
