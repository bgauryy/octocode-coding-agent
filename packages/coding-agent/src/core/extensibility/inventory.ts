import path from "node:path";
import { getBundledSkillsDir } from "../../config.ts";
import { HOOK_CATALOG, HOOK_EVENTS } from "../../octocode/hooks/catalog.ts";
import { hookFiles, hookLabel, loadHooks } from "../../octocode/hooks/config.ts";
import { hookSwitchedOn, hookToggleIds } from "../../octocode/hooks/config/toggles.ts";
import { tildePath } from "../../octocode/shared/home.ts";
import { repoKey } from "../../octocode/shared/home/repo.ts";
import { clipText } from "../../octocode/shared/util.ts";
import { DefaultPackageManager } from "../package-manager.ts";
import { buildGroups, type ResourceItem } from "../package-manager/resource-groups.ts";
import { discoverPluginComponents } from "../plugin-components.ts";
import { inspectPluginHooks } from "../plugin-hooks.ts";
import { resolveConfiguredPlugin } from "../plugin-manifest.ts";
import { inspectPluginMcp } from "../plugin-mcp.ts";
import { configuredPlugins } from "../plugin-settings.ts";
import { resolveExtensionFactories } from "../resource-loader/builtins.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { Settings } from "../settings-schema.ts";
import { hostInstalledPlugins } from "./host-plugins.ts";
import {
	effectivePlugins,
	hookHostToggleId,
	hookSourceToggleId,
	insideProject,
	isSwitchedOn,
	pluginToggleId,
	PROJECT_TOGGLE_PREFIX,
	type ToggleHost,
} from "./toggles.ts";

export type InventoryHost = ToggleHost | "packages";

/** One row of `/plugins`: something the user can switch, with what decides it and why it is in its state. */
export interface InventoryItem {
	id: string;
	host: InventoryHost;
	kind: "plugin" | "extension" | "hooks" | "hook-file" | "hook";
	label: string;
	/** 0 host-level, 1 a file or container, 2 one handler. */
	depth: 0 | 1 | 2;
	on: boolean;
	/** Short state beside the switch: review state, unsupported parts, scope. */
	detail: string;
	/** Supplied by the repository: project switches reach it. */
	project?: true;
	/** A hook that denies when it fails: switching it off needs confirmation. */
	gate?: true;
	/** Why the row cannot be switched (an untrusted project file). */
	locked?: string;
	/** The broader toggle keys that decide this item when its own key is unset, most specific first. */
	parents?: string[];
	/** For extensions: the resource the existing `extensions` patterns switch. */
	resource?: ResourceItem;
	/** For a plugin another host installed: the `plugins` entry switching it on adds. */
	install?: { path: string; protocol: "claude" | "codex" };
}

export interface Inventory {
	items: InventoryItem[];
	/** Toggle keys that match no item (an edited hook or a removed plugin). */
	stale: string[];
	/** Project keys ignored because they target items outside the repository. */
	ignored: string[];
	notes: string[];
}

export const EMPTY_INVENTORY =
	'Nothing configured yet. Add plugins under "plugins" in settings.json, hooks in a hook file, or extensions in extensions/.';

export const HOST_TITLES: Record<InventoryHost, string> = {
	claude: "Claude Code",
	codex: "Codex",
	octocode: "Octocode",
	packages: "Packages",
};
const count = (items: readonly unknown[], noun: string) => `${items.length} ${noun}${items.length === 1 ? "" : "s"}`;

/** Approval state of one executable component: none declared, approved, or the fingerprint to review and copy. */
function approval(declared: boolean, approved: string | undefined, fingerprint: string | undefined, field: string) {
	if (!declared) return "none";
	if (!fingerprint) return "not approvable (see diagnostics)";
	return approved === fingerprint ? "approved" : `needs review: ${field}=${fingerprint}`;
}

