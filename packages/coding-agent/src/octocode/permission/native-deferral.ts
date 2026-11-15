/**
 * Deferred native tools. Under `mcpExposure: "recent"` (the default) a secondary native tool (`DEFERRABLE_NATIVE_TOOLS`) that this
 * working directory has not called in the last 24 hours, and under `"usage"` one outside the promotion snapshot
 * (`common/src/usage-counts.ts`), is declared with its description and its top-level field
 * names only; `reason` stays required. It stays callable, a call its schema rejects returns the schema, and each call
 * is recorded in the same file MCP tools use (`tool-use.json`), so a subagent, which takes its parent's in-use set,
 * defers the same tools. `nativeToolExposure` pins a tool either way. Core tools are never deferred.
 *
 * The decision is taken when the tool is registered and settled when the session starts (`settleNativeDeferral`): a pin
 * or a setting other than `recent` and `usage` decides; else a session that declared the tool before (resume, reload, fork) declares
 * it the same way again, whatever this folder called since; else the record decides. It then holds for the session: the
 * declaration is part of the cached prefix.
 *
 * A deferred tool the model loads in the session (`mcp` tools with `server: "native"`, a refused call, or its first
 * call) is declared in full after the cache, where the model's transport adds a definition in place
 * (`redeclaresInPlace`): the same second layer MCP tools have, once per session. Elsewhere the schema stays a tool result.
 */

import path from "node:path";
import { getCurrentTools } from "@octocodeai/octocode-ai";
import { NATIVE_PINNABLE_TOOLS, NATIVE_USAGE_ONLY_TOOLS } from "@octocodeai/octocode-contracts/config";
import type { TSchema } from "typebox";
import { envFlag, MCP_RECENT_TOOLS_ENV, SUBAGENT_ENV } from "../../../../common/src/env.ts";
import { recentlyUsed, RecentUseRecorder } from "../../../../common/src/recent-use.ts";
import { USAGE_FILE_NAME, UsageRecorder, usageGroupOf, usageSnapshot } from "../../../../common/src/usage-counts.ts";
import { deferredParameters, type McpNativeTools, redeclaresInPlace, thinParameters } from "../../../../mcp/src/api.ts";
import { getAgentDir } from "../../config.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../core/features/index.ts";

/** The native tools deferred under `recent` and `usage`: the contracts list a pin can name. */
export const DEFERRABLE_NATIVE_TOOLS: ReadonlySet<string> = new Set(NATIVE_PINNABLE_TOOLS);
/** Every native tool a session can declare deferred: those above, and the ones only `usage` or a pin defers. */
const DEFERRABLE_ANY: ReadonlySet<string> = new Set([...NATIVE_PINNABLE_TOOLS, ...NATIVE_USAGE_ONLY_TOOLS]);
const USAGE_ONLY: ReadonlySet<string> = new Set(NATIVE_USAGE_ONLY_TOOLS);

const useFile = () => path.join(getAgentDir(), "tool-use.json");
const uses = new RecentUseRecorder(useFile);
const keyOf = (name: string): string => `native/${name}`;
/** Counts of sessions that declared, called or were refused on each native tool (`usage-counts.ts`). */
const usage = new UsageRecorder(() => path.join(getAgentDir(), USAGE_FILE_NAME), usageGroupOf);

/**
 * The in-use set as a subagent's coordinator fixed it, else under `usage` the promotion snapshot, else this working
 * directory's record.
 */
function recentTools(env: NodeJS.ProcessEnv, settings: ExposureSettings): ReadonlySet<string> {
	if (envFlag(env, SUBAGENT_ENV) && env[MCP_RECENT_TOOLS_ENV] !== undefined) {
		try {
			const value: unknown = JSON.parse(env[MCP_RECENT_TOOLS_ENV] ?? "");
			if (Array.isArray(value)) return new Set(value.filter((name): name is string => typeof name === "string"));
		} catch {
			// An unreadable handoff reads as the record below.
		}
	}
	if (exposureSetting(settings) === "usage")
		return usageSnapshot(path.join(getAgentDir(), USAGE_FILE_NAME), usageGroupOf(env));
	return recentlyUsed(useFile(), process.cwd());
}

type ExposureSettings = { mcpExposure?: unknown; nativeToolExposure?: unknown } | undefined;

const exposureSetting = (settings: ExposureSettings): unknown => settings?.mcpExposure ?? SETTINGS_DEFAULTS.mcpExposure;

