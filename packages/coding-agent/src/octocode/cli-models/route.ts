import type { Model, ProviderPlan } from "@octocodeai/octocode-ai";
import type { AcpPermission } from "../../../../acp/src/client/client.ts";

/** Where a route was declared: shipped with Octocode, or an `externalModels` entry of a settings file. */
export type RouteSource = "built-in" | "global" | "project";

/** The words `/model` and `/providers` show for a source. */
export const SOURCE_WORDS: Record<RouteSource, string> = {
	"built-in": "built-in CLI",
	global: "settings.json",
	project: "project settings.json",
};

/** The API every route's models declare: no HTTP request of Octocode's; the turn runs in the vendor's own CLI. */
const CLI_MODEL_API = "external-cli";

/** The MCP server name an agent sees Octocode's tools under (`mcp__octocode__<tool>` in Claude Code). */
export const TOOL_SERVER = "octocode";

/**
 * One external CLI or ACP agent offered as a main-session provider: plain data and a few hooks, so Claude Code, the
 * built-in runners and user-declared entries share one backend (`backend.ts`).
 */
export interface CliModelRoute {
	/** The provider id (`codex-cli`, a settings entry's `id`). */
	provider: string;
	name: string;
	/** The runner id or entry id: the ACP vendor, and whose own variables `agentEnv` keeps. */
	vendor: string;
	/** `acp`: one ACP session per Octocode session with Octocode's tools over MCP; `cli`: one process per request. */
	kind: "acp" | "cli";
	command: string;
	args: readonly string[];
	source: RouteSource;
	models: readonly Model<string>[];
	/**
	 * ACP only: called when a session learns what the agent advertises (its models, and whether it takes images and MCP
	 * servers over HTTP); the route's `models` then show it.
	 */
	learn?(facts: AgentFacts): void;
	/** Billing and access facts; `disabled` is why the route is unavailable (a missing binary, no approval yet). */
	plan: ProviderPlan;
	/** The agent's whole environment for `model`. */
	env(model: string): NodeJS.ProcessEnv;
	/** ACP only: answers the agent's own permission requests. */
	permission: AcpPermission;
	/**
	 * ACP only: the agent's own session options carrying Octocode's instruction. Absent: the instruction leads a new
	 * session's first prompt.
	 */
	sessionMeta?(instruction: string): Record<string, unknown>;
	/** True: the model is chosen through `env`, never through ACP model selection (Claude Code's alias variable). */
	modelInEnv?: boolean;
	/**
	 * Called before every process start: why the route may not start now (an approved project file changed since),
	 * else undefined.
	 */
	recheck?(): string | undefined;
	/** The prompt template of Octocode's instruction to the agent. */
	instruction: string;
	/** Called when the agent answers `auth_required`: a cached sign-in check is stale. */
	signedOut?(): void | Promise<void>;
}

/** What an ACP agent said about itself in `initialize` and `session/new`. */
export interface AgentFacts {
	/** The model ids it advertises. */
	models?: readonly string[];
	images?: boolean;
	/** Whether it connects to MCP servers over HTTP, which is how it reaches Octocode's tools. */
	mcpHttp?: boolean;
}

/** The model id that leaves the choice to the CLI's own configuration. */
export const DEFAULT_MODEL = "default";

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** A route's model: no Octocode price (the CLI bills its own way) and no thinking levels (the CLI chooses). */
export function routeModel(
	provider: string,
	id: string,
	name: string,
	limits: { api?: string; baseUrl?: string; contextWindow?: number; maxTokens?: number; images?: boolean } = {},
): Model<string> {
	return {
		id,
		name,
		api: limits.api ?? CLI_MODEL_API,
		provider,
		baseUrl: limits.baseUrl ?? `cli:${provider}`,
		reasoning: false,
		input: limits.images ? ["text", "image"] : ["text"],
		cost: ZERO,
		contextWindow: limits.contextWindow ?? 200_000,
		maxTokens: limits.maxTokens ?? 64_000,
	};
}
