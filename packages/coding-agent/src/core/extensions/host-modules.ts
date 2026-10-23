/**
 * Module specifiers the host supplies to extensions. `virtual-modules.ts` (compiled runtimes) and the jiti aliases in
 * `loader.ts` (source runtime) are typed against this list so they cannot drift; the package warning in
 * `resource-loader/extension-sets.ts` derives its package names from it. Kept free of imports so it loads cheaply.
 */
export const HOST_MODULE_SPECIFIERS = [
	"typebox",
	"typebox/compile",
	"typebox/value",
	"@sinclair/typebox",
	"@sinclair/typebox/compile",
	"@sinclair/typebox/value",
	"@octocodeai/octocode-agent-core",
	"@octocodeai/octocode-tui",
	"@octocodeai/octocode-ai",
	"@octocodeai/octocode-ai/compat",
	"@octocodeai/octocode-ai/oauth",
	"@octocodeai/octocode-ai/providers/all",
	"@octocodeai/octocodecode",
] as const;

export type HostModuleSpecifier = (typeof HOST_MODULE_SPECIFIERS)[number];

/** The npm package name of a module specifier (`@scope/name/sub` → `@scope/name`, `name/sub` → `name`). */
function packageNameOf(specifier: string): string {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Package names the host provides; extensions must declare them as peer dependencies. */
export const HOST_PROVIDED_PACKAGE_NAMES: ReadonlySet<string> = new Set(HOST_MODULE_SPECIFIERS.map(packageNameOf));
