import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { repoKey } from "../../octocode/shared/home/repo.ts";
import type { Settings } from "../settings-schema.ts";

/**
 * The `toggles` setting switches plugins and hooks on or off by ID. Global and project maps merge per key; a project
 * key reaches consumers under this prefix so it can only switch items whose files live inside the repository: a
 * committed `.octocode/settings.json` is outside the native trust review and must not switch off a user's own hooks.
 */
export const PROJECT_TOGGLE_PREFIX = "project:";

export type Toggles = Readonly<Record<string, boolean>>;
/** Hook profiles, named by the host that defines their format. */
export type ToggleHost = "claude" | "codex" | "octocode";

/** The merged `toggles` value: global keys as written, project keys prefixed. */
export function mergeToggles(global: Toggles | undefined, project: Toggles | undefined): Toggles | undefined {
	if (!global && !project) return undefined;
	return {
		...global,
		...Object.fromEntries(Object.entries(project ?? {}).map(([id, on]) => [`${PROJECT_TOGGLE_PREFIX}${id}`, on])),
	};
}

/**
 * Whether an item is on. `ids` run from the most specific (one hook) to the broadest (its host); the first key set
 * decides, a project key before a global one for an item inside the repository. Unset means on.
 */
export function isSwitchedOn(ids: readonly string[], toggles: Toggles | undefined, inProject: boolean): boolean {
	if (!toggles) return true;
	for (const id of ids) {
		const project = inProject ? toggles[`${PROJECT_TOGGLE_PREFIX}${id}`] : undefined;
		const value = project ?? toggles[id];
		if (value !== undefined) return value;
	}
	return true;
}

/** Whether `file` lies inside the repository of `cwd`: a project item, which project toggles may switch. */
export function insideProject(file: string, cwd: string): boolean {
	let real = file;
	try {
		real = realpathSync(file);
	} catch {
		/* A missing file keeps its spelling. */
	}
	const relative = path.relative(repoKey(cwd).root, real);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

const hasProjectKeys = (toggles: Toggles | undefined) =>
	Object.keys(toggles ?? {}).some((id) => id.startsWith(PROJECT_TOGGLE_PREFIX));

export const pluginToggleId = (pluginPath: string): string => `plugin:${pluginPath}`;
export const hookHostToggleId = (host: ToggleHost): string => `hooks:${host}`;
export const hookSourceToggleId = (host: ToggleHost, source: string): string => `hooks:${host}:${source}`;
/** One handler: its file, event, matcher and content identity, so reordering a file keeps the switch. */
export const hookToggleId = (source: string, event: string, matcher: string, identity: string): string =>
	`hook:${createHash("sha256")
		.update(JSON.stringify([source, event, matcher, identity]))
		.digest("hex")
		.slice(0, 12)}`;

/** Plugin entries with `enabled` resolved from `toggles`; every plugin loader reads this instead of `plugins`. */
export function effectivePlugins(settings: Settings, cwd: string): Settings["plugins"] {
	if (!settings.toggles) return settings.plugins;
	const project = hasProjectKeys(settings.toggles);
	return settings.plugins?.map((entry) => {
		if (!entry || typeof entry !== "object" || typeof entry.path !== "string") return entry;
		const on = isSwitchedOn([pluginToggleId(entry.path)], settings.toggles, project && insideProject(entry.path, cwd));
		return on ? entry : { ...entry, enabled: false };
	});
}
