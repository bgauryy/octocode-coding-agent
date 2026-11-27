import { HOOK_EVENTS } from "../hooks/catalog.ts";
import { loadHooks } from "../hooks/config.ts";
import { hookSwitchedOn, hookToggleIds } from "../hooks/config/toggles.ts";
import { discoverPluginComponents } from "../../core/plugin-components.ts";
import { pluginContext } from "../../core/plugin-context.ts";
import { inspectPluginHooks, pluginHookMcpServers } from "../../core/plugin-hooks.ts";
import { resolveConfiguredPlugin } from "../../core/plugin-manifest.ts";
import { inspectPluginMcp } from "../../core/plugin-mcp.ts";
import { loadConfiguredPluginSkills } from "../../core/plugin-resources.ts";
import { configuredPlugins } from "../../core/plugin-settings.ts";
import type { Settings } from "../../core/settings-schema.ts";
import type { InventoryItem } from "../../core/extensibility/inventory-types.ts";
import { effectivePlugins, insideProject, isSwitchedOn, pluginToggleId } from "../../core/extensibility/toggles.ts";

export const count = (items: readonly unknown[], noun: string) =>
	`${items.length} ${noun}${items.length === 1 ? "" : "s"}`;

/** State of one executable component: none declared, unloadable, or loads. */
function componentState(declared: boolean, errors: readonly string[]) {
	if (!declared) return "none";
	return errors.length ? "not loaded (see diagnostics)" : "loads";
}

/** `mcpServers`: the session's registered MCP server names, which a plugin's `mcp_tool` hooks may call. */
export function pluginItems(
	settings: Settings,
	cwd: string,
	notes: string[],
	mcpServers: readonly string[],
	projectTrusted: boolean,
	home?: string,
): InventoryItem[] {
	const toggles = settings.toggles;
	// Every configured plugin's hooks as the loader parses them, ignoring the plugin switch (a row shows what the plugin
	// would run) but not the hook toggles, so the row can count the hooks the host switches left on.
	const all = configuredPlugins(settings.plugins, () => {}).map((entry) => ({ ...entry, enabled: true }));
	const pluginHooks = loadHooks(cwd, projectTrusted, home, { plugins: all }).config;
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
		// The skills the loader would register, counted even while the plugin is off: a declared folder may hold none.
		const skills = loadConfiguredPluginSkills([{ ...entry, enabled: true }]);
		const hooks = inspectPluginHooks(entry);
		const mcp = inspectPluginMcp(entry);
		const provided = new Set([...mcpServers, ...mcp.servers.map(({ name }) => `plugin:${manifest.name}:${name}`)]);
		const missing = pluginHookMcpServers(hooks.definitions)
			.filter((server) => !provided.has(server))
			// Resolution needs the scoped name; a bare key of the plugin's own server is the likely slip.
			.map((server) =>
				mcp.servers.some(({ name }) => name === server)
					? `${server} (did you mean plugin:${manifest.name}:${server}?)`
					: server,
			);
		const identity = pluginContext(manifest, home).id;
		const owned = HOOK_EVENTS.flatMap((event) =>
			pluginHooks[event].flatMap((group) =>
				group.hooks
					.filter((hook) => hook.plugin?.id === identity)
					.map((hook) => ({ hook, event, matcher: group.matcher })),
			),
		);
		const off = owned.filter(({ hook, event, matcher }) => !hookSwitchedOn(event, matcher, hook, toggles, cwd, home));
		const reasons = [
			...new Set(
				off.flatMap(({ hook, event, matcher }) => {
					const ids = hookToggleIds(event, matcher, hook, home);
					const id = ids.find((candidate) => !isSwitchedOn([candidate], toggles, insideProject(hook.source, cwd)));
					return id ? [`${id} off`] : [];
				}),
			),
		];
		const hookState =
			off.length && !hooks.errors.length
				? `${owned.length - off.length} of ${owned.length} on (${reasons.join(", ")})`
				: componentState(hooks.definitions.length > 0, hooks.errors);
		const skillErrors = skills.diagnostics.filter(({ type }) => type === "error").map(({ message }) => message);
		notes.push(...new Set([...errors, ...components.errors, ...skillErrors, ...hooks.errors, ...mcp.errors]));
		return {
			...item,
			name: manifest.name,
			host: manifest.protocol,
			label: `${manifest.name} (plugin, ${manifest.format} manifest)`,
			detail: [
				`${count(skills.skills, "skill")} in ${count(components.skills, "skill directory")}, ${count(components.commands, "command source")}`,
				`hooks ${hookState}`,
				...(missing.length ? [`hooks call MCP servers no one provides: ${missing.join(", ")}`] : []),
				`MCP ${mcp.servers.map((server) => server.name).join(", ") || "none"}: ${componentState(mcp.servers.length > 0, mcp.errors)}`,
				...(components.unsupported.length ? [`not loaded: ${components.unsupported.join(", ")}`] : []),
				entry.path,
			].join(" · "),
		};
	});
}
