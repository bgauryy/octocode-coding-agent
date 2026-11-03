import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { getBundledSkillsDir } from "../../../config.ts";
import { DefaultPackageManager, type PathMetadata, type ResolvedResource } from "../../../core/package-manager.ts";
import { withTogglePattern } from "../../../core/package-manager/patterns.ts";
import type { Skill } from "../../../core/skills.ts";
import { loadSkillFromFile } from "../../../core/skills/load-dir.ts";
import { SKILL_CATEGORIES, skillCategory } from "../../../core/skills/category.ts";
import { isSyntheticPath } from "../../../core/source-info.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { canonicalizePath } from "../../../../../common/src/paths.ts";
import { buildGroups } from "../../../core/package-manager/resource-groups.ts";
import { ResourceSettings } from "../../../core/package-manager/resource-settings.ts";
import type { InteractiveModeHost } from "./host.ts";

type SkillsHost = Pick<
	InteractiveModeHost,
	| "editor"
	| "getSlashCommands"
	| "handleReloadCommand"
	| "runtimeHost"
	| "session"
	| "sessionManager"
	| "showError"
	| "showExtensionSelector"
	| "showStatus"
	| "showWarning"
	| "skillCommands"
	| "ui"
>;

interface SkillEntry {
	path: string;
	name: string;
	enabled: boolean;
	loaded?: Skill;
	metadata: PathMetadata;
}

function skillName(path: string): string {
	return (
		loadSkillFromFile(path, "path").skill?.name ??
		(basename(path) === "SKILL.md" ? basename(dirname(path)) : basename(path).replace(/\.md$/i, ""))
	);
}

function state(entry: SkillEntry): string {
	if (!entry.loaded) return entry.enabled ? "not loaded" : "disabled";
	if (entry.loaded.disableModelInvocation)
		return entry.loaded.userInvocable === false ? "loaded, hidden" : "loaded, user-only";
	return entry.loaded.userInvocable === false ? "loaded, model-only" : "loaded, model+user";
}

function category(entry: SkillEntry) {
	return skillCategory(entry.loaded ?? { filePath: entry.path, sourceInfo: { source: entry.metadata.source } });
}

/** `core`, `octocode`, or `external · <scope>/<source>`: where an external skill came from matters, the others ship with Octocode. */
function origin(entry: SkillEntry): string {
	const kind = category(entry);
	if (kind !== "external") return kind;
	const source = entry.metadata.source === "auto" ? (entry.metadata.baseDir ?? "auto") : entry.metadata.source;
	return `external · ${entry.metadata.scope}/${source}`;
}

function describe(entry: SkillEntry): string {
	return `${entry.name} — ${state(entry)} · ${origin(entry)}\n${entry.path}`;
}

async function catalog(host: SkillsHost): Promise<{ entries: SkillEntry[]; resolved: ResolvedResource[] }> {
	const cwd = host.sessionManager.getCwd();
	const agentDir = host.runtimeHost.services.agentDir;
	// Listing must not install a missing package as a side effect.
	const manager = new DefaultPackageManager({
		cwd,
		agentDir,
		settingsManager: host.session.settingsManager,
		builtinSkillsDir: getBundledSkillsDir(),
	});
	const resolved = (await manager.resolve(async () => "skip")).skills;
	const loaded = host.session.resourceLoader.getSkills().skills;
	const loadedByPath = new Map(loaded.map((skill) => [skill.filePath, skill]));
	const loadedByCanonicalPath = new Map(loaded.map((skill) => [canonicalizePath(skill.filePath), skill]));
	const resolvedCanonicalPaths = new Set(resolved.map((resource) => canonicalizePath(resource.path)));
	const byPath = new Map<string, SkillEntry>();
	for (const resource of resolved) {
		const skill = loadedByPath.get(resource.path) ?? loadedByCanonicalPath.get(canonicalizePath(resource.path));
		byPath.set(resource.path, {
			path: resource.path,
			name: skill?.name ?? skillName(resource.path),
			enabled: resource.enabled,
			loaded: skill,
			metadata: resource.metadata,
		});
	}
	// Claude/Codex/plugin and explicit skills may be supplied by the live resource loader, outside core discovery.
	for (const skill of loaded) {
		if (resolvedCanonicalPaths.has(canonicalizePath(skill.filePath))) continue;
		byPath.set(skill.filePath, {
			path: skill.filePath,
			name: skill.name,
			enabled: true,
			loaded: skill,
			metadata: {
				source: skill.sourceInfo.source,
				scope: skill.sourceInfo.scope,
				origin: "top-level",
				baseDir: skill.sourceInfo.baseDir,
			},
		});
	}
	// Retain command-disabled external skills in the list so they can be enabled again by name or path.
	for (const [scope, paths] of [
		["user", host.session.settingsManager.getGlobalSettings().skills ?? []],
		["project", host.session.settingsManager.getProjectSettings().skills ?? []],
	] as const) {
		for (const pattern of paths) {
			if (!(pattern.startsWith("-") || pattern.startsWith("+")) || !isAbsolute(pattern.slice(1))) continue;
			const path = pattern.slice(1);
			if (!existsSync(path) || byPath.has(path)) continue;
			byPath.set(path, {
				path,
				name: skillName(path),
				enabled: pattern.startsWith("+"),
				metadata: { source: "settings", scope, origin: "top-level" },
			});
		}
	}
	return {
		// Core skills first, then the Octocode collection, then external skills; by name within each.
		entries: [...byPath.values()].sort(
			(a, b) =>
				SKILL_CATEGORIES.indexOf(category(a)) - SKILL_CATEGORIES.indexOf(category(b)) ||
				a.name.localeCompare(b.name) ||
				a.path.localeCompare(b.path),
		),
		resolved,
	};
}

