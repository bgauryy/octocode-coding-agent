/**
 * Deferred native tools. Under `mcpExposure: "usage"` (the default) every secondary native tool, and under `"recent"`
 * one of `DEFERRABLE_NATIVE_TOOLS` that this working directory has not called in the last 24 hours, is declared thin:
 * its description and its top-level fields with their types, the few values a field allows and the fields it requires
 * (`reason` among them). Usage promotion (`common/src/usage-counts.ts`) never declares a full schema: it only decides
 * whether an on-demand tool is declared at the session's start. A thin tool stays callable, a call its schema rejects
 * returns the schema, and each call is recorded in the same files MCP tools use (`tool-use.json`, `tool-usage.json`), so
 * a subagent, which takes its parent's in-use set, declares the same tools. `nativeToolExposure` pins a tool either
 * way. Core tools are never deferred.
 *
 * The decision is taken when the tool is registered and settled when the session starts (`settleNativeDeferral`): a pin
 * or a setting other than `recent` and `usage` decides; else a session that declared the tool before (resume, reload, fork) declares
 * it the same way again, whatever this folder called since; else the record decides. It then holds for the session: the
 * declaration is part of the cached prefix.
 *
 * A deferred tool the model loads in the session (`mcp` tools with `server: "native"`, a refused call, or its first
 * call) is declared in full after the cache, where the model's transport adds a definition in place
 * (`redeclaresInPlace`): the same second layer MCP tools have, once per session. Elsewhere the schema stays a tool result.
 *
 * On demand: an unpinned tool of `NATIVE_ON_DEMAND_TOOLS` that a new session would declare deferred is instead left
 * undeclared (registered inactive with `onDemand`) where the model's transport adds a declaration after the cached
 * prefix (tool loading mode `changes` or `additions`) and the agent has the `mcp` tool. `<tools>` still lists it; its
 * first call, or the `mcp` tool reading it (`server: "native"`), activates it and the next request declares it. A
 * resumed session keeps what its transcript declared; a switch to a model without in-place additions declares every
 * unloaded one deferred (`reconsiderNativeOnDemand`).
 */

import path from "node:path";
import { getCurrentTools } from "@octocodeai/octocode-ai";
import { MCP_MANAGE_TOOL_NAME } from "@octocodeai/octocode-common/mcp-names";
import {
	NATIVE_ON_DEMAND_TOOLS,
	NATIVE_PINNABLE_TOOLS,
	NATIVE_USAGE_ONLY_TOOLS,
} from "@octocodeai/octocode-contracts/config";
import type { TSchema } from "typebox";
import { envFlag, MCP_RECENT_TOOLS_ENV, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { recentlyUsed, RecentUseRecorder } from "@octocodeai/octocode-common/recent-use";
import { USAGE_FILE_NAME, UsageRecorder, usageGroupOf, usageSnapshot } from "@octocodeai/octocode-common/usage-counts";
import { deferredParameters, promotionBudget, redeclaresInPlace, thinParameters } from "../../../../mcp/src/api.ts";
import { getAgentDir, VERSION } from "../../config.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import type { SetupPick, FeatureContext, FeatureSetup, ToolDefinition } from "../../core/features/index.ts";
import { addsInPlace, type Forms, type OnDemandApi, onDemandForm, undeclared } from "./native-forms.ts";
import { nativeLoads } from "./native-port.ts";

export { nativeToolsPort } from "./native-port.ts";

/** The native tools deferred under `recent` and `usage`: the contracts list a pin can name. */
export const DEFERRABLE_NATIVE_TOOLS: ReadonlySet<string> = new Set(NATIVE_PINNABLE_TOOLS);
/** Every native tool a session can declare deferred: those above, and the ones only `usage` or a pin defers. */
const DEFERRABLE_ANY: ReadonlySet<string> = new Set([...NATIVE_PINNABLE_TOOLS, ...NATIVE_USAGE_ONLY_TOOLS]);
const USAGE_ONLY: ReadonlySet<string> = new Set(NATIVE_USAGE_ONLY_TOOLS);
const ON_DEMAND: ReadonlySet<string> = new Set(NATIVE_ON_DEMAND_TOOLS);
/** Whether `name` can be left on demand: the contracts list, and `memory` in a subagent, which seldom calls it. */
const onDemandTool = (name: string): boolean =>
	ON_DEMAND.has(name) || (name === "memory" && envFlag(process.env, SUBAGENT_ENV));

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
		return usageSnapshot(path.join(getAgentDir(), USAGE_FILE_NAME), usageGroupOf(env), Date.now(), {
			version: VERSION,
			budget: promotionBudget(settings?.mcpPromotedBytes),
		});
	return recentlyUsed(useFile(), process.cwd());
}

