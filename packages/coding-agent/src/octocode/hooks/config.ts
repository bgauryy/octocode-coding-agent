import { HOOK_EVENTS, type HookSource, type HookHandler, type HookConfig } from "./contracts.ts";
import { applyHttpPolicy } from "./http.ts";
import fs from "node:fs";
import { parseConfigDocument } from "../../utils/config-document.ts";
import { codexConfigDir } from "../../utils/host-config.ts";
import { pluginContext } from "../../core/plugin-context.ts";
import { configuredPlugins } from "../../core/plugin-settings.ts";
import { inspectPluginHooks } from "../../core/plugin-hooks.ts";
import type { Settings } from "../../core/settings-manager.ts";
import os from "node:os";
import path from "node:path";
import { claudeSettingsSources, globalPaths, projectHookFiles } from "../shared/home.ts";
import { errorMessage, isRecord } from "../../utils/guards.ts";
import { emptyHooks, parseHooks } from "./config/parse.ts";

/**
 * A command-hook subset read from Claude Code, Codex and Octocode configuration:
 * `{ "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "…", "timeout": 60 }] }] } }`.
 * Unsupported events and execution fields are reported instead of silently approximated.
 */

export function hookLabel(hook: HookHandler): string {
	if (hook.type === "prompt") return `Prompt evaluation${hook.model ? ` (${hook.model})` : ""}`;
	if (hook.type === "http") {
		try {
			return `HTTP ${new URL(hook.url).origin}`;
		} catch {
			return "HTTP (invalid URL)";
		}
	}
	return hook.type === "mcp_tool" ? `MCP ${hook.server}/${hook.tool}` : hook.command;
}

/**
 * User hook files always (`~/.claude/settings.json`, `~/.codex/hooks.json`, `<Octocode home>/hooks.json`); project files
 * (the same three names under the repo root, plus `.claude/settings.local.json`) only when Octocode trusts the project.
 */
export function hookFiles(cwd: string, projectTrusted: boolean, home = os.homedir(), sourceProfiles = false): string[] {
	return hookSources(cwd, projectTrusted, home, sourceProfiles).map((source) => source.path);
}

function hookSources(
	cwd: string,
	projectTrusted: boolean,
	home: string,
	sourceProfiles = false,
	errors: string[] = [],
): HookSource[] {
	let codexHome: string | undefined = path.join(home, ".codex");
	if (sourceProfiles && process.env.CODEX_HOME) {
		try {
			codexHome = codexConfigDir(home);
		} catch {
			codexHome = undefined;
			errors.push("CODEX_HOME must resolve to an existing directory; Codex user hooks were not loaded");
		}
	}
	return [
		{
			path: path.join(
				sourceProfiles ? path.dirname(claudeSettingsSources(cwd, false, home)[0].path) : path.join(home, ".claude"),
				"settings.json",
			),
			dialect: "claude",
			scope: "user",
		},
		...(codexHome
			? [{ path: path.join(codexHome, "hooks.json"), dialect: "codex" as const, scope: "user" as const }]
			: []),
		...(sourceProfiles && codexHome
			? [{ path: path.join(codexHome, "config.toml"), dialect: "codex" as const, scope: "user" as const }]
			: []),
		{ path: globalPaths(process.env, home).hooks, dialect: "octocode", scope: "user" },
		...(projectTrusted
			? projectHookFiles(cwd)
					.filter((file) => sourceProfiles || !file.endsWith(".toml"))
					.map((file): HookSource => ({
						path: file,
						dialect:
							path.basename(path.dirname(file)) === ".claude"
								? "claude"
								: path.basename(path.dirname(file)) === ".codex"
									? "codex"
									: "octocode",
						scope: "project",
					}))
			: []),
	];
}

