import os from "node:os";
import path from "node:path";
import { codexConfigDir } from "../../utils/host-config.ts";
import { claudeSettingsSources, globalPaths, projectHookFiles } from "../shared/home.ts";

/** A hook file and how it is read: the dialect names the format (Claude `settings.json`, Codex, Octocode `hooks.json`). */
export interface HookFile {
	path: string;
	dialect: "claude" | "codex" | "octocode";
	scope: "user" | "project";
}

/** Codex's user directory: `CODEX_HOME` when set (an error when it does not resolve), else `~/.codex`. */
export function codexHomeFor(home: string, env: NodeJS.ProcessEnv): { dir?: string; error?: string } {
	if (!env.CODEX_HOME) return { dir: path.join(home, ".codex") };
	try {
		return { dir: codexConfigDir(home) };
	} catch {
		return { error: "CODEX_HOME must resolve to an existing directory; Codex user hooks were not loaded" };
	}
}

/**
 * Every hook file Octocode may read, in load order: user files (Claude `settings.json`, Codex `hooks.json` and `config.toml`,
 * `<Octocode home>/hooks.json`), then, when `projectTrusted`, the project's. The `hook` discovery source lists these and
 * `loadHooks` reads them back from discovery, so there is one list.
 */
export function hookSources(
	cwd: string,
	projectTrusted: boolean,
	home = os.homedir(),
	env: NodeJS.ProcessEnv = process.env,
): HookFile[] {
	const codexHome = codexHomeFor(home, env).dir;
	return [
		{
			path: path.join(path.dirname(claudeSettingsSources(cwd, false, home)[0].path), "settings.json"),
			dialect: "claude",
			scope: "user",
		},
		...(codexHome
			? (["hooks.json", "config.toml"] as const).map((name): HookFile => ({
					path: path.join(codexHome, name),
					dialect: "codex",
					scope: "user",
				}))
			: []),
		{ path: globalPaths(env, home).hooks, dialect: "octocode", scope: "user" },
		...(projectTrusted
			? projectHookFiles(cwd).map((file): HookFile => {
					const folder = path.basename(path.dirname(file));
					return {
						path: file,
						dialect: folder === ".claude" ? "claude" : folder === ".codex" ? "codex" : "octocode",
						scope: "project",
					};
				})
			: []),
	];
}
