import { parsePatch } from "../shared/codex-patch/patch.ts";
import { fileChanges } from "../shared/file-input.ts";
import { HOOK_EVENTS, type HookSource, type HookBase, type HookCommand, type HookHttp, type HookMcp, type HookHandler, type HookConfig, type HookEvent } from "./contracts.ts";
export { HOOK_EVENTS } from "./contracts.ts";
export type { HookSource, HookBase, HookCommand, HookHttp, HookMcp, HookHandler, HookConfig, HookEvent } from "./contracts.ts";
import { applyHttpPolicy, parseHttpHook } from "./http.ts";
import fs from "node:fs";
import { parseConfigDocument } from "../../utils/config-document.ts";
import { codexConfigDir } from "../../utils/host-config.ts";
import { pluginContext } from "../../core/plugin-context.ts";
import { configuredPlugins } from "../../core/plugin-settings.ts";
import { inspectPluginHooks } from "../../core/plugin-hooks.ts";
import type { Settings } from "../../core/settings-manager.ts";
import os from "node:os";
import path from "node:path";
import { claudeSettingsSources, globalPaths, projectHookFiles, resolveToolPath } from "../shared/home.ts";
import { errorMessage, isRecord, stringOrEmpty } from "../shared/util.ts";
import { claudeSessionEndOverride, hookMatcher, matchesHook, supportsHookEvent, type HookProtocol } from "./profiles.ts";

/**
 * A command-hook subset read from Claude Code, Codex and Octocode configuration:
 * `{ "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "…", "timeout": 60 }] }] } }`.
 * Unsupported events and execution fields are reported instead of silently approximated.
 */

export function hookLabel(hook: HookHandler): string {
	if (hook.type === "prompt") return `Prompt evaluation${hook.model ? ` (${hook.model})` : ""}`;
	if (hook.type === "http") {
		try { return `HTTP ${new URL(hook.url).origin}`; }
		catch { return "HTTP (invalid URL)"; }
	}
	return hook.type === "mcp_tool" ? `MCP ${hook.server}/${hook.tool}` : hook.command;
}

const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 600;

export const emptyHooks = (): HookConfig => ({
	PreToolUse: [],
	PermissionRequest: [],
	PostToolUse: [],
	PostToolUseFailure: [],
	PostToolBatch: [],
	SessionStart: [],
	SubagentStart: [],
	SubagentStop: [],
	Interrupt: [],
	SessionEnd: [],
	UserPromptSubmit: [],
	PreCompact: [],
	PostCompact: [],
	Stop: [],
	StopFailure: [],
	Notification: [],
	PreMessageSend: [],
	PostMessageReceive: [],
});

/**
 * User hook files always (`~/.claude/settings.json`, `~/.codex/hooks.json`, `<Octocode home>/hooks.json`); project files
 * (the same three names under the repo root, plus `.claude/settings.local.json`) only when Octocode trusts the project.
 */
export function hookFiles(cwd: string, projectTrusted: boolean, home = os.homedir(), sourceProfiles = false): string[] {
	return hookSources(cwd, projectTrusted, home, sourceProfiles).map((source) => source.path);
}

function hookSources(cwd: string, projectTrusted: boolean, home: string, sourceProfiles = false, errors: string[] = []): HookSource[] {
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
		{ path: path.join(sourceProfiles ? path.dirname(claudeSettingsSources(cwd, false, home)[0]!.path) : path.join(home, ".claude"), "settings.json"), dialect: "claude", scope: "user" },
		...(codexHome ? [{ path: path.join(codexHome, "hooks.json"), dialect: "codex" as const, scope: "user" as const }] : []),
		...(sourceProfiles && codexHome ? [{ path: path.join(codexHome, "config.toml"), dialect: "codex" as const, scope: "user" as const }] : []),
		{ path: globalPaths(process.env, home).hooks, dialect: "octocode", scope: "user" },
		...(projectTrusted ? projectHookFiles(cwd).filter(file => sourceProfiles || !file.endsWith(".toml")).map((file): HookSource => ({
			path: file,
			dialect: path.basename(path.dirname(file)) === ".claude" ? "claude" : path.basename(path.dirname(file)) === ".codex" ? "codex" : "octocode",
			scope: "project",
		})) : []),
	];
}

