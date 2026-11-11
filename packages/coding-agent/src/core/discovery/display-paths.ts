import { basename, dirname } from "node:path";
import { homeTilde } from "../../../../common/src/home-tilde.ts";

/** The skills folder a SKILL.md belongs to (`~/.agents/skills` for `~/.agents/skills/x/SKILL.md`), for warnings. */
export function skillFolder(skillFile: string): string {
	return homeTilde(basename(skillFile) === "SKILL.md" ? dirname(dirname(skillFile)) : dirname(skillFile));
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