/** The user's own choice for `name`: a pin, else a setting other than `recent` or `usage` (direct); undefined defers by use. */
function chosenExposure(name: string, settings: ExposureSettings): boolean | undefined {
	const pins = settings?.nativeToolExposure;
	const pin = typeof pins === "object" && pins !== null ? (pins as Record<string, unknown>)[name] : undefined;
	if (pin === "direct" || pin === "deferred") return pin === "deferred";
	const setting = exposureSetting(settings);
	if (USAGE_ONLY.has(name)) return setting === "usage" ? undefined : false;
	return setting === "recent" || setting === "usage" ? undefined : false;
}

/** Whether `name` is declared deferred in this session: a pin first, then recent use under `mcpExposure: "recent"`. */
export function nativeToolDeferred(
	name: string,
	settings: ExposureSettings,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (!DEFERRABLE_ANY.has(name)) return false;
	return chosenExposure(name, settings) ?? !recentTools(env, settings).has(keyOf(name));
}

/**
 * The thin parameters of a deferred native tool: each top-level field with its JSON type, and the required `reason`.
 * No nested names: the tool's own description names the fields a call needs.
 */
function thinNativeParameters(parameters: TSchema): TSchema {
	const required = (parameters as { required?: unknown }).required;
	const keepsReason = Array.isArray(required) && required.includes("reason");
	return { ...thinParameters(parameters, { nested: false }), ...(keepsReason ? { required: ["reason"] } : {}) };
}

/**
 * `tool` declared deferred: thin parameters, validation as before, and the schema it declares when direct in a refusal
 * (a tool may validate more loosely than it declares, to answer an old call shape in its own words).
 */
function deferred<P extends TSchema, D, S>(tool: ToolDefinition<P, D, S>): ToolDefinition<P, D, S> {
	const full = tool.validationParameters ?? tool.parameters;
	return {
		...tool,
		parameters: deferredParameters(thinNativeParameters(tool.parameters), full) as P,
		validationParameters: full,
		validationHint: (failure) => {
			// A call this declaration's schema rejected is demand for its full declaration (`usage-counts.ts`).
			usage.record("refused", [keyOf(tool.name)]);
			usage.record("called", [keyOf(tool.name)]);
			markLoaded(tool.name);
			const own = tool.validationHint?.(failure);
			return [own, `Input schema (JSON Schema):\n${JSON.stringify(tool.parameters)}`].filter(Boolean).join("\n\n");
		},
	};
}

const declared = new Map<string, boolean>();

/** How this session declared each deferrable tool when it was registered: true for deferred. A settings view reads it. */
export const nativeToolsDeclared = (): ReadonlyMap<string, boolean> => declared;

const saved = new Map<string, number>();

/** Bytes deferring each deferrable tool saves per request (full declaration minus thin), measured at registration. */
export const nativeToolsSaved = (): ReadonlyMap<string, number> => saved;

const declarationBytes = (tool: { description: string; parameters: unknown }): number =>
	Buffer.byteLength(JSON.stringify({ description: tool.description, parameters: tool.parameters }));

/** Both declarations of a deferrable tool, and which one is registered. */
interface Forms {
	direct: ToolDefinition;
	deferred: ToolDefinition;
	/** Whether the session declared the tool thin when it started. */
	isDeferred: boolean;
	/** Whether the full form was declared since, in place, after a load. */
	redeclared: boolean;
}

/** The latest forms of each deferrable tool by name, across extension loads: what the `mcp` tool reads. */
const formsByName = new Map<string, Forms>();
/** The deferred tools read in full this session that are not yet declared in full (`redeclareLoadedNatives`). */
const loadedNatives = new Set<string>();

function markLoaded(name: string): void {
	if (formsByName.get(name)?.isDeferred) loadedNatives.add(name);
}

/**
 * The deferred native tools as the `mcp` tool reads them: their names, and the description and input schema each
 * declares when direct. Reading one counts as a load and queues its full declaration (`redeclareLoadedNatives`).
 */
export function nativeToolsPort(): McpNativeTools {
	return {
		deferred: () =>
			[...formsByName]
				.filter(([, forms]) => forms.isDeferred)
				.map(([name]) => name)
				.sort(),
		schema: (name) => {
			const forms = formsByName.get(name);
			return forms?.isDeferred
				? { description: forms.direct.description, parameters: forms.direct.parameters }
				: undefined;
		},
		loaded: markLoaded,
	};
}

/**
 * After a tool call ends, declares each loaded deferred tool in full, once, where the model's transport adds a
 * definition in place; elsewhere the tool list would be resent, so the tool stays thin and its schema stays a tool result.
 */