function findEntry(entries: readonly SkillEntry[], query: string): SkillEntry | undefined {
	const matches = entries.filter((entry) => entry.path === query || entry.name === query);
	return matches.length === 1 ? matches[0] : undefined;
}

async function setEnabled(
	host: SkillsHost,
	entry: SkillEntry,
	enabled: boolean,
	resolved: ResolvedResource[],
): Promise<void> {
	if (entry.enabled === enabled) {
		host.showStatus(`${entry.name} is already ${enabled ? "enabled" : "disabled"}.`);
		return;
	}
	if (host.session.isStreaming || host.session.isCompacting) {
		host.showWarning("Wait for the current response to finish before changing skills.");
		return;
	}
	if (entry.metadata.scope === "temporary" || isSyntheticPath(entry.path)) {
		host.showWarning("This session-only skill cannot be changed in settings.");
		return;
	}
	const settings = host.session.settingsManager;
	if (entry.metadata.origin === "package") {
		const groups = buildGroups(
			{ extensions: [], skills: resolved, prompts: [], themes: [] },
			host.runtimeHost.services.agentDir,
		);
		const item = groups
			.flatMap((group) => group.subgroups.flatMap((subgroup) => subgroup.items))
			.find((item) => item.path === entry.path);
		if (!item) {
			host.showWarning("This package skill cannot be changed from /skills; use octocode config.");
			return;
		}
		new ResourceSettings(
			settings,
			host.sessionManager.getCwd(),
			host.runtimeHost.services.agentDir,
			groups,
		).togglePackageResource(item, enabled);
	} else if (entry.metadata.scope === "project") {
		settings.setProjectSkillPaths(withTogglePattern(settings.getProjectSettings().skills ?? [], entry.path, enabled));
	} else {
		settings.setSkillPaths(withTogglePattern(settings.getGlobalSettings().skills ?? [], entry.path, enabled));
	}
	await host.handleReloadCommand();
}

async function inspectEntry(host: SkillsHost, entry: SkillEntry, resolved: ResolvedResource[]): Promise<void> {
	const canUse = entry.loaded?.userInvocable !== false && entry.loaded !== undefined;
	const action = await host.showExtensionSelector(describe(entry), [
		...(canUse ? ["Use skill"] : []),
		entry.enabled ? "Disable" : "Enable",
		"Close",
	]);
	if (action === "Use skill") {
		host.getSlashCommands(true);
		const command = [...host.skillCommands].find(
			([, path]) => canonicalizePath(path) === canonicalizePath(entry.path),
		)?.[0];
		if (!command) {
			host.showWarning("This skill has no user command in the current session.");
			return;
		}
		host.editor.setText(`/${command} `);
		host.ui.requestRender();
		return;
	}
	if (action === "Disable" || action === "Enable") await setEnabled(host, entry, action === "Enable", resolved);
}

/** /skills opens the manager; subcommands inspect and control discovered skills. */
export async function handleSkillsCommand(host: SkillsHost, args: string): Promise<boolean> {
	const match = /^(list|info|enable|disable)(?:\s+([\s\S]+))?$/.exec(args.trim());
	if (!match) return false;
	try {
		const { entries, resolved } = await catalog(host);
		const operation = match[1];
		const query = match[2]?.trim();
		if (operation === "list") {
			const shown = query
				? entries.filter((entry) => `${entry.name} ${entry.path}`.toLowerCase().includes(query.toLowerCase()))
				: entries;
			if (!shown.length) {
				host.showStatus(
					query ? `No skills match "${query}". Use /skills list to see all skills.` : "No skills discovered.",
				);
				return true;
			}
			const labels = shown.map((entry) => `[${state(entry)}] ${entry.name} · ${origin(entry)} · ${entry.path}`);
			const choice = await host.showExtensionSelector("Skills — source and load state", labels);
			const index = choice === undefined ? -1 : labels.indexOf(choice);
			if (index >= 0) await inspectEntry(host, shown[index], resolved);
			return true;
		}
		if (!query) {
			host.showWarning(`Use /skills ${operation} <name-or-path>.`);
			return true;
		}
		const entry = findEntry(entries, query);
		if (!entry) {
			const matches = entries.filter((item) => item.name === query);
			host.showWarning(
				matches.length > 1
					? `Several skills are named ${query}; use an exact path: ${matches.map((item) => item.path).join(", ")}`
					: `Skill not found: ${query}. Use /skills list to see discovered skills.`,
			);
			return true;
		}
		if (operation === "info") {
			await host.showExtensionSelector(describe(entry), ["Close"]);
		} else {
			await setEnabled(host, entry, operation === "enable", resolved);
		}
	} catch (error) {
		host.showError(`Could not inspect skills: ${errorMessage(error)}`);
	}
	return true;
}