/** Adds the command hooks in one parsed file to `into`; a group whose matcher is not a valid pattern is kept (it matches nothing) and named in `errors`. */
export function parseHooks(
	value: unknown,
	source: string,
	into: HookConfig = emptyHooks(),
	errors: string[] = [],
	origin?: HookSource,
	protocol: HookProtocol = "octocode",
): HookConfig {
	if (isRecord(value) && value.disableAllHooks === true) return into;
	const profileTimeout = protocol === "octocode" ? DEFAULT_TIMEOUT_S : 600;
	const hooks = isRecord(value) ? value.hooks : undefined;
	if (hooks === undefined) return into;
	if (!isRecord(hooks)) {
		errors.push(`${source}: hooks must be an object; skipped`);
		return into;
	}
	for (const event of Object.keys(hooks)) {
		if (!(HOOK_EVENTS as readonly string[]).includes(event))
			errors.push(`${source}: unsupported hook event ${event}; skipped`);
	}
	for (const event of HOOK_EVENTS) {
		const defaultTimeout = event === "Interrupt" ? 1 : event === "SessionEnd"
			? protocol === "codex" ? 1 : (claudeSessionEndOverride() ?? 1500) / 1000
			: protocol === "claude" && event === "UserPromptSubmit" ? 30 : profileTimeout;
		const maxTimeout = protocol === "codex" && (event === "SessionEnd" || event === "Interrupt") ? 3 : MAX_TIMEOUT_S;
		const groups = hooks[event];
		if (groups === undefined) continue;
		if (!supportsHookEvent(protocol, event)) {
			errors.push(`${source}: unsupported ${protocol} hook event ${event}; skipped`);
			continue;
		}
		if (!Array.isArray(groups)) {
			errors.push(`${source}: ${event} must be an array; skipped`);
			continue;
		}
		for (const group of groups) {
			if (
				!isRecord(group) ||
				!Array.isArray(group.hooks) ||
				(group.matcher !== undefined && typeof group.matcher !== "string")
			) {
				errors.push(`${source}: invalid ${event} matcher group; skipped`);
				continue;
			}
			const extraGroupFields = Object.keys(group).filter((key) => key !== "matcher" && key !== "hooks");
			if (extraGroupFields.length) {
				errors.push(`${source}: unsupported ${event} group fields ${extraGroupFields.join(", ")}; skipped`);
				continue;
			}
			const commands = group.hooks.flatMap((hook): HookHandler[] => {
				const invalidHandler = (failure: string): HookHandler[] => {
					const required = isRecord(hook) && (hook.failClosed === true || (protocol === "claude" && hook.onFailure === "block")) && (event === "PermissionRequest" || event === "PreToolUse" || event === "PreMessageSend" || event === "UserPromptSubmit");
					errors.push(`${source}: ${failure}; ${required ? "failClosed denies matching calls" : "skipped"}`);
					if (!required) return [];
					return [{ command: typeof hook.command === "string" ? hook.command : "", timeoutMs: defaultTimeout * 1000,
						...(protocol !== "octocode" ? { protocol } : {}), source, ...(origin ? { origins: [origin] } : {}),
						...(protocol === "claude" && hook.onFailure === "block" ? { onFailure: "block" as const } : {}),
						failClosed: true, configurationError: failure }];
				};
				if (protocol === "claude" && isRecord(hook) && Object.hasOwn(hook, "once")) {
					if (typeof hook.once !== "boolean") return invalidHandler("once must be a boolean");
					// This reader loads settings and plugin files; Claude honors once only in skill frontmatter.
					const settingsHook = { ...hook };
					delete settingsHook.once;
					hook = settingsHook;
				}
				if (protocol === "codex" && event === "Interrupt" && isRecord(hook) && hook.timeout != null) {
     if (!Number.isSafeInteger(hook.timeout) || (hook.timeout as number) < 0) return invalidHandler("Interrupt timeout must be a non-negative safe integer");
    }
				if (isRecord(hook) && hook.type === "mcp_tool" && protocol !== "octocode") {
					if (protocol === "codex" && event === "SessionEnd") return invalidHandler("Codex SessionEnd does not support MCP hooks");
					const invalid = typeof hook.server !== "string" || !hook.server.trim() || typeof hook.tool !== "string" || !hook.tool.trim() || (hook.input !== undefined && !isRecord(hook.input)) || Object.keys(hook).some(key => !["type", "server", "tool", "input", "timeout", "statusMessage"].includes(key));
					if (invalid) return invalidHandler("invalid or unsupported MCP hook fields");
					return [{ type: "mcp_tool", protocol, server: hook.server as string, tool: hook.tool as string, input: isRecord(hook.input) ? hook.input : {}, timeoutMs: (typeof hook.timeout === "number" && Number.isFinite(hook.timeout) && hook.timeout > 0 ? Math.min(hook.timeout, maxTimeout) : defaultTimeout) * 1000, source, ...(origin ? { origins: [origin] } : {}) }];
				}
				if (isRecord(hook) && hook.type === "http" && protocol === "claude" && event !== "SessionStart") {
					return parseHttpHook(hook, source, origin, defaultTimeout, errors);
				}
				if (isRecord(hook) && hook.type === "prompt" && protocol === "claude" && ["PermissionRequest", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "Stop", "SubagentStop", "UserPromptSubmit"].includes(event)) {
					if (typeof hook.prompt !== "string" || !hook.prompt.trim() || (hook.model !== undefined && (typeof hook.model !== "string" || !hook.model.trim())) || (hook.continueOnBlock !== undefined && typeof hook.continueOnBlock !== "boolean") || (hook.timeout !== undefined && (typeof hook.timeout !== "number" || !Number.isFinite(hook.timeout) || hook.timeout <= 0)) || Object.keys(hook).some(key => !["type", "prompt", "model", "timeout", "continueOnBlock", "statusMessage", "failClosed"].includes(key))) return invalidHandler("invalid or unsupported prompt hook fields");
					return [{ type: "prompt", protocol, prompt: hook.prompt, ...(typeof hook.model === "string" ? { model: hook.model } : {}), ...(typeof hook.continueOnBlock === "boolean" ? { continueOnBlock: hook.continueOnBlock } : {}), timeoutMs: (typeof hook.timeout === "number" ? Math.min(hook.timeout, maxTimeout) : 30) * 1000, source, ...(origin ? { origins: [origin] } : {}), ...(hook.failClosed === true ? { failClosed: true as const } : {}) }];
				}
				if (!isRecord(hook) || hook.type !== "command" || typeof hook.command !== "string" || !hook.command.trim()) {
					return invalidHandler(`${event} requires a command hook with a non-empty command`);
				}
				const accepted = ["type", "command", "timeout", "failClosed", "statusMessage",
					...(protocol === "claude" ? ["args", "onFailure", "async", "asyncRewake"] : []),
					...(protocol === "codex" ? ["commandWindows", "async", "additionalContextLimit"] : []),
				];
				const unsupported = Object.keys(hook).filter((key) => !accepted.includes(key));
				const invalid: string[] = [];
				if (protocol === "codex" && hook.additionalContextLimit != null && (!Number.isSafeInteger(hook.additionalContextLimit) || (hook.additionalContextLimit as number) < 0)) invalid.push("additionalContextLimit must be a non-negative safe integer");
				if (protocol !== "octocode" && hook.async !== undefined && typeof hook.async !== "boolean") invalid.push("async must be a boolean");
				if (protocol === "claude" && hook.asyncRewake !== undefined && typeof hook.asyncRewake !== "boolean") invalid.push("asyncRewake must be a boolean");
				if (protocol === "claude" && (hook.async === true || hook.asyncRewake === true) && event === "SessionEnd") invalid.push("async SessionEnd requires an unavailable teardown scheduler");
				if (protocol === "claude" && hook.args !== undefined && (!Array.isArray(hook.args) || !hook.args.every((arg) => typeof arg === "string")))
					invalid.push("args must be an array of strings");
				if (protocol === "claude" && hook.onFailure !== undefined && hook.onFailure !== "block" && hook.onFailure !== "continue")
					invalid.push('onFailure must be "block" or "continue"');
				if (protocol === "codex" && hook.commandWindows !== undefined && (typeof hook.commandWindows !== "string" || !hook.commandWindows.trim()))
					invalid.push("commandWindows must be a non-empty string");
				if (unsupported.length || invalid.length) {
					return invalidHandler([
						...(unsupported.length ? [`unsupported ${event} command fields ${unsupported.join(", ")}`] : []),
						...invalid,
					].join("; "));
				}

				const hasContextLimit = protocol === "codex" && hook.additionalContextLimit != null;
				const supportsContextLimit = ["PreToolUse", "PostToolUse", "SessionStart", "SubagentStart", "UserPromptSubmit"].includes(event);
				if (hasContextLimit && !supportsContextLimit) errors.push(`${source}: ignoring additionalContextLimit for ${event}: this event cannot emit additionalContext`);
				const seconds =
					typeof hook.timeout === "number" && hook.timeout > 0
						? Math.min(hook.timeout, maxTimeout)
						: defaultTimeout;
				return [
					{
						command: hook.command,
						...(hasContextLimit && supportsContextLimit ? { additionalContextLimit: hook.additionalContextLimit as number } : {}),
						...(protocol !== "octocode" && typeof hook.async === "boolean" ? { async: hook.async } : {}),
						...(protocol === "claude" && typeof hook.asyncRewake === "boolean" ? { asyncRewake: hook.asyncRewake } : {}),
						...(protocol === "claude" && Array.isArray(hook.args) ? { args: hook.args as string[] } : {}),
						...(protocol === "claude" && (hook.onFailure === "block" || hook.onFailure === "continue") ? { onFailure: hook.onFailure } : {}),
						...(protocol === "codex" && typeof hook.commandWindows === "string" ? { commandWindows: hook.commandWindows } : {}),
						timeoutMs: seconds * 1000,
						...(protocol !== "octocode" ? { protocol } : {}),
						source,
						...(origin ? { origins: [origin] } : {}),
						...(hook.failClosed === true ? { failClosed: true as const } : {}),
					},
				];
			});
			if (commands.length === 0) continue;
			const matcher = typeof group.matcher === "string" ? group.matcher : "";
			if (!hookMatcher(protocol, event, matcher))
				errors.push(`${source}: ${event} matcher "${matcher}" is not a valid pattern, so its hooks never run`);
			into[event].push({ matcher, hooks: commands });
		}
	}
	return into;
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
				if (isRecord(value.hooks)) for (const groups of Object.values(value.hooks)) {
					if (!Array.isArray(groups)) continue;
					for (const group of groups) if (isRecord(group) && Array.isArray(group.hooks)) for (const hook of group.hooks) {
						if (isRecord(hook) && hook.command_windows !== undefined && hook.commandWindows === undefined) {
							hook.commandWindows = hook.command_windows;delete hook.command_windows;
						}
					}
				}
			}
			if (options.sourceProfiles && origin.dialect === "codex" && isRecord(value) && isRecord(value.hooks) && Object.keys(value.hooks).length) {
				const directory = path.dirname(file);const kinds = codexLayers.get(directory) ?? new Set<string>();
				kinds.add(path.extname(file));codexLayers.set(directory, kinds);
				if (kinds.size > 1) errors.push(`${directory}: both hooks.json and inline TOML hooks are loaded; prefer one representation per layer`);
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
	if (options.sourceProfiles && !disabled) for (const entry of configuredPlugins(options.plugins, message => errors.push(message))) {
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
			for (const event of HOOK_EVENTS) for (const group of parsed[event]) {
				for (const hook of group.hooks) hook.plugin = context;
				config[event].push(group);
			}
		}
	}
	applyHttpPolicy(config, httpPolicies, errors);
	if (!codexEnabled) {
		for (const event of HOOK_EVENTS) config[event] = config[event].map(group => ({ ...group, hooks: group.hooks.filter(hook => hook.protocol !== "codex") })).filter(group => group.hooks.length > 0);
		errors.push("Codex hooks disabled by features.hooks in loaded TOML configuration");
	}
	return { config: disabled ? emptyHooks() : config, errors };
}

