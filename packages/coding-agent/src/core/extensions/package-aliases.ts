const LEGACY_PACKAGES = {
	"pi-agent-core": "@octocodeai/octocode-agent-core",
	"pi-tui": "@octocodeai/octocode-tui",
	"pi-coding-agent": "@octocodeai/octocodecode",
	"pi-ai": "@octocodeai/octocode-ai",
	"pi-ai/compat": "@octocodeai/octocode-ai/compat",
	"pi-ai/oauth": "@octocodeai/octocode-ai/oauth",
	"pi-ai/providers/all": "@octocodeai/octocode-ai/providers/all",
} as const;

/** Both Pi package scopes resolve to the same host modules as native extensions. */
export function withLegacyPackageAliases<T>(modules: Record<string, T>): Record<string, T> {
	const aliases = { ...modules };
	for (const scope of ["@mariozechner", "@earendil-works"]) {
		for (const [legacy, native] of Object.entries(LEGACY_PACKAGES)) {
			if (native in modules) aliases[`${scope}/${legacy}`] = modules[native];
		}
	}
	return aliases;
}
