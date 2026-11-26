import { existsSync } from "node:fs";
import path from "node:path";
import type { Model, ProviderPlan } from "@octocodeai/octocode-ai";
import { findOnPath } from "@octocodeai/octocode-common/find-on-path";
import type { ExternalModelEntry } from "../../core/settings-schema/external-models.ts";
import { agentEnv } from "../external/runner-env.ts";
import type { RunnerState } from "../external/runner-status.ts";
import { adapterArgs, RUNNERS, type RunnerSpec } from "../external/runners.ts";
import { octocodeToolsOnly } from "./permission.ts";
import {
	type AgentFacts,
	type CliModelRoute,
	DEFAULT_MODEL,
	type RouteSource,
	routeModel,
	SOURCE_WORDS,
} from "./route.ts";

/** What a route through a vendor CLI says about its terms: the CLI's own apply; Octocode has no page for them. */
const CLI_TERMS = "The CLI's own terms and plan apply.";

/** Runners whose CLI is offered as a model here: Claude Code has its own route (`claude-code/`), Cursor runs headless. */
const offered = (spec: RunnerSpec) => spec.id !== "claude-code" && !spec.headlessOnly;

/** The provider id of a built-in runner's route: `<runner>-cli`, apart from the HTTP providers of the same vendor. */
const builtinProvider = (runner: string): string => `${runner}-cli`;

/** Every provider id a built-in route can take: a settings entry with one of these ids is refused. */
export const RESERVED_IDS: ReadonlySet<string> = new Set([
	"claude-code",
	...RUNNERS.filter(offered).map((spec) => builtinProvider(spec.id)),
]);

const plan = (billing: ProviderPlan["billing"], disabled: string | undefined): ProviderPlan => ({
	billing,
	access: "unclear",
	terms: CLI_TERMS,
	transport: "cli",
	...(disabled ? { disabled } : {}),
});

/** Said in a model's name when its agent cannot reach Octocode's tools: it takes no MCP server over HTTP. */
const NO_TOOLS = "no Octocode tools";

/**
 * A route's models: the ids configured, else what the agent advertises, after `default` (the agent's own choice). The
 * name says where the route came from and, once known, that the agent takes no Octocode tools; the model takes images
 * when the agent does.
 */
export function modelsOf(
	provider: string,
	name: string,
	source: RouteSource,
	configured: readonly string[] | undefined,
	facts: AgentFacts = {},
): Model<string>[] {
	const advertised = (facts.models ?? []).filter((id) => id !== DEFAULT_MODEL);
	const ids = configured?.length ? configured : [DEFAULT_MODEL, ...advertised];
	const note = facts.mcpHttp === false ? ` · ${NO_TOOLS}` : "";
	return [...new Set(ids)].map((id) =>
		routeModel(provider, id, `${id} · ${name} (${SOURCE_WORDS[source]})${note}`, { images: facts.images === true }),
	);
}

/** Lets an ACP `route` take what its agent advertises: its models are rebuilt, the configured ones kept. */
function learning(route: CliModelRoute, configured: readonly string[] | undefined): CliModelRoute {
	if (route.kind === "acp")
		route.learn = (facts) => {
			route.models = modelsOf(route.provider, route.name, route.source, configured, facts);
		};
	return route;
}

/**
 * The built-in CLIs' routes: each enabled, installed runner of `states` (the session's external-agent selection) but
 * Claude Code and headless-only ones, over its own ACP server. A runner whose last check says signed out is listed as
 * unavailable with the login to run.
 */
export function builtinRoutes(states: readonly RunnerState[], env: NodeJS.ProcessEnv = process.env): CliModelRoute[] {
	return RUNNERS.filter(offered).flatMap((spec) => {
		const state = states.find((entry) => entry.id === spec.id);
		if (!state?.cli || !state.adapter) return [];
		const provider = builtinProvider(spec.id);
		const command = findOnPath(spec.adapter.command, env);
		const login = spec.login.length ? `run \`${[spec.cli, ...spec.login].join(" ")}\`` : `sign in with \`${spec.cli}\``;
		const disabled = !command
			? `${spec.adapter.command} was not found on PATH (${spec.adapter.install}).`
			: state.auth?.signedIn === false
				? `${spec.name} is signed out: ${login}, then reload.`
				: undefined;
		const facts = { models: state.models, images: state.acceptsImages, mcpHttp: state.acceptsMcpHttp };
		return [
			learning(
				{
					provider,
					name: spec.name,
					vendor: spec.id,
					kind: "acp" as const,
					command: command ?? spec.adapter.command,
					args: adapterArgs(spec, state.auth?.billing),
					source: "built-in" as const,
					models: modelsOf(provider, spec.name, "built-in", undefined, facts),
					plan: plan(state.auth?.billing ?? "plan", disabled),
					env: () => agentEnv(spec.id, env),
					permission: octocodeToolsOnly,
					instruction: "system/external-acp.md",
				},
				undefined,
			),
		];
	});
}

/** The executable an entry names: a path (relative to `cwd`) when it has a separator, else a PATH lookup. */
export function resolveCommand(command: string, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
	if (!command.includes("/") && !command.includes("\\")) return findOnPath(command, env);
	const full = path.resolve(cwd, command);
	return existsSync(full) ? full : undefined;
}

/**
 * A settings entry's route. `withheld` is why it may not run yet (a project entry not approved); a missing executable
 * is reported the same way, so the provider is listed as unavailable and nothing is started.
 */
export function entryRoute(
	entry: ExternalModelEntry,
	source: Exclude<RouteSource, "built-in">,
	options: { cwd: string; env?: NodeJS.ProcessEnv; withheld?: string; recheck?: () => string | undefined },
): CliModelRoute {
	const env = options.env ?? process.env;
	const name = entry.name ?? entry.id;
	const command = resolveCommand(entry.command, options.cwd, env);
	const disabled =
		options.withheld ??
		(command ? undefined : `${entry.command} was not found${entry.command.includes("/") ? "" : " on PATH"}.`);
	const passed = Object.fromEntries(
		(entry.env ?? []).flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]])),
	);
	return learning(
		{
			provider: entry.id,
			name,
			vendor: entry.id,
			kind: entry.kind,
			command: command ?? entry.command,
			args: entry.args ?? [],
			source,
			models: modelsOf(entry.id, name, source, entry.models),
			plan: plan("plan", disabled),
			env: () => ({ ...agentEnv(entry.id, env), ...passed }),
			permission: octocodeToolsOnly,
			instruction: entry.kind === "acp" ? "system/external-acp.md" : "system/external-cli.md",
			...(options.recheck ? { recheck: options.recheck } : {}),
		},
		entry.models,
	);
}