/** Claude Code tool names for Octocode's tools, so `"matcher": "Bash"` or `"Edit|Write"` work unchanged. */
const CLAUDE_NAMES: Record<string, string[]> = {
	bash: ["Bash"],
	read: ["Read"],
	edit: ["Edit"],
	write: ["Write"],
	file: ["Edit", "Write", "MultiEdit"],
	grep: ["Grep"],
	find: ["Glob"],
	ls: ["LS"],
	web: ["WebFetch", "WebSearch"],
	agent: ["Task"],
};

export const toolAliases = (tool: string): string[] => [tool, ...(CLAUDE_NAMES[tool] ?? [])];

/** One hook dispatch: the matcher names, and the Claude Code `tool_name` / `tool_input` the hook receives on stdin. */
interface HookCall {
	names: string[];
	tool_name: string;
	tool_input: unknown;
}

/** One `file` query in Claude Code's shape: Edit / MultiEdit `{file_path, old_string, new_string | edits}`, Write `{file_path, content}`. */
function fileQueryCall(query: Record<string, unknown>, cwd: string): HookCall {
	const file_path = resolveToolPath(cwd, stringOrEmpty(query.path));
	if (query.type === "write")
		return {
			names: ["file", "Write"],
			tool_name: "Write",
			tool_input: { file_path, content: stringOrEmpty(query.content) },
		};
	if (query.type === "delete") return { names: ["file", "Delete"], tool_name: "Delete", tool_input: { file_path } };
	const edits = (Array.isArray(query.edits) ? query.edits : [])
		.filter(isRecord)
		.map((edit) => ({
			old_string: stringOrEmpty(edit.oldText),
			new_string: stringOrEmpty(edit.newText),
			...(typeof edit.replaceAll === "boolean" ? { replace_all: edit.replaceAll } : {}),
		}));
	if (edits.length === 1)
		return { names: ["file", "Edit"], tool_name: "Edit", tool_input: { file_path, ...edits[0] } };
	return { names: ["file", "MultiEdit"], tool_name: "MultiEdit", tool_input: { file_path, edits } };
}

