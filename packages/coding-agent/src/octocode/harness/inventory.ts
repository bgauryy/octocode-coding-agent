import { existsSync } from "node:fs";
import path from "node:path";
import { canonicalizePath } from "@octocodeai/octocode-common/paths";
import { HOOK_CATALOG, HOOK_EVENTS } from "../hooks/catalog.ts";
import { hookFiles, hookLabel, loadHooks } from "../hooks/config.ts";
import { hookSwitchedOn, hookToggleIds } from "../hooks/config/toggles.ts";
import { homeTilde } from "@octocodeai/octocode-common/home-tilde";
import { repoKey } from "../../utils/git-repository.ts";
import { clipText } from "@octocodeai/octocode-common/clip";
import { DefaultPackageManager } from "../../core/package-manager.ts";
import { buildGroups } from "../../core/package-manager/resource-groups.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import type { Settings } from "../../core/settings-schema.ts";
import { getOctocodeSkillsDir } from "../../config.ts";
import { collectionSkillDetail, coreSkillItems } from "../../core/extensibility/core-skill-items.ts";
import { hostInstalledPlugins } from "../../core/extensibility/host-plugins.ts";
import { markLosingSkills } from "./skill-duplicates.ts";
import { vendorItems } from "./vendor-items.ts";
import { mcpItems } from "./mcp-items.ts";
import type { McpServerStatus } from "../../../../mcp/src/api.ts";
import { configDiscovery, discoveryInput } from "../../core/discovery/service.ts";
import type { DiscoverInput } from "../../core/discovery/types.ts";
import { harnessStatuses } from "../../core/discovery/vendors/index.ts";
import {
	EMPTY_INVENTORY,
	type Inventory,
	type InventoryHost,
	type InventoryItem,
} from "../../core/extensibility/inventory-types.ts";
import { count, pluginItems } from "./plugin-items.ts";
import {
	effectivePlugins,
	hookHostToggleId,
	hookSourceToggleId,
	insideProject,
	isSwitchedOn,
	PROJECT_TOGGLE_PREFIX,
	type ToggleHost,
} from "../../core/extensibility/toggles.ts";

export { type Inventory, type InventoryHost, type InventoryItem } from "../../core/extensibility/inventory-types.ts";
/** Headings in display order. */
export const HOST_TITLES: Record<InventoryHost, string> = {
	harness: "Harnesses",
	claude: "Claude Code",
	codex: "Codex",
	octocode: "Octocode",
	packages: "Packages",
	mcp: "MCP servers",
	skills: "Skills",
};
/**
 * A switched-off harness's hooks do not load, whatever their own switches say: their rows read off and name the harness.
 * Their own switches stay editable and apply once the harness is on.
 */
function harnessOff(item: InventoryItem): InventoryItem {
	const title = HOST_TITLES[item.host];
	return {
		...item,
		on: false,
		detail: `off: ${title} harness switched off${item.detail ? ` · ${item.detail}` : ""}`,
	};
}

function hookItems(
	settings: Settings,
	cwd: string,
	projectTrusted: boolean,
	hostOn: (host: ToggleHost) => boolean,
	home?: string,
): InventoryItem[] {
	const toggles = settings.toggles;
	const { config } = loadHooks(cwd, projectTrusted, home, { plugins: effectivePlugins(settings, cwd) });
	const byHost = new Map<ToggleHost, Map<string, { project: boolean; label: string; hooks: InventoryItem[] }>>();
	for (const event of HOOK_EVENTS)
		for (const group of config[event])
			for (const hook of group.hooks) {
				const host = hook.protocol ?? "octocode";
				const source = homeTilde(hook.source, home);
				const files =
					byHost.get(host) ?? new Map<string, { project: boolean; label: string; hooks: InventoryItem[] }>();
				byHost.set(host, files);
				const project = insideProject(hook.source, cwd);
				const file = files.get(source) ?? {
					project,
					// Repository files read best relative to the repository, user files relative to home.
					label: project ? `${path.relative(repoKey(cwd).root, hook.source)} (project)` : source,
					hooks: [],
				};
				files.set(source, file);
				const gate = "gate" in HOOK_CATALOG[event] && (hook.failClosed === true || hook.onFailure === "block");
				file.hooks.push({
					id: hookToggleIds(event, group.matcher, hook, home)[0],
					parents: hookToggleIds(event, group.matcher, hook, home).slice(1),
					host,
					kind: "hook",
					depth: 2,
					label: `${event} [${group.matcher || "*"}] ${clipText(hookLabel(hook), 48)}`,
					on: hookSwitchedOn(event, group.matcher, hook, toggles, cwd, home),
					detail: [...(gate ? ["gate: denies when it fails"] : []), hookLabel(hook)].join(" · "),
					...(file.project ? { project: true as const } : {}),
					...(gate ? { gate: true as const } : {}),
				});
			}
	const items: InventoryItem[] = [];
	for (const [host, files] of byHost) {
		const hostId = hookHostToggleId(host);
		const total = [...files.values()].reduce((sum, file) => sum + file.hooks.length, 0);
		const hostItems: InventoryItem[] = [];
		hostItems.push({
			id: hostId,
			host,
			kind: "hooks",
			depth: 0,
			label: `Hooks from ${HOST_TITLES[host]}`,
			on: isSwitchedOn([hostId], toggles, false),
			detail: `${total} hook${total === 1 ? "" : "s"} in ${count([...files.keys()], "file")}`,
		});
		for (const [source, file] of files) {
			const id = hookSourceToggleId(host, source);
			hostItems.push(
				{
					id,
					host,
					kind: "hook-file",
					depth: 1,
					label: file.label,
					on: isSwitchedOn([id, hostId], toggles, file.project),
					parents: [hostId],
					detail: `${count(file.hooks, "hook")}${file.project ? " · project" : ""}`,
					...(file.project ? { project: true as const } : {}),
				},
				...file.hooks,
			);
		}
		items.push(...(hostOn(host) ? hostItems : hostItems.map(harnessOff)));
	}
	const trusted = new Set(hookFiles(cwd, projectTrusted, home));
	for (const file of hookFiles(cwd, true, home).filter((candidate) => !trusted.has(candidate)))
		items.push({
			id: `untrusted:${homeTilde(file, home)}`,
			host: "octocode",
			kind: "hook-file",
			depth: 1,
			label: homeTilde(file, home),
			on: false,
			detail: "project not trusted",
			locked: "trust this project first (/trust)",
		});
	return items;
}