function pluginItems(settings: Settings, cwd: string, notes: string[]): InventoryItem[] {
	const on = new Map(
		(effectivePlugins(settings, cwd) ?? []).map((entry) => [entry.path, entry.enabled !== false] as const),
	);
	return configuredPlugins(settings.plugins, (message) => notes.push(message)).map((entry) => {
		const item = {
			id: pluginToggleId(entry.path),
			kind: "plugin" as const,
			depth: 0 as const,
			on: !!on.get(entry.path),
			...(insideProject(entry.path, cwd) ? { project: true as const } : {}),
		};
		const { manifest, failure, errors } = resolveConfiguredPlugin(entry);
		if (!manifest)
			return {
				...item,
				host: entry.protocol,
				label: entry.path,
				detail: [failure, ...errors].filter(Boolean).join("; "),
			};
		const components = discoverPluginComponents(manifest);
		const hooks = inspectPluginHooks(entry);
		const mcp = inspectPluginMcp(entry);
		notes.push(...new Set([...errors, ...components.errors, ...hooks.errors, ...mcp.errors]));
		return {
			...item,
			host: manifest.protocol,
			label: `${manifest.name} (plugin, ${manifest.format} manifest)`,
			detail: [
				`${count(components.skills, "skill directory")}, ${count(components.commands, "command source")}`,
				`hooks ${approval(hooks.definitions.length > 0, entry.hooksFingerprint, hooks.fingerprint, "hooksFingerprint")}`,
				`MCP ${mcp.servers.map((server) => server.name).join(", ") || "none"}: ${approval(mcp.servers.length > 0, entry.mcpFingerprint, mcp.fingerprint, "mcpFingerprint")}`,
				...(components.unsupported.length ? [`not loaded: ${components.unsupported.join(", ")}`] : []),
				entry.path,
			].join(" · "),
		};
	});
}

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

async function extensionItems(manager: SettingsManager, cwd: string, agentDir: string): Promise<InventoryItem[]> {
	const builtinExtensions = [...resolveExtensionFactories(undefined).builtinExtensions.keys()];
	// "skip": listing must never install a missing package source.
	const resolved = await new DefaultPackageManager({
		cwd,
		agentDir,
		settingsManager: manager,
		builtinExtensions,
		builtinSkillsDir: getBundledSkillsDir(),
	}).resolve(async () => "skip");
	return buildGroups(resolved, agentDir).flatMap((group) =>
		group.subgroups
			.filter((subgroup) => subgroup.type === "extensions")
			.flatMap((subgroup) =>
				subgroup.items.map((resource): InventoryItem => ({
					id: `extension:${tildePath(resource.path)}`,
					host: group.origin === "package" ? "packages" : "octocode",
					kind: "extension",
					depth: 0,
					label: `${resource.displayName} (extension)`,
					on: resource.enabled,
					detail: `${group.label} · ${group.scope}`,
					resource,
				})),
			),
	);
}

/** Everything `/plugins` lists, from the same loaders the session uses; nothing is installed or executed. */
export async function buildInventory(options: {
	cwd: string;
	agentDir: string;
	/** The session's merged settings (in-memory SDK settings included). */
	settings: Settings;
	/** File-backed settings for package resolution and writes. */
	manager: SettingsManager;
	projectTrusted: boolean;
	home?: string;
}): Promise<Inventory> {
	const notes: string[] = [];
	const configured = new Set((options.settings.plugins ?? []).map((entry) => path.resolve(entry.path)));
	const items = [
		...pluginItems(options.settings, options.cwd, notes),
		...hostInstalledPlugins(options.home)
			.filter((plugin) => !configured.has(plugin.path))
			.map((plugin): InventoryItem => ({
				id: `installed:${plugin.path}`,
				host: plugin.host,
				kind: "plugin",
				depth: 0,
				label: `${plugin.id} (installed in ${HOST_TITLES[plugin.host]})`,
				on: false,
				detail: `${plugin.enabledThere ? "enabled" : "disabled"} there · not added to Octocode; switch on to add it (hooks and MCP still need review)`,
				install: { path: plugin.path, protocol: plugin.protocol },
			})),
		...hookItems(options.settings, options.cwd, options.projectTrusted, options.home),
		...(await extensionItems(options.manager, options.cwd, options.agentDir)),
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

/** The inventory as text, grouped by host, one ID per row for `/plugins enable|disable <id>`. */
export function renderInventory(inventory: Inventory): string {
	const lines: string[] = [];
	for (const host of Object.keys(HOST_TITLES) as InventoryHost[]) {
		const rows = inventory.items.filter((item) => item.host === host);
		if (!rows.length) continue;
		lines.push(HOST_TITLES[host]);
		for (const item of rows)
			lines.push(
				`${"  ".repeat(item.depth + 1)}[${item.locked ? "-" : item.on ? "x" : " "}] ${item.label}${item.detail ? ` — ${item.detail}` : ""}  ${item.id}`,
			);
	}
	if (!lines.length) lines.push(EMPTY_INVENTORY);
	if (inventory.stale.length)
		lines.push(
			"",
			"Stale switches (they match nothing now; /plugins enable <id> clears one):",
			...inventory.stale.map((id) => `  ${id}`),
		);
	if (inventory.ignored.length)
		lines.push(
			"",
			"Project switches ignored (they target items outside this repository):",
			...inventory.ignored.map((id) => `  ${id}`),
		);
	if (inventory.notes.length) lines.push("", "Diagnostics:", ...inventory.notes.map((note) => `  ${note}`));
	lines.push("", "/plugins enable|disable <id> [--local] [--force] · /reload applies changes");
	return lines.join("\n");
}
