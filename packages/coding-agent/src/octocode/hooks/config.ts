import { HOOK_EVENTS } from "./catalog.ts";
import type { HookSource, HookHandler, HookConfig } from "./contracts.ts";
import { applyHttpPolicy, type HttpPolicySource } from "./http.ts";
import fs from "node:fs";
import { parseConfigDocument } from "../../utils/config-document.ts";
import { pluginContext } from "../../core/plugin-context.ts";
import { configuredPlugins } from "../../core/plugin-settings.ts";
import { inspectPluginHooks } from "../../core/plugin-hooks.ts";
import type { Settings } from "../../core/settings-manager.ts";
import os from "node:os";
import path from "node:path";
import { globalPaths } from "../shared/home.ts";
import { configDiscovery, discoveryInput } from "../../core/discovery/service.ts";
import { installOctocodeDiscovery } from "../discovery/index.ts";
import { codexHomeFor } from "../../core/discovery/vendors/codex.ts";
import { asRecord, errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { emptyHooks, parseHooks } from "./config/parse.ts";
import { applyHookToggles } from "./config/toggles.ts";
import { gateHooks } from "./review.ts";

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
 * User hook files always (Claude `settings.json`, Codex `hooks.json` and `config.toml`, `<Octocode home>/hooks.json`);
 * project files (the same names under the repo root, plus `.claude/settings.local.json`) only when Octocode trusts the
 * project.
 */
export function hookFiles(cwd: string, projectTrusted: boolean, home = os.homedir()): string[] {
	return hookSourcesFromDiscovery(cwd, projectTrusted, home).map(({ source }) => source.path);
}

/**
 * The hook files discovery lists (Octocode's, Claude's, Codex's), in load order, with the dialect each is read as and
 * whether its harness is switched off (then only its handlers are read, each answering to its own keys).
 */
function hookSourcesFromDiscovery(
	cwd: string,
	projectTrusted: boolean,
	home: string,
	errors: string[] = [],
	toggles?: Settings["toggles"],
): { source: HookSource; off: boolean }[] {
	installOctocodeDiscovery();
	const codex = codexHomeFor(home, process.env);
	if (codex.error) errors.push(codex.error);
	const input = discoveryInput({
		cwd,
		agentDir: globalPaths(process.env, home).home,
		home,
		projectTrusted,
		piRoots: [],
		toggles,
	});
	return (
		configDiscovery
			.discover("hook", input)
			// A switched-off Claude or Codex file is still read: its handlers answer to narrower keys (`applyHookToggles`).
			.filter(
				(item) => (item.loaded || item.provenance.notLoaded === "switched-off") && item.provenance.origin !== "plugin",
			)
			.map((item) => ({
				source: {
					path: item.provenance.path,
					dialect: item.provenance.origin as HookSource["dialect"],
					scope: item.provenance.scope === "project" ? "project" : "user",
				},
				off: item.provenance.notLoaded === "switched-off",
			}))
	);
}

export function loadHooks(
	cwd: string,
	projectTrusted: boolean,
	home = os.homedir(),
	options: {
		plugins?: Settings["plugins"];
		toggles?: Settings["toggles"];
		/** Session start only: withhold handlers the user has not approved (`enforce` off: rate them, load them all). */
		gate?: { enforce: boolean };
	} = {},
): { config: HookConfig; errors: string[]; switchedOff: number; withheld: number } {
	const config = emptyHooks();
	const errors: string[] = [];
	let disabled = false;
	let codexEnabled = true;
	const codexLayers = new Map<string, Set<string>>();
	const httpPolicies: HttpPolicySource[] = [];
	const seen = new Set<string>();
	for (const { source: origin, off } of hookSourcesFromDiscovery(cwd, projectTrusted, home, errors, options.toggles)) {
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
				const features = asRecord(value.features);
				// A file whose harness is off contributes handlers only (each answers to its own keys), never file-wide switches.
				const enabled = off ? undefined : (features.hooks ?? features.codex_hooks);
				if (typeof enabled === "boolean") codexEnabled = enabled;
				else if (enabled !== undefined) errors.push(`${file}: features.hooks must be a boolean`);
				// `[hooks.state.*]` is Codex's own ledger of reviewed hook hashes, not an event.
				if (isRecord(value.hooks)) delete value.hooks.state;
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
			if (origin.dialect === "codex" && isRecord(value) && isRecord(value.hooks) && Object.keys(value.hooks).length) {
				const directory = path.dirname(file);
				const kinds = codexLayers.get(directory) ?? new Set<string>();
				kinds.add(path.extname(file));
				codexLayers.set(directory, kinds);
				if (kinds.size > 1)
					errors.push(
						`${directory}: both hooks.json and inline TOML hooks are loaded; prefer one representation per layer`,
					);
			}
			if (origin.dialect === "claude" && !off) httpPolicies.push({ scope: origin.scope, value });
			if (!off && isRecord(value) && value.disableAllHooks === true) {
				disabled = true;
				errors.push(`${file}: disableAllHooks disables all loaded hook sources in Octocode`);
			}
			parseHooks(value, file, config, errors, origin, origin.dialect);
		} catch (error) {
			errors.push(`${file}: ${errorMessage(error)}`);
		}
	}
	if (!disabled)
		for (const entry of configuredPlugins(options.plugins, (message) => errors.push(message))) {
			if (entry.enabled === false) continue;
			const inspected = inspectPluginHooks(entry);
			errors.push(...inspected.errors);
			if (inspected.errors.length || !inspected.manifest || inspected.definitions.length === 0) continue;
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
	const switchedOff = disabled ? 0 : applyHookToggles(config, options.toggles, cwd, home);
	const withheld = !disabled && options.gate ? gateHooks(config, cwd, home, options.gate.enforce) : 0;
	return { config: disabled ? emptyHooks() : config, errors, switchedOff, withheld };
}