/**
 * Pi's global skills that discovery keeps (Pi harness on, not shadowed by another harness). The session resolves them
 * with Pi's own settings (the Pi fallback in `FeatureSetLoader`), so this does the same to read their state; the package
 * resolver has no row for them. They are read-only because Octocode never writes Pi's files.
 */
async function piSkillItems(input: DiscoverInput, cwd: string, home?: string): Promise<InventoryItem[]> {
	const names = new Map(
		configDiscovery
			.discover("skill", input)
			.filter(({ loaded, provenance }) => loaded && provenance.product === "pi" && provenance.scope === "global")
			.map((item) => [canonicalizePath(item.provenance.path), item.name]),
	);
	if (names.size === 0) return [];
	const items: InventoryItem[] = [];
	for (const piDir of input.piRoots) {
		if (!existsSync(piDir)) continue;
		const settingsManager = SettingsManager.create(cwd, piDir, { projectTrusted: false });
		const { skills } = await new DefaultPackageManager({ cwd, agentDir: piDir, settingsManager }).resolve(
			async () => "skip",
		);
		for (const skill of skills) {
			const name = names.get(canonicalizePath(skill.path));
			if (name === undefined || items.some((item) => item.id === `skill:${homeTilde(skill.path, home)}`)) continue;
			items.push({
				id: `skill:${homeTilde(skill.path, home)}`,
				name,
				host: "skills",
				kind: "skill",
				depth: 0,
				label: name,
				on: skill.enabled,
				detail: `Pi (global) · ${homeTilde(skill.path, home)}`,
				locked: "Pi's own settings decide this skill; switching the Pi harness (harness:pi) off drops every Pi skill.",
			});
		}
	}
	return items;
}

/** Skills from the package resolver, switched by the `skills` patterns. */
async function resourceItems(
	manager: SettingsManager,
	cwd: string,
	agentDir: string,
	extraSkills: readonly InventoryItem[],
): Promise<InventoryItem[]> {
	// "skip": listing must never install a missing package source.
	const resolved = await new DefaultPackageManager({
		cwd,
		agentDir,
		settingsManager: manager,
		builtinSkillsDir: getOctocodeSkillsDir(),
	}).resolve(async () => "skip");
	const skills = buildGroups(resolved, agentDir).flatMap((group) =>
		group.subgroups
			.filter((subgroup) => subgroup.type === "skills")
			.flatMap((subgroup) =>
				subgroup.items.map((resource): InventoryItem => ({
					id: `skill:${homeTilde(resource.path)}`,
					name: resource.displayName,
					host: "skills",
					kind: "skill",
					depth: 0,
					label: resource.displayName,
					on: resource.enabled,
					detail: collectionSkillDetail(resource) ?? `${group.label} · ${homeTilde(resource.path)}`,
					...(resource.metadata.scope === "project" ? { project: true as const } : {}),
					resource,
				})),
			),
	);
	// Skills read best alphabetically; the detail names the folder each comes from.
	return [...skills, ...extraSkills].sort((a, b) => a.label.localeCompare(b.label));
}