/**
 * The hook dispatches for one Octocode tool call, with Claude Code's tool names and inputs so hooks written for Claude Code
 * (`jq .tool_input.file_path`, `"matcher": "Edit|Write"`) work unchanged: a `file` call is one dispatch per query
 * (Edit, MultiEdit, Write, or Delete, which Claude Code lacks); `read` and Octocode's `edit`/`write` send `file_path`;
 * `bash` already takes Claude's `{command}`. Other tools keep their Octocode name and input.
 */
export function hookCalls(tool: string, input: Record<string, unknown>, cwd: string): HookCall[] {
	if (tool === "file" && typeof input.patch === "string" && parsePatch(input.patch).hunks.some(h => h.kind === "update")) return [];
	if (tool === "file")
		return fileChanges(input)
			.map((query) => fileQueryCall(query, cwd));
	if (tool === "bash") return [{ names: toolAliases(tool), tool_name: "Bash", tool_input: input }];
	const claude = { read: "Read", edit: "Edit", write: "Write" }[tool];
	if (claude) {
		const { path: file, ...rest } = input;
		return [
			{
				names: toolAliases(tool),
				tool_name: claude,
				tool_input: { ...rest, file_path: resolveToolPath(cwd, stringOrEmpty(file)) },
			},
		];
	}
	return [{ names: toolAliases(tool), tool_name: tool, tool_input: input }];
}