export function loadHooks(
	cwd: string,
	projectTrusted: boolean,
	home = os.homedir(),
	options: { sourceProfiles?: boolean; plugins?: Settings["plugins"] } = {},
): { config: HookConfig; errors: string[] } {
	const config = emptyHooks();
	const errors: string[] = [];
	let disabled = false;
	let codexEnabled = true;
	const codexLayers = new Map<string, Set<string>>();
	const httpPolicies: unknown[] = [];
	const seen = new Set<string>();
	for (const origin of hookSources(cwd, projectTrusted, home, options.sourceProfiles, errors)) {
		const file = origin.path;
		if (seen.has(file)) continue;
		seen.add(file);
		let text: string;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch (error) {
			// A missing file is normal (most users have only some of these); an unreadable one is reported like a bad one.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`${file}: ${errorMessage(error)}`);
			continue;
		}
		try {
			const value = parseConfigDocument(text, file);
			if (file.endsWith(".toml") && isRecord(value)) {
				const features = isRecord(value.features) ? value.features : {};
				const enabled = features.hooks ?? features.codex_hooks;
				if (typeof enabled === "boolean") codexEnabled = enabled;
				else if (enabled !== undefined) errors.push(`${file}: features.hooks must be a boolean`);
				if (isRecord(value.hooks))
					for (const groups of Object.values(value.hooks)) {
						if (!Array.isArray(groups)) continue;
						for (const group of groups)
							if (isRecord(group) && Array.isArray(group.hooks))
								for (const hook of group.hooks) {
									if (isRecord(hook) && hook.command_windows !== undefined && hook.commandWindows === undefined) {
										hook.commandWindows = hook.command_windows;
										delete hook.command_windows;
									}
								}
					}
			}
			if (
				options.sourceProfiles &&
				origin.dialect === "codex" &&
				isRecord(value) &&
				isRecord(value.hooks) &&
				Object.keys(value.hooks).length
			) {
				const directory = path.dirname(file);
				const kinds = codexLayers.get(directory) ?? new Set<string>();
				kinds.add(path.extname(file));
				codexLayers.set(directory, kinds);
				if (kinds.size > 1)
					errors.push(
						`${directory}: both hooks.json and inline TOML hooks are loaded; prefer one representation per layer`,
					);
			}
			if (options.sourceProfiles && origin.dialect === "claude") httpPolicies.push(value);
			if (isRecord(value) && value.disableAllHooks === true) {
				disabled = true;
				errors.push(`${file}: disableAllHooks disables all loaded hook sources in Octocode`);
			}
			parseHooks(value, file, config, errors, origin, options.sourceProfiles ? origin.dialect : "octocode");
		} catch (error) {
			errors.push(`${file}: ${errorMessage(error)}`);
		}
	}
	if (options.sourceProfiles && !disabled)
		for (const entry of configuredPlugins(options.plugins, (message) => errors.push(message))) {
			if (entry.enabled === false) continue;
			const inspected = inspectPluginHooks(entry);
			errors.push(...inspected.errors);
			if (!inspected.fingerprint || !inspected.manifest || inspected.definitions.length === 0) continue;
			if (entry.hooksFingerprint !== inspected.fingerprint) {
				errors.push(`${entry.path}: plugin hooks require review; hooksFingerprint=${inspected.fingerprint}`);
				continue;
			}
			const manifest = inspected.manifest;
			const context = pluginContext(manifest, home);
			for (const definition of inspected.definitions) {
				const origin: HookSource = { path: definition.source, dialect: manifest.protocol, scope: "plugin" };
				const parsed = parseHooks(definition.value, definition.source, emptyHooks(), errors, origin, manifest.protocol);
				for (const event of HOOK_EVENTS)
					for (const group of parsed[event]) {
						for (const hook of group.hooks) hook.plugin = context;
						config[event].push(group);
					}
			}
		}
	applyHttpPolicy(config, httpPolicies, errors);
	if (!codexEnabled) {
		for (const event of HOOK_EVENTS)
			config[event] = config[event]
				.map((group) => ({ ...group, hooks: group.hooks.filter((hook) => hook.protocol !== "codex") }))
				.filter((group) => group.hooks.length > 0);
		errors.push("Codex hooks disabled by features.hooks in loaded TOML configuration");
	}
	return { config: disabled ? emptyHooks() : config, errors };
}