export function redeclareLoadedNatives(api: Pick<ExtensionAPI, "registerTool">, ctx: { model?: unknown }): void {
	if (loadedNatives.size === 0 || !redeclaresInPlace(ctx.model)) return;
	const registered = formsByApi.get(api);
	for (const name of loadedNatives) {
		const forms = registered?.get(name);
		if (!forms || !forms.isDeferred || forms.redeclared) continue;
		try {
			api.registerTool(forms.direct);
			forms.redeclared = true;
		} catch {
			// The tool stays thin; its schema still arrives as a tool result.
		}
	}
}

/** The forms of the deferrable tools each extension load registered, by the API it registered them through. */
const formsByApi = new WeakMap<object, Map<string, Forms>>();

function readSettings(api: Pick<ExtensionAPI, "getSettings">): ExposureSettings {
	try {
		return typeof api.getSettings === "function" ? api.getSettings() : undefined;
	} catch {
		return undefined;
	}
}

/**
 * A deferrable tool with its calls recorded, declared deferred when `nativeToolDeferred` says so; any other tool
 * unchanged. Settings cannot be read while extensions load: the record decides then, and `settleNativeDeferral`
 * applies the settings and the session's own declarations when the session starts.
 */
export function withNativeDeferral<P extends TSchema, D, S>(
	api: Pick<ExtensionAPI, "getSettings">,
	tool: ToolDefinition<P, D, S>,
): ToolDefinition<P, D, S> {
	if (!DEFERRABLE_ANY.has(tool.name)) return tool;
	const recorded: ToolDefinition<P, D, S> = {
		...tool,
		execute: (id, params, ...rest) => {
			uses.record(process.cwd(), keyOf(tool.name));
			usage.record("called", [keyOf(tool.name)]);
			markLoaded(tool.name);
			return tool.execute(id, params, ...rest);
		},
	};
	const isDeferred = nativeToolDeferred(tool.name, readSettings(api));
	declared.set(tool.name, isDeferred);
	const forms = { direct: recorded, deferred: deferred(recorded), isDeferred, redeclared: false };
	saved.set(tool.name, Math.max(0, declarationBytes(forms.direct) - declarationBytes(forms.deferred)));
	let registered = formsByApi.get(api);
	if (!registered) formsByApi.set(api, (registered = new Map()));
	registered.set(tool.name, forms as unknown as Forms);
	formsByName.set(tool.name, forms as unknown as Forms);
	return isDeferred ? forms.deferred : forms.direct;
}

/** Whether the session's transcript declares `forms` deferred (true), direct (false), or neither form (undefined). */
function transcriptDeclares(
	forms: Forms,
	declaredTools: ReadonlyMap<string, { parameters?: unknown }>,
	name: string,
): boolean | undefined {
	const tool = declaredTools.get(name);
	if (!tool) return undefined;
	const text = JSON.stringify(tool.parameters);
	if (text === JSON.stringify(forms.deferred.parameters)) return true;
	if (text === JSON.stringify(forms.direct.parameters)) return false;
	return undefined;
}

/**
 * At `session_start`, before the first request: declare each deferrable tool this load registered as the user chose
 * (pin, or a setting other than `recent` and `usage`), else as the session's transcript declares it (a resumed, reloaded or forked
 * session keeps its cached prefix), else as registered. A tool whose declared form changes is registered again in its
 * place. Anything unreadable leaves the registration as it is.
 */
export function settleNativeDeferral(
	api: Pick<ExtensionAPI, "getSettings" | "registerTool">,
	ctx: Pick<ExtensionContext, "sessionManager">,
): void {
	const registered = formsByApi.get(api);
	usage.reset();
	loadedNatives.clear();
	if (!registered || registered.size === 0) return;
	usage.record("declared", [...registered.keys()].map(keyOf));
	const settings = readSettings(api);
	let declaredTools: Map<string, { parameters?: unknown }> | undefined;
	const sessionDeclares = (name: string, forms: Forms): boolean | undefined => {
		if (!declaredTools) {
			try {
				const tools = getCurrentTools(ctx.sessionManager.buildSessionProjection().messages);
				declaredTools = new Map(tools.map((tool) => [tool.name, tool]));
			} catch {
				declaredTools = new Map();
			}
		}
		return transcriptDeclares(forms, declaredTools, name);
	};
	for (const [name, forms] of registered) {
		// The settings were unreadable at registration, so a new session under `usage` reads the snapshot only now.
		const fresh = exposureSetting(settings) === "usage" ? nativeToolDeferred(name, settings) : forms.isDeferred;
		const target = chosenExposure(name, settings) ?? sessionDeclares(name, forms) ?? fresh;
		if (target === forms.isDeferred && !forms.redeclared) continue;
		try {
			api.registerTool(target ? forms.deferred : forms.direct);
		} catch {
			continue;
		}
		forms.isDeferred = target;
		forms.redeclared = false;
		declared.set(name, target);
	}
}
