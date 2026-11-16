import { permissionOutput } from "./permission-output.ts";
import { usesCodexSpecificDecision } from "./codex-output.ts";
import { runPromptHook, type PromptEvaluator } from "./prompt.ts";
import {
	type HookRun,
	type HookVerdict,
	HOOK_COMMAND_OUTPUT_MAX_BYTES,
	type HookBase,
	type HookHandler,
} from "./contracts.ts";
import type { JsonObject } from "@octocodeai/octocode-ai";
import { runMcpHook } from "./mcp.ts";
import type { BoundMcpHookCaller } from "../../../../mcp/src/api.ts";
import { runHttpHook } from "./http.ts";
import { formatBytes } from "@octocodeai/octocode-common/bytes";
import { visibleControls } from "@octocodeai/octocode-common/sanitize";
import { capOutputToFile } from "../shared/spill.ts";
import { firstLine, parseJson } from "../shared/util.ts";
import type { HookEvent, HookProtocol } from "./catalog.ts";
import { unsupportedOutput } from "./profiles.ts";
import { asRecord, isRecord } from "@octocodeai/octocode-contracts/guards";
import { runCommandHook } from "./command.ts";

/** Context a hook may add to the conversation, as in the native host. */
export const HOOK_CONTEXT_MAX_BYTES = 16 * 1024;
/** Claude Code caps each `additionalContext`, `systemMessage` and plain stdout string at 10,000 characters (hooks reference, "Add context for Claude"). */
export const CLAUDE_HOOK_CONTEXT_MAX = 10_000;

/** Sends JSON on stdin; argv hooks spawn directly, otherwise commands use the shell. Spawn failures become results. */
export function runHook(
	hook: HookHandler,
	input: Record<string, unknown>,
	cwd: string,
	env: NodeJS.ProcessEnv = {},
	signal?: AbortSignal,
	mcp?: BoundMcpHookCaller,
	evaluate?: PromptEvaluator,
): Promise<HookRun> {
	if (hook.configurationError)
		return Promise.resolve({ code: null, stdout: "", stderr: hook.configurationError, timedOut: false });
	if (hook.type === "mcp_tool") return runMcpHook(hook, input, signal, mcp);
	if (hook.type === "prompt") return runPromptHook(hook, input, signal, evaluate);
	const environment: NodeJS.ProcessEnv = {
		...process.env,
		...env,
		...(hook.plugin
			? {
					CLAUDE_PLUGIN_ROOT: hook.plugin.root,
					CLAUDE_PLUGIN_DATA: hook.plugin.data,
					...(hook.protocol === "codex" ? { PLUGIN_ROOT: hook.plugin.root, PLUGIN_DATA: hook.plugin.data } : {}),
				}
			: {}),
	};
	if (hook.type === "http") return runHttpHook(hook, input, environment, signal);
	return runCommandHook(hook, input, cwd, environment, signal);
}

/**
 * Octocode command-hook subset: exit 2 blocks with stderr as the reason; exit 0 may print JSON with `decision: "block"`,
 * `continue: false`, `hookSpecificOutput.permissionDecision: "deny"` or `additionalContext`; plain SessionStart stdout
 * is context. A PreToolUse `permissionDecision: "ask"` asks the user; `"allow"` skips no ask. Any other exit is a
 * non-blocking error.
 */
export function interpret(event: HookEvent, run: HookRun, protocol: HookProtocol = "octocode"): HookVerdict {
	// Hook output is untrusted text: it reaches the model and Octocode's tool errors without escape sequences.
	const {
		permissionDecision,
		permissionInterrupt,
		systemMessage,
		block,
		context,
		continueReason,
		ask,
		stop,
		haltTurn,
		error,
		replaceResult,
		rejectNested,
		updatedInput,
		updatedPermissions,
	} = verdictOf(event, run, protocol);
	return {
		...(permissionDecision ? { permissionDecision } : {}),
		...(updatedPermissions ? { updatedPermissions } : {}),
		...(permissionInterrupt ? { permissionInterrupt } : {}),
		...(systemMessage ? { systemMessage: visibleControls(systemMessage) } : {}),
		...(updatedInput ? { updatedInput, updatedInputProtocol: protocol } : {}),
		...(replaceResult ? { replaceResult } : {}),
		...(rejectNested ? { rejectNested } : {}),
		...(error ? { error: visibleControls(error) } : {}),
		...(stop ? { stop } : {}),
		...(haltTurn ? { haltTurn } : {}),
		...(block ? { block: visibleControls(block) } : {}),
		...(context ? { context: visibleControls(context) } : {}),
		...(continueReason ? { continueReason: visibleControls(continueReason) } : {}),
		...(ask ? { ask: visibleControls(ask) } : {}),
	};
}

