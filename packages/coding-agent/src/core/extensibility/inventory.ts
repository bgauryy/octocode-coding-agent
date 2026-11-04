import path from "node:path";
import { HOOK_CATALOG, HOOK_EVENTS } from "../../octocode/hooks/catalog.ts";
import { hookFiles, hookLabel, loadHooks } from "../../octocode/hooks/config.ts";
import { hookSwitchedOn, hookToggleIds } from "../../octocode/hooks/config/toggles.ts";
import { tildePath } from "../../octocode/shared/home.ts";
import { repoKey } from "../../octocode/shared/home/repo.ts";
import { clipText } from "../../octocode/shared/util.ts";
import { DefaultPackageManager } from "../package-manager.ts";
import { buildGroups } from "../package-manager/resource-groups.ts";
import { BUILTIN_FEATURE_IDS } from "../features/builtin-ids.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { Settings } from "../settings-schema.ts";
import { hostInstalledPlugins } from "./host-plugins.ts";
import { hostSkillItems } from "../../octocode/harness/host-skills.ts";
import { EMPTY_INVENTORY, type Inventory, type InventoryHost, type InventoryItem } from "./inventory-types.ts";
import { count, pluginItems } from "../../octocode/harness/plugin-items.ts";

import {
	effectivePlugins,
	hookHostToggleId,
	hookSourceToggleId,
	insideProject,
	isSwitchedOn,
	PROJECT_TOGGLE_PREFIX,
	type ToggleHost,
} from "./toggles.ts";

export { EMPTY_INVENTORY, type Inventory, type InventoryHost, type InventoryItem } from "./inventory-types.ts";

/** Headings in display order. */
export const HOST_TITLES: Record<InventoryHost, string> = {
	claude: "Claude Code",
	codex: "Codex",
	octocode: "Octocode",
	packages: "Packages",
	mcp: "MCP servers",
	skills: "Skills",
};
function hookItems(settings: Settings, cwd: string, projectTrusted: boolean, home?: string): InventoryItem[] {
	const toggles = settings.toggles;
	const { config } = loadHooks(cwd, projectTrusted, home, { plugins: effectivePlugins(settings, cwd) });
	const byHost = new Map<ToggleHost, Map<string, { project: boolean; label: string; hooks: InventoryItem[] }>>();
	for (const event of HOOK_EVENTS)
		for (const group of config[event])
			for (const hook of group.hooks) {
				const host = hook.protocol ?? "octocode";
				const source = tildePath(hook.source, home);
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
		items.push({
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
			items.push(
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
	}
	const trusted = new Set(hookFiles(cwd, projectTrusted, home));
	for (const file of hookFiles(cwd, true, home).filter((candidate) => !trusted.has(candidate)))
		items.push({
			id: `untrusted:${tildePath(file, home)}`,
			host: "octocode",
			kind: "hook-file",
			depth: 1,
			label: tildePath(file, home),
			on: false,
			detail: "project not trusted",
			locked: "trust this project first (/trust)",
		});
	return items;
}

/** Extensions and skills from the package resolver, switched by the `extensions` and `skills` patterns. */
async function resourceItems(manager: SettingsManager, cwd: string, agentDir: string): Promise<InventoryItem[]> {
	const builtinExtensions = [...BUILTIN_FEATURE_IDS];
	// "skip": listing must never install a missing package source.
	const resolved = await new DefaultPackageManager({
		cwd,
		agentDir,
		settingsManager: manager,
		builtinExtensions,
	}).resolve(async () => "skip");
	const groups = buildGroups(resolved, agentDir);
	const rows = (type: "extensions" | "skills") =>
		groups.flatMap((group) =>
			group.subgroups
				.filter((subgroup) => subgroup.type === type)
				.flatMap((subgroup) =>
					subgroup.items.map((resource): InventoryItem =>
						type === "skills"
							? {
									id: `skill:${tildePath(resource.path)}`,
									name: resource.displayName,
									host: "skills",
									kind: "skill",
									depth: 0,
									label: resource.displayName,
									on: resource.enabled,
									detail: `${group.label} · ${tildePath(resource.path)}`,
									...(resource.metadata.scope === "project" ? { project: true as const } : {}),
									resource,
								}
							: {
									id: `extension:${tildePath(resource.path)}`,
									host: group.origin === "package" ? "packages" : "octocode",
									kind: "extension",
									depth: 0,
									label: `${resource.displayName} (extension)`,
									on: resource.enabled,
									detail: `${group.label} · ${group.scope}`,
									resource,
								},
					),
				),
		);
	// Skills read best alphabetically; the detail names the folder each comes from.
	return [...rows("extensions"), ...rows("skills").sort((a, b) => a.label.localeCompare(b.label))];
}

/** What an MCP row reads of a server in the MCP host's status snapshot (core does not import the MCP package). */
interface McpRowSource {
	name: string;
	enabled: boolean;
	state: string;
	toolCount: number;
	exposure: string;
	scope?: string;
	source: string;
}

/**
 * One `mcp:<name>` row per MCP server in the session's registry snapshot. The MCP owner keeps its own `enabled` setting
 * (in the server's `mcp.json` or a project override) and applies a switch at once, so these rows carry no `toggles` key.
 */
function mcpItems(servers: readonly McpRowSource[], home?: string): InventoryItem[] {
	return servers.map((server) => ({
		id: `mcp:${server.name}`,
		name: server.name,
		host: "mcp",
		kind: "mcp",
		depth: 0,
		label: server.name,
		on: server.enabled,
		detail: [
			server.state,
			`${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`,
			server.exposure,
			server.scope ?? "configured",
			server.scope === "default" ? "built in" : tildePath(server.source, home),
		].join(" · "),
	}));
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
	mcp?: readonly McpRowSource[];
	home?: string;
}): Promise<Inventory> {
	const notes: string[] = [];
	const configured = new Set((options.settings.plugins ?? []).map((entry) => path.resolve(entry.path)));
	const items = [
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
		...hookItems(options.settings, options.cwd, options.projectTrusted, options.home),
		...(await resourceItems(options.manager, options.cwd, options.agentDir)),
		...hostSkillItems(options.cwd, options.agentDir, options.projectTrusted, options.home),
		...mcpItems(options.mcp ?? [], options.home),
	];
	const ids = new Set(items.map((item) => item.id));
	const projectIds = new Set(items.filter((item) => item.project).map((item) => item.id));
	const keys = Object.keys(options.settings.toggles ?? {});
	const ignored = keys
		.filter((key) => key.startsWith(PROJECT_TOGGLE_PREFIX))
		.map((key) => key.slice(PROJECT_TOGGLE_PREFIX.length))
		// A project host key (`hooks:claude`) still reaches the project's own files; other keys need a project item.
		.filter((id) => ids.has(id) && !projectIds.has(id) && !/^hooks:[a-z]+$/.test(id));
	const stale = keys
		.map((key) => (key.startsWith(PROJECT_TOGGLE_PREFIX) ? key.slice(PROJECT_TOGGLE_PREFIX.length) : key))
		.filter((id) => !ids.has(id));
	return { items, stale: [...new Set(stale)], ignored, notes };
}

/**
 * The inventory as text, grouped by heading, one ID per row for `/harness enable|disable <id>`. `items` narrows the
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
	if (!lines.length) lines.push(full ? EMPTY_INVENTORY : "Nothing matches.");
	if (full && inventory.stale.length)
		lines.push(
			"",
			"Stale switches (they match nothing now; /harness enable <id> clears one):",
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
		"/harness enable|disable <id|name>... [--local] [--force] · MCP switches apply now; /reload applies the rest",
	);
	return lines.join("\n");
}
