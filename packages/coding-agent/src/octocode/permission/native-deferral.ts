/**
 * Deferred native tools. Under `mcpExposure: "recent"` (the default) a secondary native tool (`DEFERRABLE_NATIVE_TOOLS`) that this
 * working directory has not called in the last 24 hours is declared with its description and its top-level field
 * names only; `reason` stays required. It stays callable, a call its schema rejects returns the schema, and each call
 * is recorded in the same file MCP tools use (`tool-use.json`), so a subagent, which takes its parent's in-use set,
 * defers the same tools. `nativeToolExposure` pins a tool either way. Core tools are never deferred.
 *
 * The decision is taken when the tool is registered and holds for the session: the declaration is part of the cached
 * prefix.
 */

import path from "node:path";
import type { TSchema } from "typebox";
import { envFlag, MCP_RECENT_TOOLS_ENV, SUBAGENT_ENV } from "../../../../common/src/env.ts";
import { recentlyUsed, RecentUseRecorder } from "../../../../common/src/recent-use.ts";
import { deferredParameters, thinParameters } from "../../../../mcp/src/api.ts";
import { getAgentDir } from "../../config.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import type { ExtensionAPI, ToolDefinition } from "../../core/features/index.ts";

/** The native tools that may be deferred: used in a minority of sessions, with a schema worth leaving out. */
export const DEFERRABLE_NATIVE_TOOLS: ReadonlySet<string> = new Set(["web", "archive", "models", "backlogPlan"]);

const useFile = () => path.join(getAgentDir(), "tool-use.json");
const uses = new RecentUseRecorder(useFile);
const keyOf = (name: string): string => `native/${name}`;

/** The in-use set as a subagent's coordinator fixed it, else this working directory's record. */
function recentTools(env: NodeJS.ProcessEnv): ReadonlySet<string> {
	if (envFlag(env, SUBAGENT_ENV) && env[MCP_RECENT_TOOLS_ENV] !== undefined) {
		try {
			const value: unknown = JSON.parse(env[MCP_RECENT_TOOLS_ENV] ?? "");
			if (Array.isArray(value)) return new Set(value.filter((name): name is string => typeof name === "string"));
		} catch {
			// An unreadable handoff reads as the record below.
		}
	}
	return recentlyUsed(useFile(), process.cwd());
}

/** Whether `name` is declared deferred in this session: a pin first, then recent use under `mcpExposure: "recent"`. */
export function nativeToolDeferred(
	name: string,
	settings: { mcpExposure?: unknown; nativeToolExposure?: unknown } | undefined,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (!DEFERRABLE_NATIVE_TOOLS.has(name)) return false;
	const pins = settings?.nativeToolExposure;
	const pin = typeof pins === "object" && pins !== null ? (pins as Record<string, unknown>)[name] : undefined;
	if (pin === "direct" || pin === "deferred") return pin === "deferred";
	const setting = settings?.mcpExposure ?? SETTINGS_DEFAULTS.mcpExposure;
	return setting === "recent" && !recentTools(env).has(keyOf(name));
}

/** The thin parameters of a deferred native tool: each top-level field with its JSON type, and the required `reason`. */
function thinNativeParameters(parameters: TSchema): TSchema {
	const required = (parameters as { required?: unknown }).required;
	const keepsReason = Array.isArray(required) && required.includes("reason");
	return { ...thinParameters(parameters), ...(keepsReason ? { required: ["reason"] } : {}) };
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
			const own = tool.validationHint?.(failure);
			return [own, `Input schema (JSON Schema):\n${JSON.stringify(tool.parameters)}`].filter(Boolean).join("\n\n");
		},
	};
}

const declared = new Map<string, boolean>();

/** How this session declared each deferrable tool when it was registered: true for deferred. A settings view reads it. */
export const nativeToolsDeclared = (): ReadonlyMap<string, boolean> => declared;

/**
 * A deferrable tool with its calls recorded, declared deferred when `nativeToolDeferred` says so; any other tool
 * unchanged. Settings that cannot be read yet leave the tool direct.
 */
export function withNativeDeferral<P extends TSchema, D, S>(
	api: Pick<ExtensionAPI, "getSettings">,
	tool: ToolDefinition<P, D, S>,
): ToolDefinition<P, D, S> {
	if (!DEFERRABLE_NATIVE_TOOLS.has(tool.name)) return tool;
	let settings: { mcpExposure?: unknown; nativeToolExposure?: unknown } | undefined;
	try {
		settings = typeof api.getSettings === "function" ? api.getSettings() : undefined;
	} catch {
		settings = undefined;
	}
	const recorded: ToolDefinition<P, D, S> = {
		...tool,
		execute: (id, params, ...rest) => {
			uses.record(process.cwd(), keyOf(tool.name));
			return tool.execute(id, params, ...rest);
		},
	};
	const isDeferred = nativeToolDeferred(tool.name, settings);
	declared.set(tool.name, isDeferred);
	return isDeferred ? deferred(recorded) : recorded;
}
