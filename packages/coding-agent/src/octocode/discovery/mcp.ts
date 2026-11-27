import { makeItem } from "../../core/discovery/roots.ts";
import type { ConfigItem, DiscoverInput } from "../../core/discovery/types.ts";
import {
	listMcpFileEntries,
	loadMcpConfig,
	mcpLaunchIdentity,
	mcpConfigFiles,
	presetEntries,
	builtinPresets,
} from "../../../../mcp/src/api.ts";

const FOREIGN_VENDORS: ReadonlySet<string> = new Set(["claude", "codex", "cursor"]);

/**
 * The server that loads for each launch identity, as the loader (`loadMcpConfig`, with the built-in defaults) decides, so
 * a foreign server it drops for launching what another loaded server launches is listed as shadowed by that server's file.
 */
function loadedByLaunch(input: DiscoverInput): Map<string, { name: string; source: string }> {
	const loaded = loadMcpConfig({
		agentDir: input.agentDir,
		cwd: input.cwd,
		projectTrusted: input.projectTrusted,
		defaults: presetEntries(builtinPresets()),
	});
	const byLaunch = new Map<string, { name: string; source: string }>();
	for (const server of loaded.servers) {
		const launch = mcpLaunchIdentity(server.config, input.cwd);
		if (!byLaunch.has(launch)) byLaunch.set(launch, { name: server.name, source: server.source });
	}
	return byLaunch;
}

/**
 * MCP servers by name, one item per entry of every vendor's MCP file (`mcp.json`, `~/.claude.json`, Codex `config.toml`,
 * Cursor `mcp.json`), each carrying its file's vendor. `packages/mcp` owns the file list (it cannot import this package),
 * so this host-side source lists the same files its loader reads. An entry that only sets `enabled`, `exposure` and the like
 * is a control-only override: it has `role: "override"` and never shadows the definition it controls. A file that does not
 * parse produces one item named after the file, with the error as its diagnostic.
 */
export function mcpItems(input: DiscoverInput): ConfigItem[] {
	const items: ConfigItem[] = [];
	const files = mcpConfigFiles(input.agentDir, input.cwd);
	const winners = loadedByLaunch(input);
	for (const file of files) {
		if (file.scope === "project" && !input.projectTrusted && !input.includeUntrusted) continue;
		const root = { product: file.product, scope: file.scope, origin: file.origin, vendor: file.vendor } as const;
		const { entries, error } = listMcpFileEntries(file, input.cwd);
		if (error)
			items.push({ ...makeItem("mcp", file.path, root, file.path, input), loaded: false, diagnostics: [error] });
		for (const entry of entries) {
			const item = makeItem("mcp", entry.name, root, file.path, input);
			if (entry.override) {
				items.push({ ...item, role: "override" });
				continue;
			}
			const winner = FOREIGN_VENDORS.has(file.vendor) && entry.launch ? winners.get(entry.launch) : undefined;
			if (!winner || (winner.source === file.path && winner.name === entry.name)) {
				items.push({ ...item, role: "definition" });
				continue;
			}
			const home = files.find((other) => other.path === winner.source);
			const shadowedBy = home
				? { product: home.product, vendor: home.vendor, scope: home.scope, origin: home.origin, path: home.path }
				: {
						product: "octocode" as const,
						vendor: "octocode" as const,
						scope: "builtin" as const,
						origin: "octocode",
						path: winner.source,
					};
			items.push({ ...item, role: "definition", loaded: false, provenance: { ...item.provenance, shadowedBy } });
		}
	}
	// The loader reads the lowest precedence first and the last definition wins; discovery lists the winner first. Precedence
	// ranks another agent's servers below every Octocode-format file, as the loader does.
	return items.reverse();
}
