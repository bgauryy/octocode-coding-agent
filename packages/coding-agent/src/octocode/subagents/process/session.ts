import fs from "node:fs";
import path from "node:path";
import { getToolListError } from "../../../core/settings-manager.ts";
import { privateDir, sessionOutputDir } from "../../shared/home.ts";
import { type AgentProfile, profileExcludes, profileSelectsBrowser, profileTools } from "../profiles.ts";
import { BROWSER_SERVER, mcpNamespace } from "../../../../../common/src/mcp-names.ts";
import type { Identity } from "./env.ts";
import { operatorLimits } from "./operator-limits.ts";

/** Where a child saves its conversation: Octocode's session folder and the session id. */
export interface ChildSession {
	dir: string;
	id: string;
}

/** A fresh conversation gets its own UUID. A resumed child retains the ID recorded in the parent's transcript. */
export function childSession(identity: Pick<Identity, "id" | "sessionId" | "scratch">): ChildSession {
	const root = identity.scratch ?? reportDir(identity.id);
	if (!root)
		throw new Error(
			`Subagent ${identity.id} has nowhere to save its session: neither its scratch folder nor the output folder can be written.`,
		);
	return { dir: path.join(root, "session"), id: identity.sessionId ?? identity.id };
}

/** The saved session file (`<timestamp>_<id>.jsonl`). Strict callers distinguish absent history from unreadable history. */
export function childSessionFile(session: ChildSession, strict = false): string | undefined {
	try {
		const name = fs.readdirSync(session.dir).find((entry) => entry.endsWith(`_${session.id}.jsonl`));
		return name ? path.join(session.dir, name) : undefined;
	} catch (error) {
		if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return undefined;
	}
}

/**
 * The Octocode arguments of a child. It runs in RPC mode: the task is not an argument (RPC ignores a positional task and
 * rejects `@file`) but a `prompt` command that `runSubagent` writes to its stdin, so a task of any length goes whole.
 */
export function buildAgentArgs(
	profile: AgentProfile | undefined,
	model: string | undefined,
	session: ChildSession,
	skillPaths?: readonly string[],
	/** The level of a child with no model to suffix (`ModelRoute.thinking`). */
	thinking?: string,
	/** Servers a task named (`Identity.mcpNamed`): a child that selects by allowlist gets their tools in it. */
	namedServers: readonly string[] = [],
	/** `ModelRoute.fallbackModels`: the models the child continues on when its own fails on a credential, limit or outage. */
	fallbackModels: readonly string[] = [],
): string[] {
	// `--rpc-ask`: the parent's relay answers typed question batches (`ChildRelay`), so the child sends `ask`, not select/input.
	// `--rpc-lean-events`: each message and tool result arrives whole once; the parent reads no repeated copy (`events.ts`).
	const args = [
		"--mode",
		"rpc",
		"--rpc-ask",
		"--rpc-lean-events",
		"--session-dir",
		session.dir,
		"--session-id",
		session.id,
	];
	// The built-in MCP feature serves Octocode's research tools and the user's own MCP servers: every specialist needs
	// local research. A lean child runs without any MCP server, and so does every child of an operator's `--no-mcp`.
	const operator = operatorLimits();
	if (profile?.lean || operator.noMcp) args.push("--no-mcp");
	// `model` is already resolved (`provider/id`, optionally `:thinking`); none means the parent's model. The profile's own
	// preference is routed by `routeModel` before this, so an unavailable one never reaches Octocode.
	if (model) args.push("--model", model);
	else if (thinking) args.push("--thinking", thinking);
	if (fallbackModels.length > 0) args.push("--set", `retry.fallbackModels=${JSON.stringify(fallbackModels)}`);
	const tools = profileTools(profile);
	// A `+name` list takes exact names, so the child's MCP host selects a named server itself (`isSelected`, from the
	// handoff file's `only`); only an allowlist needs the server's pattern in it.
	const relative = tools.split(",").some((name) => /^[+-]/.test(name));
	const selection = relative ? tools : [tools, ...namedServers.map((name) => `${mcpNamespace(name)}__*`)].join(",");
	// The child refuses an invalid list at its own argument parsing, before its first turn: refuse the call instead.
	const invalid = getToolListError(selection.split(","));
	if (invalid)
		throw new Error(`The tools of ${profile?.name ?? "this"} child are invalid (${invalid}); fix the profile's tools.`);
	args.push("--tools", selection);
	// The browser server belongs to the profiles that name it (the `browser` specialist): a child whose profile does not
	// never starts it, whatever turned it on for the main session (`defaultTools`, `defaultActive`, `/mcp assign`). The floor
	// `profileTools` keeps binds profiles, not the operator: what `--exclude-tools` took away stays away.
	const excluded = [
		...operator.excludeTools,
		...profileExcludes(profile?.excludeTools),
		...(profileSelectsBrowser(profile) ? [] : [`${mcpNamespace(BROWSER_SERVER)}__*`]),
	];
	if (excluded.length > 0) args.push("--exclude-tools", excluded.join(","));
	if (skillPaths !== undefined) args.push("--no-skills");
	for (const file of skillPaths ?? []) args.push("--skill", file);
	return args;
}

/** `buildAgentArgs` for a planned run: its profile, the route's model, level and fallback models, and the servers its task named. */
export const buildRouteArgs = (
	profile: AgentProfile | undefined,
	route: { model?: string; thinking?: string; fallbackModels?: readonly string[] },
	session: ChildSession,
	namedServers?: readonly string[],
): string[] => buildAgentArgs(profile, route.model, session, [], route.thinking, namedServers, route.fallbackModels);

/** Where a child without a scratch folder (an unwritable workspace) spills a long report, so a cut report always has its whole copy. */
export function reportDir(id: string): string | undefined {
	try {
		return privateDir(path.join(sessionOutputDir("output"), `agent-${id.replace(/[^\w.-]/g, "_")}`));
	} catch {
		return undefined;
	}
}
