import { makeItem } from "../../core/discovery/roots.ts";
import type { ConfigItem, DiscoverInput } from "../../core/discovery/types.ts";
import { listMcpFileEntries } from "../../../../mcp/src/config.ts";
import { mcpConfigFiles } from "../../../../mcp/src/paths.ts";

/**
 * MCP servers by name, one item per entry of every vendor's MCP file (`mcp.json`, `~/.claude.json`, Codex `config.toml`,
 * Cursor `mcp.json`), each carrying its file's vendor. `packages/mcp` owns the file list (it cannot import this package),
 * so this host-side source lists the same files its loader reads. An entry that only sets `enabled`, `exposure` and the like
 * is a control-only override: it has `role: "override"` and never shadows the definition it controls. A file that does not
 * parse produces one item named after the file, with the error as its diagnostic.
 */
export function mcpItems(input: DiscoverInput): ConfigItem[] {
	const items: ConfigItem[] = [];
	for (const file of mcpConfigFiles(input.agentDir, input.cwd)) {
		if (file.scope === "project" && !input.projectTrusted && !input.includeUntrusted) continue;
		const root = { product: file.product, scope: file.scope, origin: file.origin, vendor: file.vendor } as const;
		const { entries, error } = listMcpFileEntries(file, input.cwd);
		if (error)
			items.push({ ...makeItem("mcp", file.path, root, file.path, input), loaded: false, diagnostics: [error] });
		for (const entry of entries) {
			const item = makeItem("mcp", entry.name, root, file.path, input);
			items.push(entry.override ? { ...item, role: "override" } : { ...item, role: "definition" });
		}
	}
	// The loader reads the lowest precedence first and the last definition wins; discovery lists the winner first. Precedence
	// ranks another agent's servers below every Octocode-format file, as the loader does.
	return items.reverse();
}