/** Native whole-name matching remains available to callers of the legacy contract. */
export function matches(matcher: string, names: string[]): boolean {
	return matchesHook("octocode", "PreToolUse", matcher, names);
}

export function hookIdentity(hook: HookHandler): string {
	if (hook.type === "prompt") return JSON.stringify([hook.protocol, hook.plugin?.id ?? null, "prompt", hook.prompt, hook.model ?? null, hook.continueOnBlock ?? false]);
	return JSON.stringify([hook.protocol ?? "octocode", hook.plugin?.id ?? null, ...(hook.type === "http" ? ["http", hook.url, hook.headers, hook.allowedEnvVars] : hook.type === "mcp_tool" ? ["mcp_tool", hook.server, hook.tool, hook.input] : ["command", hook.command, hook.args ?? null, hook.commandWindows ?? null, hook.async ?? false, hook.asyncRewake ?? false, hook.protocol === "codex" ? hook.additionalContextLimit ?? 2500 : null])]);
}

/** Select by profile; identical commands merge only within that profile, preserving required denial and source provenance. */
export function commandsFor(config: HookConfig, event: HookEvent, names: string[]): HookHandler[] {
	const unique = new Map<string, HookHandler>();
	for (const hook of config[event].flatMap((group) => group.hooks.filter((hook) => matchesHook(hook.protocol ?? "octocode", event, group.matcher, names)))) {
		const key = hookIdentity(hook);
		const first = unique.get(key);
		if (!first) unique.set(key, hook);
		else {
			const origins = [...(first.origins ?? []), ...(hook.origins ?? [])];
			unique.set(key, {
				...first,
				...(origins.length ? { origins: [...new Map(origins.map((origin) => [JSON.stringify(origin), origin])).values()] } : {}),
				...(hook.failClosed || hook.configurationError ? { failClosed: true } : {}),
				...(hook.onFailure === "block" ? { onFailure: "block" as const } : {}),
				...(hook.configurationError ? { configurationError: hook.configurationError } : {}),
			});
		}
	}
	return [...unique.values()];
}
