import { randomUUID } from "node:crypto";
import { captureToolInvocation } from "../../core/tools/tool-invocation.ts";
import type { FeatureContext, ToolCallEvent, UserBashEvent, UserBashEventResult } from "../../core/features/index.ts";
import { visibleControls } from "@octocodeai/octocode-common/sanitize";
import { hasUserAuthority } from "../../core/input-origin.ts";
import type { Permission } from "./ask.ts";
import type { Gate, GateVerdict } from "./judge.ts";
import { catastrophicCommand } from "./shell/destructive.ts";

interface UserBashGateOptions {
	clientPermission: Gate;
	permission: Pick<Permission, "check" | "refused" | "typed" | "sourceDecision">;
	/** The PreToolUse hook step of the `tool_call` pipeline; it sees the `!cmd` as a `bash` call. */
	preToolUse: (event: ToolCallEvent, ctx: FeatureContext) => Promise<GateVerdict | undefined>;
}

/**
 * The `user_bash` handler for the user's own `!cmd`: typing it at the terminal is consent, so it runs and is recorded (from an
 * ACP or web client it goes through the permission check like an agent's call). A PreToolUse hook
 * that blocks it still refuses it, in every mode (audited, naming the hook), as it does an agent's call. In manual and
 * workspace a destructive command or one a hook asks about still asks, through the same permission check (audited, with
 * its reason lines); in full it runs. With no UI to ask in, the matrix decides. Octocode runs a `!cmd` in its bash shell on
 * every platform (`executeBash` → `getShellConfig`: Git Bash on Windows, never PowerShell; that is the `powershell`
 * tool's), so the bash rules classify it.
 */
export function userBashGate({ permission, preToolUse, clientPermission }: UserBashGateOptions) {
	return async (event: UserBashEvent, ctx: FeatureContext): Promise<UserBashEventResult | undefined> => {
		const call = {
			type: "tool_call",
			toolCallId: randomUUID(),
			origin: "user",
			toolName: "bash",
			input: { command: event.command },
		} as ToolCallEvent;
		const refusal = (message: string) => ({
			result: {
				output: `Refused: ${visibleControls(message)}`,
				exitCode: undefined,
				cancelled: true,
				truncated: false,
			},
		});
		const verdict = await preToolUse(call, ctx);
		if (verdict?.block) {
			const reason = verdict.reason ?? "Blocked by a PreToolUse hook.";
			permission.refused([`bash ${JSON.stringify(call.input)}`], reason, "bash");
			return refusal(reason);
		}
		if (!hasUserAuthority()) {
			const checked = await clientPermission(call, ctx, verdict);
			return checked?.block ? refusal(checked.reason ?? "Permission denied.") : undefined;
		}
		const hook = verdict?.ask;
		const destructive = catastrophicCommand(event.command, ctx.cwd) !== undefined;
		const invocation = captureToolInvocation(call.toolCallId, call.toolName, call.input);
		// Claude permission rules that say nothing about this command (and name no shell target) leave typing it as consent.
		const source = invocation && permission.sourceDecision(invocation, ctx.cwd);
		if (!destructive && !hook && (!source || (source.decision === "none" && !source.shellTargets?.length))) {
			permission.typed(event.command, ctx.cwd);
			return undefined;
		}
		const checked = await permission.check(ctx, {
			invocation,
			...(destructive ? { action: "shell.destructive" as const } : {}),
			title: destructive ? "Run this destructive command?" : "Run this command?",
			what: [event.command, `cwd: ${ctx.cwd}`],
			purpose: "",
			cwd: ctx.cwd,
			...(hook ? { reasons: ["hook.ask" as const], reason: hook } : {}),
			...(ctx.signal ? { signal: ctx.signal } : {}),
		});
		return checked.allowed ? undefined : refusal(checked.message);
	};
}
