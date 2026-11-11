// MCP config code reads files through the host ports; a process without a session (the web daemon) has not installed them.
import "../../octocode/mcp-host/core-install.ts";
import {
	addMcpServerConfig,
	loadMcpConfig,
	removeMcpServerConfig,
	updateMcpServerConfig,
	writableSource,
	type LoadedMcpConfig,
	type McpServerEntry,
	globalMcpConfigPath,
	projectMcpConfigPath,
	presetEntries,
	browserPreset,
	recommendedPresets,
	mcpGroupLabel,
	mcpServerGroup,
	mcpServerSource,
	isEnabled,
	validateMcpServerConfig,
} from "../../../../mcp/src/api.ts";
import { applied, closestIds, nameOf, refused } from "../result.ts";
import type { ConfigAdapter, ConfigContext, ConfigEntry, ConfigOp, ConfigResult, ConfigScope } from "../types.ts";
import { homeTilde } from "../../../../common/src/home-tilde.ts";

/** The configured servers, as a session started in `ctx.cwd` loads them; connects nothing. */
export const loadMcpServers = (ctx: ConfigContext): LoadedMcpConfig =>
	loadMcpConfig({
		agentDir: ctx.agentDir,
		cwd: ctx.cwd,
		projectTrusted: ctx.projectTrusted,
		defaults: presetEntries([...recommendedPresets(), browserPreset()]),
	});

/** The scope whose file decides the entry's state. */
function ownerScope(entry: McpServerEntry): ConfigScope | "default" {
	if (entry.override) return entry.overrideScope ?? "project";
	return entry.scope === "project" ? "project" : entry.scope === "global" ? "global" : "default";
}

/**
 * Where an enable/disable lands, as `octocode mcp enable` decides: another agent's file is never written, a change
 * becomes an override in Octocode's own file of that scope.
 */
export function switchTarget(
	entry: McpServerEntry,
	loaded: LoadedMcpConfig,
	scope: ConfigScope,
	ctx: ConfigContext,
): string {
	const projectConfig = loaded.projectConfig ?? projectMcpConfigPath(ctx.cwd);
	const ownProject = entry.scope === "project" ? writableSource(entry) : undefined;
	const projectOverride = entry.override && entry.overrideScope !== "global";
	if (scope === "project") return ownProject ?? projectConfig;
	if (projectOverride) return entry.override!;
	if (entry.scope === "project") return ownProject ?? projectConfig;
	return loaded.globalConfig ?? globalMcpConfigPath(ctx.agentDir);
}

async function enableDisable(op: ConfigOp, ctx: ConfigContext): Promise<ConfigResult> {
	const name = nameOf(op.id);
	const scope = op.scope ?? "global";
	if (scope === "run")
		return refused(
			op,
			"MCP servers have no per-run form here: the MCP owner saves every switch. Use global or project scope.",
		);
	const enabled = op.verb === "enable";
	const loaded = loadMcpServers(ctx);
	const entry = loaded.servers.find((server) => server.name === name);
	if (!entry)
		return refused(
			op,
			`No MCP server named "${name}".`,
			closestIds(
				op.id,
				loaded.servers.map((server) => `mcp:${server.name}`),
			),
		);
	if (ctx.live?.mcpSwitch) {
		const result = await ctx.live.mcpSwitch({ name, enabled, inProject: scope === "project" });
		return result.ok ? applied(op, "now", result.message) : refused(op, result.message);
	}
	const target = switchTarget(entry, loaded, scope, ctx);
	try {
		updateMcpServerConfig(target, name, { enabled }, { override: target !== entry.source });
	} catch (error) {
		return refused(op, `Could not update ${target}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return applied(
		op,
		"next-session",
		`MCP server "${name}" ${enabled ? "enabled" : "disabled"}. Saved to ${target}; running sessions keep their configuration.`,
	);
}

export const mcpAdapter: ConfigAdapter = {
	kinds: ["mcp"],
	async list(ctx) {
		return loadMcpServers(ctx).servers.map((entry): ConfigEntry => {
			const enabled = isEnabled({ entry });
			const setBy = ownerScope(entry);
			return {
				id: `mcp:${entry.name}`,
				kind: "mcp",
				label: entry.name,
				valueType: { type: "toggle" },
				value: enabled,
				scopes: setBy === "default" ? {} : { [setBy]: enabled },
				setBy,
				default: true,
				appliesWhen: ctx.live?.mcpSwitch ? "now" : "next-session",
				// The same words as the `/harness` row: `Core · built in`, `Global · ~/.octocode/mcp.json`.
				detail: `${mcpGroupLabel(mcpServerGroup(entry))} · ${mcpServerSource(entry, (file) => homeTilde(file))}`,
			};
		});
	},
	async apply(op, ctx) {
		const scope = op.scope ?? "global";
		const name = nameOf(op.id);
		switch (op.verb) {
			case "enable":
			case "disable":
				return enableDisable(op, ctx);
			case "add": {
				// The value is what `octocode mcp add` builds from its flags: `{ url, headers?, oauth? }` or `{ command, args?, env?, cwd? }`.
				const config = op.value && typeof op.value === "object" ? (op.value as Record<string, unknown>) : undefined;
				if (!config) return refused(op, "add needs the server definition: { command, args } or { url }.");
				const validated = validateMcpServerConfig(name, config);
				if (typeof validated === "string") return refused(op, validated);
				const path = scope === "project" ? projectMcpConfigPath(ctx.cwd) : globalMcpConfigPath(ctx.agentDir);
				try {
					const replaced = addMcpServerConfig(path, name, validated);
					return applied(op, "reload", `${replaced ? "Replaced" : "Added"} ${scope} MCP server "${name}" in ${path}.`);
				} catch (error) {
					return refused(op, `Could not update ${path}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			case "remove": {
				const path = scope === "project" ? projectMcpConfigPath(ctx.cwd) : globalMcpConfigPath(ctx.agentDir);
				try {
					return removeMcpServerConfig(path, name)
						? applied(op, "reload", `Removed ${scope} MCP server "${name}" from ${path}.`)
						: refused(
								op,
								`No ${scope} MCP server named "${name}" in ${path}.`,
								closestIds(
									op.id,
									(await this.list(ctx)).map((entry) => entry.id),
								),
							);
				} catch (error) {
					return refused(op, `Could not update ${path}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			default:
				return refused(op, `MCP servers take enable, disable, add and remove, not "${op.verb}".`);
		}
	},
};
