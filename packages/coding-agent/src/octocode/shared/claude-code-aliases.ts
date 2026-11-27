import { isRecord } from "@octocodeai/octocode-contracts/guards";

/**
 * Models trained on Claude Code send its tool fields here. Each one becomes ours when the call does not also set ours,
 * so the call does what it meant instead of costing a rejected round trip or silently ignoring a field.
 */

/** Claude Code's Agent fields; its default agent, `general-purpose`, is ours when no profile is named. */
const TASK_ALIASES: Readonly<Record<string, string>> = {
	prompt: "task",
	description: "goal",
	subagent_type: "profile",
	run_in_background: "background",
};

/** Claude Code's Bash fields: `description` says what the command does, which is our `reason`. */
const BASH_ALIASES: Readonly<Record<string, string>> = { run_in_background: "background", description: "reason" };

function renamed(call: Record<string, unknown>, aliases: Readonly<Record<string, string>>): Record<string, unknown> {
	for (const [theirs, ours] of Object.entries(aliases)) {
		if (!(theirs in call)) continue;
		if (!(ours in call)) call[ours] = call[theirs];
		delete call[theirs];
	}
	return call;
}

/** An `agent` call with Claude Code's task fields renamed to ours; any other call unchanged. */
export function claudeCodeTaskAliases(args: unknown): unknown {
	if (!isRecord(args) || !("prompt" in args || "subagent_type" in args)) return args;
	if (args.type !== undefined && args.type !== "task") return args;
	const call: Record<string, unknown> = { ...args, type: "task" };
	// `action: "task"` names the type in a call that has none; `action` belongs to `coordinate`.
	if (args.type === undefined && call.action === "task") delete call.action;
	renamed(call, TASK_ALIASES);
	if (call.profile === "general-purpose") delete call.profile;
	return call;
}

/** A `bash` call with Claude Code's Bash fields renamed to ours; any other call unchanged. */
export function claudeCodeBashAliases(args: unknown): unknown {
	if (!isRecord(args) || !("run_in_background" in args || "description" in args)) return args;
	return renamed({ ...args }, BASH_ALIASES);
}
