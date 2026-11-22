import { StringEnum } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../../../../config.ts";
import {
	type ConfigCatalog,
	type ConfigOp,
	type ConfigScope,
	type ConfigVerb,
} from "../../../../configuration/index.ts";
import { appliesText, formatResult } from "../../../../configuration/command.ts";
import type { FeatureContext, FeatureSetup } from "../../../../core/features/index.ts";
import { renderPrompt } from "../../../../core/prompt-template.ts";
import type { Permission } from "../../../permission/ask.ts";
import { textResultDisplay } from "../../../render/display.ts";
import { timedTool } from "../../../render/rows.ts";
import { toolHeader } from "../../../render/tool.ts";
import { textResult } from "../../../shared/util.ts";
import { sessionCatalog } from "./catalog.ts";
import { approvalText, approvalTitle } from "./approval.ts";

const CONFIGURATION_TOOL_NAME = "configuration";

const OPS = ["list", "get", "set", "unset", "enable", "disable", "add", "remove"] as const;
const LIST_ROWS = 60;

interface ConfigurationParams {
	op: ConfigVerb;
	id?: string;
	value?: unknown;
	scope?: "global" | "workspace";
}

const parameters = Type.Object({
	op: StringEnum(OPS),
	id: Type.Optional(Type.String({ description: "settings key or kind:name; list: filter" })),
	value: Type.Optional(Type.Unknown()),
	scope: Type.Optional(StringEnum(["global", "workspace"])),
});

/** The settings file of a scope, for the approval text. */
function fileOf(ctx: FeatureContext, id: string, scope: ConfigScope, detail: string | undefined): string {
	if (id.includes(":") && !id.startsWith("toggles:")) return detail ?? "the entry owner's configuration file";
	return scope === "project" ? join(ctx.cwd, CONFIG_DIR_NAME, "settings.json") : join(getAgentDir(), "settings.json");
}

const scopeOf = (scope: ConfigurationParams["scope"]): ConfigScope => (scope === "workspace" ? "project" : "global");

/**
 * The main session's `configuration` tool. Reads never ask. Every write asks the user in every permission mode
 * (bypass included) and is refused when there is no one to ask; the decision is recorded in the permission audit.
 * Writes go through the same catalog `/settings` uses, so validation and trust rules are shared.
 */
export function registerConfigurationTool(
	api: FeatureSetup,
	options: {
		permission: Permission;
		isSubagent: boolean;
		/** The catalog a call works on; the session's own unless a test supplies one. */
		catalogFor?: (ctx: FeatureContext) => ConfigCatalog;
	},
): void {
	// A subagent has no one to ask and never changes configuration: it reports the need to its parent.
	if (options.isSubagent) return;
	const { permission } = options;
	const catalogFor = options.catalogFor ?? ((ctx: FeatureContext) => sessionCatalog(api, ctx));
	const audit = (what: string, note: string, allowed: boolean) =>
		permission.noted([what], note, { allowed, via: allowed ? "reported" : "policy", tool: CONFIGURATION_TOOL_NAME });

	async function write(params: ConfigurationParams, ctx: FeatureContext, signal: AbortSignal | undefined) {
		if (!params.id) throw new Error(`${params.op} needs id.`);
		const scope = scopeOf(params.scope);
		const op = {
			verb: params.op,
			id: params.id,
			scope,
			...(params.op === "set" || params.op === "add" ? { value: params.value } : {}),
		} as ConfigOp;
		const what = `configuration ${op.verb} ${op.id} (${scope === "project" ? "workspace" : scope})`;
		if (!ctx.hasUI) {
			audit(what, "refused: no dialog to ask the user", false);
			throw new Error(
				"configuration changes need the user's approval and this session has no dialog to ask in (headless, print or --no-dialogs): ask the user to run /settings themselves.",
			);
		}
		const catalog = catalogFor(ctx);
		const before = await catalog.get(op.id);
		const approved = await ctx.ui.confirm(
			approvalTitle(op),
			approvalText(op, scope, before, fileOf(ctx, op.id, scope, before?.detail)),
			{ signal },
		);
		if (!approved) {
			audit(what, "the user declined", false);
			return textResult(
				`The user declined: ${op.verb} ${op.id} was not changed. Do not retry it unless the user asks.`,
			);
		}
		audit(what, "the user approved", true);
		const result = await catalog.apply(op);
		const extra = await catalog.settle([result]);
		return textResult([...formatResult(result), ...extra].join("\n"), result);
	}

	api.tools.register(
		timedTool({
			name: CONFIGURATION_TOOL_NAME,
			label: "Configuration",
			promptSnippet: renderPrompt("tools/configuration/snippet.md"),
			description: "Read or change settings and enabled tools, MCP servers, skills. Every change asks the user.",
			parameters,
			effect: { kind: "opaque" },
			display(input) {
				const args = input.args as ConfigurationParams;
				return textResultDisplay(
					{
						title: "Configuration",
						summary: `${args.op} ${args.id ?? ""}`.trim(),
						kind: "other" as const,
						blocks: [],
					},
					input,
				);
			},
			renderCall(args, theme, context) {
				const input = args as ConfigurationParams;
				return toolHeader(theme, context, "Configuration", `${input.op} ${input.id ?? ""}`.trim());
			},
			async execute(_toolCallId, input, signal, _onUpdate, ctx) {
				const params = input as ConfigurationParams;
				signal?.throwIfAborted();
				if (params.op === "list") {
					const entries = await catalogFor(ctx).list({ text: params.id });
					const rows = entries.slice(0, LIST_ROWS).map((entry) => {
						const state =
							entry.valueType.type === "toggle" ? (entry.value === false ? "off" : "on") : JSON.stringify(entry.value);
						return `${entry.id}\t${state}\t${entry.setBy}\t${appliesText(entry.appliesWhen)}`;
					});
					const more = entries.length > LIST_ROWS ? [`${entries.length - LIST_ROWS} more: narrow with id.`] : [];
					return textResult([...rows, ...more].join("\n") || "No entries match.");
				}
				if (params.op === "get") {
					if (!params.id) throw new Error("get needs id.");
					const entry = await catalogFor(ctx).get(params.id);
					return textResult(entry ? JSON.stringify(entry, null, 1) : `No entry ${params.id}.`);
				}
				return write(params, ctx, signal);
			},
		}) as never,
	);
}