type ExposureSettings = { mcpExposure?: unknown; nativeToolExposure?: unknown; mcpPromotedBytes?: unknown } | undefined;

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

/**
 * Whether `name` is declared deferred (thin) in this session: a pin first; then under `mcpExposure: "usage"` always
 * (promotion decides only on-demand tools, `leftOnDemand`), under `"recent"` unless this folder called it lately.
 */
export function nativeToolDeferred(
	name: string,
	settings: ExposureSettings,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (!DEFERRABLE_ANY.has(name)) return false;
	const chosen = chosenExposure(name, settings);
	if (chosen !== undefined) return chosen;
	return exposureSetting(settings) === "usage" || !recentTools(env, settings).has(keyOf(name));
}

/** Whether an unpinned on-demand tool that would be deferred stays undeclared at the start: not in the in-use set. */
const leftOnDemand = (name: string, settings: ExposureSettings): boolean =>
	!recentTools(process.env, settings).has(keyOf(name));

/**
 * The thin parameters of a deferred native tool: each top-level field with its JSON type and the few values it
 * allows, and the fields it requires (`reason` among them). No nested names: the tool's own description names them.
 */
const thinNativeParameters = (parameters: TSchema): TSchema => thinParameters(parameters, { nested: false });

/**
 * `tool` declared deferred: thin parameters, validation as before, and the schema it declares when direct in a refusal
 * (a tool may validate more loosely than it declares, to answer an old call shape in its own words).
 */
