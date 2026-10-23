import { permissionOutput } from "./permission-output.ts";
import { usesCodexSpecificDecision } from "./codex-output.ts";
import { runPromptHook, type PromptEvaluator } from "./prompt.ts";
import type { HookRun } from "./contracts.ts";
export type { HookRun } from "./contracts.ts";
import type { HookVerdict } from "./contracts.ts";
import type { JsonObject } from "@octocodeai/octocode-ai";
export type { HookVerdict } from "./contracts.ts";
import { runMcpHook } from "./mcp.ts";
import type { McpHookCaller } from "../../extensions/mcp/hook-caller.ts";
import { runHttpHook } from "./http.ts";
import { mkdirSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { formatSize } from "../../core/tools/index.ts";
import { KILL_GRACE_MS, killTree } from "../shared/process.ts";
import { visibleControls } from "../shared/sanitize.ts";
import { capOutputToFile } from "../shared/spill.ts";
import { errorMessage, firstLine, isRecord, parseJson } from "../shared/util.ts";
import {
	HOOK_OUTPUT_MAX_BYTES as OUTPUT_MAX_BYTES,
	type HookBase,
	type HookHandler,
	type HookEvent,
} from "./contracts.ts";
import { type HookProtocol, unsupportedOutput } from "./profiles.ts";

/** Context a hook may add to the conversation, as in the native host. */
export const HOOK_CONTEXT_MAX_BYTES = 16 * 1024;

/** Sends JSON on stdin; argv hooks spawn directly, otherwise commands use the shell. Spawn failures become results. */
export function runHook(
	hook: HookHandler,
	input: Record<string, unknown>,
	cwd: string,
	env: NodeJS.ProcessEnv = {},
	signal?: AbortSignal,
	mcp?: McpHookCaller,
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
	if (signal?.aborted) return Promise.resolve({ code: null, stdout: "", stderr: "", timedOut: false });
	return new Promise((resolve) => {
		// Detached on POSIX makes the shell a process-group leader, so a timeout can kill everything it started.
		const expand = (value: string) =>
			value.replace(
				/\$\{(CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA)\}/g,
				(placeholder, key: string) => environment[key] ?? placeholder,
			);
		const executable = hook.args !== undefined;
		const command = process.platform === "win32" && hook.commandWindows ? hook.commandWindows : hook.command;
		let child: ChildProcessWithoutNullStreams;
		try {
			if (hook.plugin) mkdirSync(hook.plugin.data, { recursive: true, mode: 0o700 });
			child = spawn(executable ? expand(command) : command, executable ? hook.args!.map(expand) : [], {
				cwd,
				shell: !executable,
				detached: process.platform !== "win32",
				env: environment,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			resolve({ code: null, stdout: "", stderr: errorMessage(error), timedOut: false });
			return;
		}
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let outBytes = 0;
		let errBytes = 0;
		let timedOut = false;
		const collect = (chunks: Buffer[], size: number, chunk: Buffer): number => {
			if (size < OUTPUT_MAX_BYTES) chunks.push(chunk.subarray(0, OUTPUT_MAX_BYTES - size));
			return size + chunk.length;
		};
		child.stdout.on("data", (chunk: Buffer) => {
			outBytes = collect(out, outBytes, chunk);
			return outBytes;
		});
		child.stderr.on("data", (chunk: Buffer) => {
			errBytes = collect(err, errBytes, chunk);
			return errBytes;
		});
		let settled = false;
		let deadline: NodeJS.Timeout | undefined;
		const stop = () => {
			if (deadline) return;
			// The whole tree: the shell's children and grandchildren too, not only the shell.
			killTree(child.pid, KILL_GRACE_MS);
			// A grandchild that survives or holds stdio open must not hold the run: resolve anyway after the grace.
			deadline = setTimeout(() => finish(null), 2 * KILL_GRACE_MS);
			deadline.unref();
			child.unref();
		};
		const timer =
			hook.protocol === "claude" && hook.async && !hook.asyncRewake
				? undefined
				: setTimeout(() => {
						timedOut = true;
						stop();
					}, hook.timeoutMs);
		if (signal?.aborted) stop();
		else signal?.addEventListener("abort", stop, { once: true });
		const finish = (code: number | null, extra = "") => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(deadline);
			for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
			signal?.removeEventListener("abort", stop);
			const dropped = {
				stdout: Math.max(0, outBytes - OUTPUT_MAX_BYTES),
				stderr: Math.max(0, errBytes - OUTPUT_MAX_BYTES),
			};
			resolve({
				code,
				stdout: Buffer.concat(out).toString("utf8"),
				stderr: `${Buffer.concat(err).toString("utf8")}${extra}`,
				timedOut,
				...(dropped.stdout + dropped.stderr > 0 ? { dropped } : {}),
			});
		};
		child.on("error", (error) => finish(null, error.message));
		child.on("close", (code) => finish(code));
		// A hook that ignores stdin closes the pipe early; that is not an error.
		child.stdin.on("error", () => undefined);
		child.stdin.end(JSON.stringify(input));
	});
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
		...(block ? { block: visibleControls(block) } : {}),
		...(context ? { context: visibleControls(context) } : {}),
		...(continueReason ? { continueReason: visibleControls(continueReason) } : {}),
		...(ask ? { ask: visibleControls(ask) } : {}),
	};
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
			? `\n[… ${formatSize(bytes)} more output not kept: a hook's output is read up to ${formatSize(OUTPUT_MAX_BYTES)}]`
			: "";
	if (run.code === 2 && (event === "PostToolUseFailure" || event === "SubagentStart")) return {};
	if (run.code === 2 && protocol === "codex" && event === "PreToolUse" && !run.stderr.trim())
		return { error: "Codex PreToolUse exit 2 requires a blocking reason on stderr" };
	if (run.code === 2)
		return {
			...(protocol === "codex" && event === "PostToolUse"
				? ({ replaceResult: true, rejectNested: true } as const)
				: {}),
			block: run.stderr.trim() ? `${run.stderr.trim()}${notKept(run.dropped?.stderr)}` : "Blocked by a hook.",
		};
	if (run.code !== 0) return {};
	const value = parseJson(run.stdout);
	const json = isRecord(value) ? value : undefined;
	if (!json && protocol === "codex" && event === "PreToolUse" && run.stdout.trim())
		return { error: "Codex PreToolUse output must be a JSON object" };
	if (!json && protocol === "codex" && event === "SubagentStart" && /^[{[]/.test(run.stdout.trimStart()))
		return { error: "Codex SubagentStart returned invalid JSON output" };
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
	const specific = isRecord(json.hookSpecificOutput) ? json.hookSpecificOutput : {};
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
		...(blocked && event !== "PostToolUseFailure" ? { block: reason ?? "Blocked by a hook." } : {}),
		...(asks ? { ask: reason ?? `A ${event} hook asks you to confirm this call.` } : {}),
		...(context && event !== "PreMessageSend" ? { context } : {}),
		...(context && (event === "Stop" || event === "SubagentStop") && protocol === "claude"
			? { continueReason: context }
			: {}),
	};
}

/**
 * Why a `PreToolUse` hook did not give an answer: it timed out, crashed (could not start, was killed, or exited with a
 * code other than 0 and 2), or printed JSON that does not parse to an object (plain text is a normal answer). Hooks fail open, as in Claude Code, so a
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

/** Keeps hook text within 16 KB: longer text is saved whole to a file and shown as its head and tail with the path. */
export function capContext(text: string, maxBytes = HOOK_CONTEXT_MAX_BYTES): string {
	return capOutputToFile(text, { label: "hook", maxBytes });
}
