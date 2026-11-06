import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseConfigDocument } from "../../utils/config-document.ts";
import { isDirectory, isFile } from "../../utils/fs-probe.ts";
import { asRecord, isRecord } from "@octocodeai/octocode-contracts/guards";
import { claudeConfigDir, codexConfigDir } from "../../utils/host-config.ts";

/** A plugin another host installed: `/harness` lists it, and switching it on adds it to Octocode's `plugins`. */
export interface HostPlugin {
	host: "claude" | "codex";
	/** `name@marketplace`, as the host names it. */
	id: string;
	path: string;
	/** Whether the host itself has it enabled. */
	enabledThere: boolean;
	/** The reader its manifest needs: Codex also installs plugins that ship only a Claude manifest. */
	protocol: "claude" | "codex";
}

/** The installing host's own format when the plugin ships it, else the other one it does ship. */
const protocolOf = (dir: string, preferred: "claude" | "codex"): "claude" | "codex" => {
	const claude = isFile(path.join(dir, ".claude-plugin", "plugin.json"));
	const codex = isFile(path.join(dir, ".codex-plugin", "plugin.json")) || isFile(path.join(dir, "plugin.json"));
	if (preferred === "codex") return codex || !claude ? "codex" : "claude";
	return claude || !codex ? "claude" : "codex";
};

const readJson = (file: string): unknown => {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
};

/** Claude Code: `plugins/installed_plugins.json` (`plugins` by `name@marketplace`) and `enabledPlugins` in settings. */
function claudePlugins(home: string, env: NodeJS.ProcessEnv): HostPlugin[] {
	const config = claudeConfigDir(home, env);
	const root = env.CLAUDE_CODE_PLUGIN_CACHE_DIR
		? path.resolve(env.CLAUDE_CODE_PLUGIN_CACHE_DIR)
		: path.join(config, "plugins");
	const installed = readJson(path.join(root, "installed_plugins.json"));
	const settings = readJson(path.join(config, "settings.json"));
	const enabled = asRecord(asRecord(settings).enabledPlugins);
	if (!isRecord(installed) || !isRecord(installed.plugins)) return [];
	return Object.entries(installed.plugins).flatMap(([id, installs]) =>
		(Array.isArray(installs) ? installs : [])
			.filter((install) => isRecord(install) && typeof install.installPath === "string")
			.slice(0, 1)
			.map((install) => ({
				host: "claude" as const,
				id,
				path: path.resolve(String((install as Record<string, unknown>).installPath)),
				enabledThere: enabled[id] === true,
				protocol: protocolOf(path.resolve(String((install as Record<string, unknown>).installPath)), "claude"),
			}))
			.filter((plugin) => isDirectory(plugin.path)),
	);
}

/** Codex: `[plugins."name@marketplace"]` in `config.toml`, installed under `plugins/cache/<marketplace>/<name>/<version>`. */
function codexPlugins(home: string, env: NodeJS.ProcessEnv): HostPlugin[] {
	let dir: string;
	try {
		dir = codexConfigDir(home, env);
	} catch {
		return [];
	}
	let config: unknown;
	try {
		config = parseConfigDocument(readFileSync(path.join(dir, "config.toml"), "utf8"), "config.toml");
	} catch {
		return [];
	}
	const plugins = asRecord(asRecord(config).plugins);
	return Object.entries(plugins).flatMap(([id, entry]) => {
		const [name, marketplace] = id.split("@");
		if (!name || !marketplace) return [];
		const base = path.join(dir, "plugins", "cache", marketplace, name);
		let versions: string[] = [];
		try {
			versions = readdirSync(base).filter((version) => isDirectory(path.join(base, version)));
		} catch {
			return [];
		}
		// The newest install is the one Codex loads.
		const latest = versions.sort(
			(a, b) => statSync(path.join(base, b)).mtimeMs - statSync(path.join(base, a)).mtimeMs,
		)[0];
		if (!latest) return [];
		return [
			{
				host: "codex" as const,
				id,
				path: path.join(base, latest),
				enabledThere: isRecord(entry) && entry.enabled === true,
				protocol: protocolOf(path.join(base, latest), "codex"),
			},
		];
	});
}

const under = (file: string, dir: string): boolean => {
	const relative = path.relative(dir, path.resolve(file));
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

/** The host whose plugin store (`<config>/plugins`, or Claude's `CLAUDE_CODE_PLUGIN_CACHE_DIR`) holds `pluginPath`, if any. */
export function hostPluginStore(
	pluginPath: string,
	home = homedir(),
	env: NodeJS.ProcessEnv = process.env,
): HostPlugin["host"] | undefined {
	const claude = [path.join(claudeConfigDir(home, env), "plugins")];
	if (env.CLAUDE_CODE_PLUGIN_CACHE_DIR) claude.push(path.resolve(env.CLAUDE_CODE_PLUGIN_CACHE_DIR));
	if (claude.some((dir) => under(pluginPath, dir))) return "claude";
	try {
		if (under(pluginPath, path.join(codexConfigDir(home, env), "plugins"))) return "codex";
	} catch {
		// No Codex home to compare with: the plugin is not in its store.
	}
	return undefined;
}

/** Plugins Claude Code and Codex installed on this machine. Reading them runs nothing. */
export function hostInstalledPlugins(home = homedir(), env: NodeJS.ProcessEnv = process.env): HostPlugin[] {
	return [...claudePlugins(home, env), ...codexPlugins(home, env)];
}
