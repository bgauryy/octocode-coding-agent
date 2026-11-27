/** Enforce one unambiguous site: restriction when a search provider ignores it. */
export function searchSite(query: string): ((url: string) => boolean) | undefined {
	// Leave Boolean expressions and quoted operators to the provider; imposing one branch would hide valid results.
	const tokens = query.match(/"[^"]*"|\S+/g) ?? [];
	if (tokens.some((token) => !token.startsWith('"') && (token === "OR" || /[()|]/.test(token)))) return undefined;
	const sites = tokens.filter((token) => token.startsWith("site:"));
	if (sites.length !== 1) return undefined;
	const value = sites[0].slice(5);
	if (!value || /["'*\\#]/.test(value)) return undefined;
	const explicitProtocol = /^https?:\/\//i.test(value);
	let site: URL;
	try {
		site = new URL(explicitProtocol ? value : `https://${value}`);
	} catch {
		return undefined;
	}
	if (site.username || site.password || !site.hostname || site.hostname.startsWith(".")) return undefined;
	const host = site.hostname.toLowerCase().replace(/\.$/, "");
	const prefix = site.pathname + site.search;
	return (candidate) => {
		try {
			const url = new URL(candidate);
			const candidateHost = url.hostname.toLowerCase().replace(/\.$/, "");
			if (explicitProtocol) {
				if (url.protocol !== site.protocol || candidateHost !== host || url.port !== site.port) return false;
			} else if (candidateHost !== host && !candidateHost.endsWith(`.${host}`)) return false;
			else if (site.port && url.port !== site.port) return false;
			return (url.pathname + url.search).startsWith(prefix);
		} catch {
			return false;
		}
	};
}
