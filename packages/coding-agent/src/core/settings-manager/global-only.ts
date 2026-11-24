/**
 * Keys (a key and everything under it) the runtime reads from the global settings file only, so a project or per-run
 * value would do nothing: the configuration reports the global value and refuses those scopes. Each widens what a
 * session may run, spend or reach, or holds a choice made once for every project. Their readers open the global file
 * themselves (`permission/sandbox/apply.ts`, `files/bash-env.ts`, `storage/retention.ts`, `api/enabled.ts`…), and
 * `merge.ts` drops a project `security`; a project file that sets any gets one warning naming them (`globalOnlyKeysIn`).
 * A key a project may only turn off (`remote.autoStart`, `terminal.suggestions.model`) is not listed.
 */
export const GLOBAL_ONLY_SETTINGS: readonly string[] = [
	"sandbox",
	"bash.inheritProviderKeys",
	"security",
	"retention",
	"research.allowedPaths",
	"sessionApi",
	"sessionApiTurnPermission",
	"externalAgents",
	"enabledExternalAgents",
	"subagents.models",
	"limits.run",
	"limits.subagent",
	"limits.cost",
	"timer.cron",
	"timer.check",
	"cacheWarming",
	"runtime.smartRouting.allowPlanToMeteredEscalation",
	"modelCatalogUpdates",
	"httpProxy",
	"hiddenModels",
];

/** The global-only key `key` is or falls under, or undefined. */
export const globalOnlyRoot = (key: string): string | undefined =>
	GLOBAL_ONLY_SETTINGS.find((root) => key === root || key.startsWith(`${root}.`));

/** Whether `settings` holds a value at the dotted `path`. */
function holds(settings: object, path: string): boolean {
	let node: unknown = settings;
	for (const part of path.split(".")) {
		if (typeof node !== "object" || node === null || !Object.hasOwn(node, part)) return false;
		node = (node as Record<string, unknown>)[part];
	}
	return node !== undefined;
}

/** The global-only keys a settings file (a project's) sets, in `GLOBAL_ONLY_SETTINGS` order. */
export const globalOnlyKeysIn = (settings: object): string[] =>
	GLOBAL_ONLY_SETTINGS.filter((root) => holds(settings, root));