function deferred<P extends TSchema, D, S>(tool: ToolDefinition<P, D, S>, load: () => void): ToolDefinition<P, D, S> {
	const full = tool.validationParameters ?? tool.parameters;
	return {
		...tool,
		parameters: deferredParameters(thinNativeParameters(tool.parameters), full) as P,
		validationParameters: full,
		validationHint: (failure) => {
			// A call this declaration's schema rejected is demand for its full declaration (`usage-counts.ts`).
			usage.record("refused", [keyOf(tool.name)]);
			usage.record("called", [keyOf(tool.name)]);
			load();
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

/**
 * After a tool call ends, declares each loaded deferred tool in full, once, where the model's transport adds a
 * definition in place; elsewhere the tool list would be resent, so the tool stays thin and its schema stays a tool result.
 */
export function redeclareLoadedNatives(api: SetupPick<"tools", "register">, ctx: { model?: unknown }): void {
	const registry = registrations.get(api);
	if (!registry?.pending.size || !redeclaresInPlace(ctx.model)) return;
	for (const name of registry.pending) {
		const forms = registry.forms.get(name);
		if (!forms || !forms.isDeferred || forms.redeclared) continue;
		try {
			api.tools.register(forms.direct);
			forms.redeclared = true;
			registry.pending.delete(name);
		} catch {
			// The tool stays thin; its schema still arrives as a tool result.
		}
	}
}

/** The forms of the deferrable tools each feature load registered, by the API it registered them through. */
const registrations = new WeakMap<object, { forms: Map<string, Forms>; pending: Set<string> }>();

function readSettings(api: SetupPick<"settings", "get">): ExposureSettings {
	try {
		return typeof api.settings.get === "function" ? api.settings.get() : undefined;
	} catch {
		return undefined;
	}
}

/**
 * A deferrable tool with its calls recorded, declared deferred when `nativeToolDeferred` says so; any other tool
 * unchanged. Settings cannot be read while features load: the record decides then, and `settleNativeDeferral`
 * applies the settings and the session's own declarations when the session starts.
 */
export function withNativeDeferral<P extends TSchema, D, S>(
	api: SetupPick<"settings", "get">,
	tool: ToolDefinition<P, D, S>,
): ToolDefinition<P, D, S> {
	if (!DEFERRABLE_ANY.has(tool.name)) return tool;
	let registry = registrations.get(api);
	if (!registry) registrations.set(api, (registry = { forms: new Map(), pending: new Set() }));
	const { pending } = registry;
	const load = (): void => {
		if (forms.isDeferred && !forms.redeclared) pending.add(tool.name);
	};
	const recorded: ToolDefinition<P, D, S> = {
		...tool,
		execute: (id, params, ...rest) => {
			uses.record(process.cwd(), keyOf(tool.name));
			usage.record("called", [keyOf(tool.name)]);
			load();
			return tool.execute(id, params, ...rest);
		},
	};
	const isDeferred = nativeToolDeferred(tool.name, readSettings(api));
	declared.set(tool.name, isDeferred);
	const forms = {
		direct: recorded,
		deferred: deferred(recorded, load),
		isDeferred,
		redeclared: false,
		byRecord: isDeferred,
	};
	saved.set(tool.name, Math.max(0, declarationBytes(forms.direct) - declarationBytes(forms.deferred)));
	registry.forms.set(tool.name, forms as unknown as Forms);
	nativeLoads.set(forms.deferred.parameters, { full: recorded, load });
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
	api: SetupPick<"settings", "get"> & SetupPick<"tools", "register"> & Partial<OnDemandApi>,
	ctx: Pick<FeatureContext, "sessionManager"> & { model?: unknown },
): void {
	const registry = registrations.get(api);
	const registered = registry?.forms;
	usage.reset();
	registry?.pending.clear();
	if (!registered || registered.size === 0) return;
	applyNativeDeclarations(api, ctx);
	// Counted after the snapshot was read: the tools the session declares, and the on-demand ones it lists (its tool
	// selection would declare them), never one registered outside its selection.
	const tools = api.tools as Partial<Pick<FeatureSetup["tools"], "getActive" | "selects">>;
	const active = typeof tools.getActive === "function" ? new Set(tools.getActive()) : undefined;
	const offered = [...registered].filter(
		([name, forms]) =>
			!active || active.has(name) || (forms.onDemand !== undefined && tools.selects?.(name, true) !== false),
	);
	usage.record(
		"declared",
		offered.map(([name]) => keyOf(name)),
	);
	// What promoting an on-demand tool adds to the tool list: its thin declaration (`usage-counts.ts` budgets it).
	usage.recordSizes(
		offered.flatMap(([name, forms]) =>
			onDemandTool(name) ? [[keyOf(name), declarationBytes(forms.deferred)] as const] : [],
		),
	);
}

/** Declare each deferrable tool as `settleNativeDeferral` describes, for the session's model now. */
function applyNativeDeclarations(
	api: SetupPick<"settings", "get"> & SetupPick<"tools", "register"> & Partial<OnDemandApi>,
	ctx: Pick<FeatureContext, "sessionManager"> & { model?: unknown },
): void {
	const registered = registrations.get(api)?.forms;
	if (!registered) return;
	const settings = readSettings(api);
	let declaredTools: Map<string, { parameters?: unknown }> | undefined;
	/** The tools the session's first system message declares: a tool declared only after it was loaded on demand. */
	let headTools = new Set<string>();
	const sessionDeclares = (name: string, forms: Forms): boolean | undefined => {
		if (!declaredTools) {
			try {
				const { messages } = ctx.sessionManager.buildSessionProjection();
				const tools = getCurrentTools(messages);
				const head = messages.find((message) => message.role === "system");
				headTools = new Set(head ? getCurrentTools([head]).map((tool) => tool.name) : []);
				declaredTools = new Map(tools.map((tool) => [tool.name, tool]));
			} catch {
				declaredTools = new Map();
			}
		}
		return transcriptDeclares(forms, declaredTools, name);
	};
	const onDemandApi =
		typeof api.tools.getActive === "function" && typeof api.tools.setActive === "function"
			? (api as OnDemandApi)
			: undefined;
	const tierApplies =
		onDemandApi !== undefined && addsInPlace(ctx.model) && onDemandApi.tools.getActive().includes(MCP_MANAGE_TOOL_NAME);
	for (const [name, forms] of registered) {
		// The settings were unreadable at registration (the default decided then), so a new session under `usage` or
		// `recent` reads its snapshot or this folder's record only now.
		const setting = exposureSetting(settings);
		const fresh = setting === "usage" || setting === "recent" ? nativeToolDeferred(name, settings) : forms.byRecord;
		const chosen = chosenExposure(name, settings);
		const transcript = sessionDeclares(name, forms);
		const wasOnDemand = forms.onDemand;
		forms.onDemand = undefined;
		// On demand: a new session leaves it undeclared; a resumed one that loaded it declares it in full as it did.
		const loaded = transcript === false && !headTools.has(name);
		const startsOnDemand = fresh && transcript === undefined && leftOnDemand(name, settings);
		if (tierApplies && onDemandTool(name) && chosen === undefined && (startsOnDemand || loaded)) {
			try {
				api.tools.register(onDemandForm(forms, loaded, onDemandApi));
			} catch {
				continue;
			}
			forms.onDemand = onDemandApi;
			forms.isDeferred = false;
			forms.redeclared = false;
			declared.set(name, !loaded);
			const active = onDemandApi.tools.getActive();
			if (!loaded && active.includes(name)) onDemandApi.tools.setActive(active.filter((tool) => tool !== name));
			continue;
		}
		const target = chosen ?? transcript ?? fresh;
		if (target === forms.isDeferred && !forms.redeclared && !wasOnDemand) continue;
		try {
			api.tools.register(target ? forms.deferred : forms.direct);
		} catch {
			continue;
		}
		const active = wasOnDemand?.tools.getActive();
		if (active && !active.includes(name)) wasOnDemand!.tools.setActive([...active, name]);
		forms.isDeferred = target;
		forms.redeclared = false;
		declared.set(name, target);
	}
}

/**
 * At `model_select`: a model whose transport cannot add a declaration after the cached prefix gets every unloaded
 * on-demand tool declared deferred (its first request is uncached anyway). A capable model re-applies the declarations,
 * which leaves every tool the transcript declares as it is: declared tools are never withdrawn.
 */
export function reconsiderNativeOnDemand(
	api: SetupPick<"settings", "get"> & SetupPick<"tools", "register"> & Partial<OnDemandApi>,
	ctx: Pick<FeatureContext, "sessionManager"> & { model?: unknown },
): void {
	if (addsInPlace(ctx.model)) {
		applyNativeDeclarations(api, ctx);
		return;
	}
	for (const [name, forms] of registrations.get(api)?.forms ?? []) {
		if (!forms.onDemand) continue;
		const onDemandApi = forms.onDemand;
		const wasUndeclared = undeclared(name, forms);
		forms.onDemand = undefined;
		if (!wasUndeclared) continue;
		try {
			api.tools.register(forms.deferred);
		} catch {
			continue;
		}
		forms.isDeferred = true;
		declared.set(name, true);
		onDemandApi.tools.setActive([...onDemandApi.tools.getActive(), name]);
	}
}
