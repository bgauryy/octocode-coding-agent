import type { ToolInvocation } from "../../../core/features/index.ts";
import { evaluateSourcePolicy } from "../../permission/source-policy.ts";
import { parseSourcePolicy, type SourcePolicy } from "../../permission/source-policy/rules.ts";
import { fileChanges } from "../../tool-input/file-input.ts";
import type { HookHandler } from "../contracts.ts";

/** Events where Claude Code evaluates a handler's `if` (it also lists PermissionDenied, which this runtime does not emit). */
export const IF_EVENTS: readonly string[] = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"];

const parsed = new Map<string, SourcePolicy | undefined>();

/** The single permission rule an `if` holds, or undefined when it is not a valid rule. Claude: "The `if` field holds exactly one permission rule." */
function rulePolicy(condition: string): SourcePolicy | undefined {
	if (parsed.has(condition)) return parsed.get(condition);
	const policy = parseSourcePolicy({ permissions: { deny: [condition] } }, { path: "hook if", anchor: "" });
	const valid = policy.errors.length === 0 && policy.rules.length === 1 && !policy.rules[0].invalid;
	parsed.set(condition, valid ? policy : undefined);
	return valid ? policy : undefined;
}

/** Whether `condition` is a valid permission rule (the config check). */
export const validIfCondition = (condition: unknown): condition is string =>
	typeof condition === "string" && rulePolicy(condition) !== undefined;

/**
 * The hook filter for one tool call: a hook with `if` runs when its permission rule matches the call, and also when the
 * matcher cannot judge the call (`unsupported`), so a guard is never silently skipped.
 * A `file` call is judged per query: `index` is the query's position in `fileChanges`.
 */
export function ifFilter(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	index?: number,
): (hook: HookHandler) => boolean {
	const invocation: ToolInvocation = {
		active: true,
		toolCallId: "",
		toolName,
		input: toolName === "file" && index !== undefined ? { queries: fileChanges(input).slice(index, index + 1) } : input,
	};
	return (hook) => {
		if (hook.if === undefined) return true;
		const policy = rulePolicy(hook.if);
		if (!policy) return false;
		try {
			return evaluateSourcePolicy(policy, invocation, cwd).decision !== "none";
		} catch {
			return true;
		}
	};
}
