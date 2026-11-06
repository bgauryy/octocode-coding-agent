import { homedir } from "node:os";
import { basename, dirname, sep } from "node:path";

/** `~/.agents/skills`: a path as the user types it. */
export function homePath(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/** The skills folder a SKILL.md belongs to (`~/.agents/skills` for `~/.agents/skills/x/SKILL.md`), for warnings. */
export function skillFolder(skillFile: string): string {
	return homePath(basename(skillFile) === "SKILL.md" ? dirname(dirname(skillFile)) : dirname(skillFile));
}

/** MCP files of the other harnesses, by the file's name: the group a server is listed under names its harness. */
const MCP_VENDOR_FILES: ReadonlyArray<readonly [RegExp, string]> = [
	[/[\\/]\.agents[\\/]mcp\.json$/, ".agents"],
	[/[\\/]\.claude\.json$/, "claude"],
	[/[\\/]\.codex[\\/]config\.toml$/, "codex"],
	[/[\\/]\.cursor[\\/]mcp\.json$/, "cursor"],
	[/[\\/]\.mcp\.json$/, "root .mcp.json"],
];

/** `.agents`, `root .mcp.json`, `claude`, `codex` or `cursor` for an MCP file of that harness; undefined for Octocode's and Pi's `mcp.json`. */
export const mcpVendorLabel = (file: string): string | undefined =>
	MCP_VENDOR_FILES.find(([pattern]) => pattern.test(file))?.[1];