/** Everything `/harness` lists, from the same loaders the session uses; nothing is installed or executed. */
export async function buildInventory(options: {
	cwd: string;
	agentDir: string;
	/** The session's merged settings (in-memory SDK settings included). */
	settings: Settings;
	/** File-backed settings for package resolution and writes. */
	manager: SettingsManager;
	projectTrusted: boolean;
	/** The session's MCP registry snapshot; omitted when no MCP owner runs. */
	mcp?: readonly McpServerStatus[];
	home?: string;
}): Promise<Inventory> {
	const notes: string[] = [];
	const configured = new Set((options.settings.plugins ?? []).map((entry) => path.resolve(entry.path)));
	const input = discoveryInput({
		cwd: options.cwd,
		agentDir: options.agentDir,
		projectTrusted: options.projectTrusted,
		...(options.home ? { home: options.home } : {}),
		...(options.settings.toggles ? { toggles: options.settings.toggles } : {}),
		builtinSkillsDir: getOctocodeSkillsDir(),
	});
	const statuses = harnessStatuses(input);
	const rows = [
		...vendorItems(statuses, options.settings.toggles),
		...pluginItems(
			options.settings,
			options.cwd,
			notes,
			(options.mcp ?? []).map(({ name }) => name),
			options.projectTrusted,
			options.home,
		),
		...hostInstalledPlugins(options.home)
			.filter((plugin) => !configured.has(plugin.path))
			.map((plugin): InventoryItem => ({
				id: `installed:${plugin.path}`,
				host: plugin.host,
				kind: "plugin",
				depth: 0,
				label: `${plugin.id} (installed in ${HOST_TITLES[plugin.host]})`,
				on: false,
				detail: `${plugin.enabledThere ? "enabled" : "disabled"} there · not added to Octocode; switch on to add it (adding approves its hooks and MCP servers)`,
				install: { path: plugin.path, protocol: plugin.protocol },
			})),
		...hookItems(
			options.settings,
			options.cwd,
			options.projectTrusted,
			(host) => statuses.find((status) => status.id === host)?.on !== false,
			options.home,
		),
		...(await resourceItems(options.manager, options.cwd, options.agentDir, [
			...coreSkillItems(options.manager),
			...(await piSkillItems(input, options.cwd, options.home)),
		])),
		...mcpItems(options.mcp ?? [], options.home),
	];
	const ids = new Set(rows.map((item) => item.id));
	const projectIds = new Set(rows.filter((item) => item.project).map((item) => item.id));
	const keys = Object.keys(options.settings.toggles ?? {});
	const ignored = keys
		.filter((key) => key.startsWith(PROJECT_TOGGLE_PREFIX))
		.map((key) => key.slice(PROJECT_TOGGLE_PREFIX.length))
		// A project host key (`hooks:claude`) still reaches the project's own files; other keys need a project item.
		.filter((id) => ids.has(id) && !projectIds.has(id) && !/^hooks:[a-z]+$/.test(id));
	const stale = keys
		.map((key) => (key.startsWith(PROJECT_TOGGLE_PREFIX) ? key.slice(PROJECT_TOGGLE_PREFIX.length) : key))
		.filter((id) => !ids.has(id));
	return { items: markLosingSkills(rows, options.agentDir), stale: [...new Set(stale)], ignored, notes };
}

/**
 * The inventory as text, grouped by heading, one ID per row. `items` narrows the
 * rows (`/harness list skills`); stale switches, ignored keys and diagnostics show only in the full listing.
 */
export function renderInventory(inventory: Inventory, items: readonly InventoryItem[] = inventory.items): string {
	const full = items === inventory.items;
	const lines: string[] = [];
	for (const host of Object.keys(HOST_TITLES) as InventoryHost[]) {
		const rows = items.filter((item) => item.host === host);
		if (!rows.length) continue;
		lines.push(HOST_TITLES[host]);
		for (const item of rows)
			lines.push(
				`${"  ".repeat(item.depth + 1)}[${item.locked ? "-" : item.on ? "x" : " "}] ${item.label}${item.detail ? ` — ${item.detail}` : ""}  ${item.id}`,
			);
	}
	if (!lines.length) lines.push(full ? EMPTY_INVENTORY : "No items match.");
	if (full && inventory.stale.length)
		lines.push(
			"",
			"Stale switches (they match nothing now; remove the key from `toggles` in settings.json to clear one):",
			...inventory.stale.map((id) => `  ${id}`),
		);
	if (full && inventory.ignored.length)
		lines.push(
			"",
			"Project switches ignored (they target items outside this repository):",
			...inventory.ignored.map((id) => `  ${id}`),
		);
	if (full && inventory.notes.length) lines.push("", "Diagnostics:", ...inventory.notes.map((note) => `  ${note}`));
	lines.push(
		"",
		"/harness in the terminal switches these rows; elsewhere /configuration enable|disable <kind:name>... [--local] (/configuration list shows its ids) · MCP switches apply now; /reload applies the rest",
	);
	return lines.join("\n");
}
