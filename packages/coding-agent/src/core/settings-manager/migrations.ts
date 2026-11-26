import type { Settings } from "../settings-schema.ts";
import type { SettingsScope } from "./storage.ts";

/** One conversion of an earlier settings shape: changes `settings` in place and returns whether it changed anything. */
interface SettingsMigration {
	scopes: readonly SettingsScope[];
	run(settings: Settings): boolean;
}

/**
 * The external agents an explicit `externalAgents: true` without `enabledExternalAgents` allowed when it stopped
 * meaning "every runner": the runners of that time and another Octocode over ACP (vendor `octocode`). A fixed record of
 * that time, so a runner added later still needs its own opt-in.
 */
const RUNNERS_WHEN_SELECTION_BECAME_REQUIRED = [
	"claude-code",
	"codex",
	"opencode",
	"gemini",
	"agy",
	"cursor",
	"octocode",
];

/** The ids of the file's own ACP agents (`externalModels` entries of kind `acp`): the vendors an ACP connection names. */
function configuredAcpVendors(settings: Settings): string[] {
	const entries: unknown = settings.externalModels;
	if (!Array.isArray(entries)) return [];
	return entries.flatMap((entry: unknown) =>
		typeof entry === "object" &&
		entry !== null &&
		(entry as { kind?: unknown }).kind === "acp" &&
		typeof (entry as { id?: unknown }).id === "string"
			? [(entry as { id: string }).id]
			: [],
	);
}

/** Every conversion in the order it was introduced. A step only adds what an older file implied; it never guesses. */
const MIGRATIONS: readonly SettingsMigration[] = [
	{
		// No selection meant every vendor: the shipped runners and the file's own ACP agents, which stay selected.
		// Both keys are global only: a project file's copy does nothing, so it stays as written.
		scopes: ["global"],
		run: (settings) => {
			if (settings.externalAgents !== true || settings.enabledExternalAgents !== undefined) return false;
			settings.enabledExternalAgents = [
				...new Set([...RUNNERS_WHEN_SELECTION_BECAME_REQUIRED, ...configuredAcpVendors(settings)]),
			];
			return true;
		},
	},
];

/** Applies the steps for `scope` to `settings` in place; true when the file needs rewriting. */
export function migrateSettings(settings: Settings, scope: SettingsScope): boolean {
	let changed = false;
	for (const step of MIGRATIONS) if (step.scopes.includes(scope) && step.run(settings)) changed = true;
	return changed;
}
