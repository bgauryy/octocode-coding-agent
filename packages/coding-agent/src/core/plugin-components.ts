import { lstatSync, statSync } from "node:fs";
import path from "node:path";
import { type PluginAgentFile, scanPluginAgents } from "./plugin-agents.ts";
import { type PluginManifest, resolvePluginPath } from "./plugin-manifest.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

type PluginComponent = { kind: "path"; path: string } | { kind: "inline"; value: Record<string, unknown> };
type PluginCommand =
	| { kind: "path"; path: string }
	| {
			kind: "command";
			name: string;
			definition: Record<string, unknown>;
	  };

/**
 * Components a plugin can declare, per host, that Octocode does not load: the manifest key and the default location
 * that announce one. Skills, Claude commands and agents, hooks and MCP servers have owners; everything here is reported instead
 * of silently ignored. Checked 2026-10-29 against the Claude Code plugin manifest reference and Codex `main` 3535c22b.
 */
const UNSUPPORTED_PLUGIN_COMPONENTS: Record<
	PluginManifest["protocol"],
	ReadonlyArray<{ key: string; path?: string }>
> = {
	claude: [
		{ key: "lspServers", path: "./.lsp.json" },
		{ key: "outputStyles", path: "./output-styles" },
		{ key: "workflows", path: "./workflows" },
		{ key: "themes", path: "./themes" },
		{ key: "monitors", path: "./monitors/monitors.json" },
		{ key: "experimental" },
		{ key: "userConfig" },
		{ key: "channels" },
		{ key: "dependencies" },
		{ key: "settings", path: "./settings.json" },
		{ key: "bin", path: "./bin" },
	],
	codex: [{ key: "commands" }, { key: "apps", path: "./.app.json" }, { key: "onboardingSkill" }],
};

/** The unsupported components a plugin declares or ships at their default location. */
function unsupportedComponents(manifest: PluginManifest): string[] {
	const present = (relative: string) => {
		try {
			lstatSync(path.resolve(manifest.root, relative));
			return true;
		} catch {
			return false;
		}
	};
	return UNSUPPORTED_PLUGIN_COMPONENTS[manifest.protocol]
		.filter(({ key, path: relative }) => manifest.settings[key] !== undefined || (relative && present(relative)))
		.map(({ key }) => key);
}

/** Normalize component declarations without loading instructions or executing plugin code. */
export function discoverPluginComponents(manifest: PluginManifest): {
	skills: string[];
	commands: PluginCommand[];
	hooks: PluginComponent[];
	/** Claude plugin agents: the manifest `agents` files, which replace the default recursive `agents/` scan. */
	agents: PluginAgentFile[];
	/** Declared components Octocode does not load (see `UNSUPPORTED_PLUGIN_COMPONENTS`). */
	unsupported: string[];
	errors: string[];
} {
	const errors: string[] = [];
	const settings = manifest.settings;
	const paths = (
		field: string,
		value: unknown,
		kind: "directory" | "json" | "markdown" | "markdownFile",
		optional = false,
	): string[] => {
		const result: string[] = [];
		for (const entry of Array.isArray(value) ? value : [value]) {
			try {
				if (typeof entry !== "string") throw new Error("expected a path string");
				if (optional) {
					try {
						lstatSync(path.resolve(manifest.root, entry));
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
						throw error;
					}
				}
				if (entry === "." && field !== "skills") throw new Error("path must start with ./");
				const resolved = resolvePluginPath(manifest.root, entry);
				const stat = statSync(resolved);
				if (kind === "directory" && !stat.isDirectory()) throw new Error("expected a directory");
				if (kind === "json" && (!stat.isFile() || path.extname(resolved) !== ".json"))
					throw new Error("expected a JSON file");
				if (kind === "markdown" && !(stat.isDirectory() || (stat.isFile() && path.extname(resolved) === ".md")))
					throw new Error("expected a Markdown file or directory");
				if (kind === "markdownFile" && !(stat.isFile() && path.extname(resolved) === ".md"))
					throw new Error("expected a Markdown file (directories are not accepted)");
				result.push(resolved);
			} catch (error) {
				errors.push(`${manifest.name}: ${field}: ${String(error)}`);
			}
		}
		return result;
	};
	const skills = new Set<string>();
	if (manifest.format === "portable" || manifest.protocol === "claude" || settings.skills === undefined)
		for (const item of paths("skills", "./skills", "directory", true)) skills.add(item);
	if (manifest.format !== "portable" && settings.skills !== undefined)
		for (const item of paths("skills", settings.skills, "directory")) skills.add(item);

	const commands: PluginCommand[] = [];
	if (manifest.protocol === "claude") {
		if (isRecord(settings.commands)) {
			for (const [name, definition] of Object.entries(settings.commands)) {
				if (
					!isRecord(definition) ||
					"source" in definition === "content" in definition ||
					("source" in definition ? typeof definition.source !== "string" : typeof definition.content !== "string")
				) {
					errors.push(`${manifest.name}: commands.${name}: expected exactly one source or content string`);
					continue;
				}
				if (definition.source !== undefined) {
					const source = paths(`commands.${name}`, definition.source, "markdown")[0];
					if (!source) continue;
					if (!statSync(source).isFile()) {
						errors.push(`${manifest.name}: commands.${name}: source must be a Markdown file`);
						continue;
					}
					commands.push({ kind: "command", name, definition: { ...definition, source } });
				} else commands.push({ kind: "command", name, definition: { ...definition } });
			}
		} else {
			for (const item of new Set(
				paths(
					"commands",
					settings.commands === undefined ? "./commands" : settings.commands,
					"markdown",
					settings.commands === undefined,
				),
			))
				commands.push({ kind: "path", path: item });
		}
	}
	const agents: PluginAgentFile[] = [];
	if (manifest.protocol === "claude") {
		if (settings.agents === undefined) agents.push(...scanPluginAgents(manifest, errors));
		else
			for (const file of new Set(paths("agents", settings.agents, "markdownFile"))) agents.push({ file, folders: [] });
	}
	const hooks: PluginComponent[] = [];
	const seen = new Set<string>();
	const hookPaths = (entry: unknown, optional = false) => {
		for (const item of paths("hooks", entry, "json", optional)) {
			if (seen.has(item)) continue;
			seen.add(item);
			hooks.push({ kind: "path", path: item });
		}
	};
	if (
		manifest.protocol === "claude" ||
		settings.hooks === undefined ||
		(Array.isArray(settings.hooks) && settings.hooks.length === 0)
	)
		hookPaths("./hooks/hooks.json", true);
	if (settings.hooks !== undefined) {
		const entries = Array.isArray(settings.hooks) ? settings.hooks : [settings.hooks];
		const mixedCodex =
			manifest.protocol === "codex" && !entries.every((entry) => typeof entry === "string") && !entries.every(isRecord);
		if (mixedCodex) errors.push(`${manifest.name}: hooks: Codex requires a homogeneous path or inline-object array`);
		else
			for (const entry of entries) {
				if (isRecord(entry)) {
					if (manifest.protocol === "codex" && !isRecord(entry.hooks)) {
						errors.push(`${manifest.name}: hooks: Codex inline declarations require a hooks wrapper`);
						continue;
					}
					hooks.push({ kind: "inline", value: manifest.protocol === "claude" ? { hooks: entry } : entry });
				} else hookPaths(entry);
			}
	}
	return { skills: [...skills], commands, hooks, agents, unsupported: unsupportedComponents(manifest), errors };
}
