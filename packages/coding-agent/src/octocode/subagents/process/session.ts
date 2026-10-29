import fs from "node:fs";
import path from "node:path";
import { privateDir, sessionOutputDir } from "../../shared/home.ts";
import { type AgentProfile, profileExcludes, profileTools } from "../profiles.ts";
import type { Identity } from "./env.ts";

/** Where a child saves its conversation: Octocode's session folder and the session id (the child's name, so its Octocode folder maps back to it). */
export interface ChildSession {
	dir: string;
	id: string;
}

/**
 * Every child saves its conversation in its scratch folder (`<scratch>/session`, removed with the folder), under its
 * own name (no new child gets the name of an existing scratch folder, `scratchNames`, so none reopens another's): its compaction summary then names a transcript to read, and the parent can find it. Without a scratch
 * folder it goes to the run's private output folder. Whether the child stays reachable is `lingerSeconds`, not this.
 */
export function childSession(identity: Pick<Identity, "id" | "scratch">): ChildSession {
	const root = identity.scratch ?? reportDir(identity.id);
	if (!root)
		throw new Error(
			`Subagent ${identity.id} has nowhere to save its session: neither its scratch folder nor the output folder can be written.`,
		);
	return { dir: path.join(root, "session"), id: identity.id };
}

/** The saved session file (`<timestamp>_<id>.jsonl`, named by Octocode), once the child has written it. */
export function childSessionFile(session: ChildSession): string | undefined {
	try {
		const name = fs.readdirSync(session.dir).find((entry) => entry.endsWith(`_${session.id}.jsonl`));
		return name ? path.join(session.dir, name) : undefined;
	} catch {
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
): string[] {
	const args = ["--mode", "rpc", "--session-dir", session.dir, "--session-id", session.id];
	// `--no-extensions` also turns off Octocode's built-in MCP extension, which serves Octocode's research tools and the
	// user's own MCP servers: every specialist needs local research. A lean child runs without any MCP server.
	if (profile?.lean) args.push("--no-extensions", "--no-mcp");
	else args.push("--no-extensions", "-e", "builtin:mcp");
	// `model` is already resolved (`provider/id`, optionally `:thinking`); none means the parent's model. The profile's own
	// preference is routed by `routeModel` before this, so an unavailable one never reaches Octocode.
	if (model) args.push("--model", model);
	args.push("--tools", profileTools(profile));
	if (profile?.excludeTools) args.push("--exclude-tools", profileExcludes(profile.excludeTools).join(","));
	if (skillPaths !== undefined) args.push("--no-skills");
	for (const file of skillPaths ?? []) args.push("--skill", file);
	return args;
}

/** Where a child without a scratch folder (an unwritable workspace) spills a long report, so a cut report always has its whole copy. */
export function reportDir(id: string): string | undefined {
	try {
		return privateDir(path.join(sessionOutputDir("output"), `agent-${id.replace(/[^\w.-]/g, "_")}`));
	} catch {
		return undefined;
	}
}
