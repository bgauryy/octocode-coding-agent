import path from "node:path";
import { repoKey } from "../../../utils/git-repository.ts";
import { codexConfigDir } from "../../../utils/host-config.ts";
import { externalSkillsEnabled, hookFileItems, listsProject, skillItemsIn, withinTrust } from "../sources.ts";
import type { ConfigItem, DiscoverInput } from "../types.ts";
import { mcpSource } from "./mcp-items.ts";
import { vendorDefaultOn } from "./switch.ts";
import type { Vendor } from "./types.ts";

/** Codex's user directory: `CODEX_HOME` when set (an error when it does not resolve), else `~/.codex`. */
export function codexHomeFor(home: string, env: NodeJS.ProcessEnv): { dir?: string; error?: string } {
	if (!env.CODEX_HOME) return { dir: path.join(home, ".codex") };
	try {
		return { dir: codexConfigDir(home, env) };
	} catch {
		return { error: "CODEX_HOME must resolve to an existing directory; Codex user hooks were not loaded" };
	}
}

const ROOT = { product: "octocode", vendor: "codex", origin: "codex" } as const;

/** `$CODEX_HOME/skills`; an invalid `CODEX_HOME` never falls back to another user's profile. */
function skills(input: DiscoverInput): ConfigItem[] {
	const env = input.env ?? process.env;
	const dir = codexHomeFor(input.home, env).dir;
	if (!dir || !externalSkillsEnabled(env)) return [];
	return skillItemsIn([path.join(dir, "skills")], { ...ROOT, scope: "global" }, input);
}

/** `$CODEX_HOME/hooks.json` and `config.toml`, then the workspace's `.codex/hooks.json` and `config.toml`. */
function hooks(input: DiscoverInput): ConfigItem[] {
	const dir = codexHomeFor(input.home, input.env ?? process.env).dir;
	const root = repoKey(input.cwd).root;
	const project = ["hooks.json", "config.toml"].map((name) => path.join(root, ".codex", name));
	return [
		...(dir
			? hookFileItems(
					["hooks.json", "config.toml"].map((name) => path.join(dir, name)),
					"codex",
					"global",
					input,
				)
			: []),
		...(listsProject(input) && withinTrust(input, root) ? hookFileItems(project, "codex", "project", input) : []),
	];
}

/** OpenAI Codex: skills, hooks and `[mcp_servers]`. Off until the user enables it in `/harness`. */
export const codexVendor: Vendor = {
	id: "codex",
	label: "Codex",
	defaultOn: vendorDefaultOn("codex"),
	switchable: true,
	sources: [{ kind: "skill", discover: skills }, { kind: "hook", discover: hooks }, mcpSource("codex")],
};