/** The reason of a blocking JSON decision (`decision: "block"` or a `permissionDecision` of `deny`) printed on stdout. */
function blockingReason(stdout: string): string | undefined {
	const json = parseJson(stdout);
	if (!isRecord(json)) return undefined;
	const specific = asRecord(json.hookSpecificOutput);
	const reason =
		json.decision === "block"
			? json.reason
			: specific.permissionDecision === "deny"
				? specific.permissionDecisionReason
				: undefined;
	return typeof reason === "string" && reason.trim() ? reason : undefined;
}

function verdictOf(event: HookEvent, run: HookRun, protocol: HookProtocol): HookVerdict {
	if (event === "PermissionRequest") return permissionOutput(run, protocol);
	if (event === "Interrupt") {
		if (run.timedOut) return {};
		if (run.code !== 0) return { error: `Codex Interrupt hook exited with code ${run.code}` };
		if (!run.stdout.trim()) return {};
		const output = parseJson(run.stdout);
		if (!isRecord(output)) return { error: "Codex Interrupt requires JSON object output" };
		const error = unsupportedOutput(protocol, event, output);
		return error ? { error } : typeof output.systemMessage === "string" ? { systemMessage: output.systemMessage } : {};
	}

	// Notification hooks are side effects only: they cannot block or add context.
	if (
		event === "SessionEnd" ||
		event === "AgentOn" ||
		event === "AgentOff" ||
		event === "StopFailure" ||
		(protocol === "claude" && event === "PostCompact") ||
		run.timedOut ||
		event === "Notification" ||
		event === "PostMessageReceive"
	)
		return {};
	// Output past the kept bytes is counted, never dropped silently.
	const notKept = (bytes = 0) =>
		bytes > 0
			? `\n[… ${formatBytes(bytes, "compact")} more output not kept: a hook's output is read up to ${formatBytes(HOOK_COMMAND_OUTPUT_MAX_BYTES, "compact")}]`
			: "";
	// Claude: exit 2 of SessionStart/SubagentStart "shows stderr to user only"; it neither blocks nor reaches the model.
	if (run.code === 2 && protocol === "claude" && (event === "SessionStart" || event === "SubagentStart"))
		return run.stderr.trim()
			? { systemMessage: `${event} hook: ${run.stderr.trim()}${notKept(run.dropped?.stderr)}` }
			: {};
	if (run.code === 2 && event === "SubagentStart") return {};
	// Claude: a Stop hook whose script is missing exits 2 with the shell's message; that is a failure to run, not a block.
	if (
		run.code === 2 &&
		protocol === "claude" &&
		(event === "Stop" || event === "SubagentStop") &&
		!run.stdout.trim() &&
		/No such file or directory/i.test(run.stderr)
	)
		return {};
	if (run.code === 2 && protocol === "codex" && event === "PreToolUse" && !run.stderr.trim())
		return { error: "Codex PreToolUse exit 2 requires a blocking reason on stderr" };
	if (run.code === 2)
		return {
			...(protocol === "codex" && event === "PostToolUse"
				? ({ replaceResult: true, rejectNested: true } as const)
				: {}),
			// A JSON blocking decision's reason wins over stderr (Claude Code); the exit code alone decides the block.
			block:
				(protocol !== "codex" ? blockingReason(run.stdout) : undefined) ??
				(run.stderr.trim() ? `${run.stderr.trim()}${notKept(run.dropped?.stderr)}` : "Blocked by a hook."),
		};
	if (run.code !== 0) return {};
	const value = parseJson(run.stdout);
	const json = isRecord(value) ? value : undefined;
	if (!json && protocol === "codex" && event === "PreToolUse" && run.stdout.trim())
		return { error: "Codex PreToolUse output must be a JSON object" };
	if (!json && protocol === "codex" && event === "SubagentStart" && /^[{[]/.test(run.stdout.trimStart()))
		return { error: "Codex SubagentStart returned invalid JSON output" };
	// Codex: "Stop expects JSON on stdout when it exits 0. Plain text output is invalid for this event."
	if (!json && protocol === "codex" && (event === "Stop" || event === "SubagentStop") && run.stdout.trim())
		return { error: `Codex ${event} requires JSON output` };
	if (!json)
		return (event === "SessionStart" || event === "SubagentStart" || event === "UserPromptSubmit") && run.stdout.trim()
			? { context: `${run.stdout.trim()}${notKept(run.dropped?.stdout)}` }
			: {};
	const error = unsupportedOutput(protocol, event, json);
	if (error) return { error };
	if (
		(event === "Stop" || event === "SubagentStop" || (event === "PostCompact" && protocol === "codex")) &&
		json.continue === false
	)
		return { stop: true };
	const specific = asRecord(json.hookSpecificOutput);
	if (
		event === "PreToolUse" &&
		protocol !== "octocode" &&
		"updatedInput" in specific &&
		(protocol !== "codex" || specific.updatedInput != null)
	) {
		if (!isRecord(specific.updatedInput)) return { error: "updatedInput must be an object" };
		if (protocol === "codex" && specific.permissionDecision !== "allow")
			return { error: "Codex updatedInput requires permissionDecision allow" };
	}
	if (event === "SubagentStart")
		return typeof specific.additionalContext === "string" && specific.additionalContext.trim()
			? { context: specific.additionalContext.trim() }
			: {};
	const codexSpecific = protocol === "codex" && event === "PreToolUse" && usesCodexSpecificDecision(specific);
	const rawReason = (
		codexSpecific
			? [specific.permissionDecisionReason]
			: [json.reason, json.stopReason, specific.permissionDecisionReason]
	).find((value): value is string => typeof value === "string" && value.trim() !== "");
	const reason = protocol === "codex" && event === "PreToolUse" ? rawReason?.trim() : rawReason;
	const context =
		typeof specific.additionalContext === "string" && specific.additionalContext.trim()
			? specific.additionalContext.trim()
			: undefined;
	// For Stop, `continue: false` means "stop for good", the opposite of blocking (which keeps the agent going).
	const blocked =
		(!codexSpecific && json.decision === "block") ||
		(event !== "Stop" &&
			event !== "SubagentStop" &&
			((!(protocol === "claude" && event === "PreCompact") && json.continue === false) ||
				specific.permissionDecision === "deny"));
	// Claude: "continue: false" stops processing entirely, even after a tool call completed or failed.
	const halts =
		protocol === "claude" &&
		json.continue === false &&
		(event === "PreToolUse" || event === "PostToolUse" || event === "PostToolUseFailure");
	const asks =
		!blocked && (event === "PreToolUse" || event === "PreMessageSend") && specific.permissionDecision === "ask";
	return {
		...(!blocked &&
		event === "PreToolUse" &&
		protocol !== "octocode" &&
		specific.permissionDecision !== "defer" &&
		isRecord(specific.updatedInput)
			? { updatedInput: specific.updatedInput as JsonObject }
			: {}),
		...(blocked && protocol === "codex" && event === "PostToolUse"
			? ({ replaceResult: true, ...(json.decision === "block" ? ({ rejectNested: true } as const) : {}) } as const)
			: {}),
		...(halts ? { haltTurn: true as const } : {}),
		...(blocked && (event !== "PostToolUseFailure" || halts) ? { block: reason ?? "Blocked by a hook." } : {}),
		...(asks ? { ask: reason ?? `A ${event} hook asks you to confirm this call.` } : {}),
		...(context && event !== "PreMessageSend" ? { context } : {}),
		...(context && (event === "Stop" || event === "SubagentStop") && protocol === "claude"
			? { continueReason: context }
			: {}),
	};
}

/**
 * Why a `PreToolUse` hook did not give an answer: it timed out, crashed (could not start, was killed, or exited with a
 * code other than 0 and 2), or printed JSON that does not parse to an object (plain text is a normal answer). Hooks fail open, as the hook protocol specifies, so a
 * broken security hook would allow every call: the caller shows this and audits it, and denies when the hook is
 * `failClosed`. Undefined when the hook answered, or the run was cancelled.
 */
export function failureOf(hook: Pick<HookBase, "timeoutMs">, run: HookRun, cancelled: boolean): string | undefined {
	if (cancelled) return undefined;
	if (run.timedOut) return `timed out after ${hook.timeoutMs / 1000}s`;
	if (run.code === null)
		return `crashed${run.stderr.trim() ? `: ${firstLine(run.stderr.trim())}` : " (could not run or was killed)"}`;
	if (run.code !== 0 && run.code !== 2) return `crashed (exit ${run.code})`;
	const out = run.stdout.trim();
	if (run.code === 0 && /^[[{]/.test(out) && !isRecord(parseJson(out))) return "printed invalid JSON";
	return undefined;
}

/**
 * Claude Code reads a command hook's JSON object on any exit code other than 2: the fields alone decide and the exit
 * code is ignored, so a deny printed by a hook that exits 1 still denies. A hook whose failure blocks the action
 * (`onFailure: "block"` or `failClosed`) keeps the exit code and fails, as Claude Code counts it.
 */
export function claudeJsonRun(hook: HookHandler, run: HookRun): HookRun {
	if (hook.protocol !== "claude" || (hook.type !== undefined && hook.type !== "command")) return run;
	if (hook.failClosed || hook.onFailure === "block" || run.timedOut) return run;
	if (run.code === null || run.code === 0 || run.code === 2) return run;
	return isRecord(parseJson(run.stdout.trim())) ? { ...run, code: 0 } : run;
}

/** Keeps hook text within 16 KB: longer text is saved whole to a file and shown as its head and tail with the path. */
export function capContext(text: string, maxBytes = HOOK_CONTEXT_MAX_BYTES): string {
	return capOutputToFile(text, { label: "hook", maxBytes });
}
