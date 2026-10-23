import { captureToolInvocation } from "../../core/tools/tool-invocation.ts";
import type {
	ExtensionContext,
	ToolCallEvent,
	UserBashEvent,
	UserBashEventResult,
} from "../../core/extensions/index.ts";
import { visibleControls } from "../shared/sanitize.ts";
import type { Permission } from "./ask.ts";
import type { GateVerdict } from "./gate.ts";
import { catastrophicCommand } from "./shell.ts";

interface UserBashGateOptions {
	permission: Pick<Permission, "check" | "refused" | "typed" | "hasSourcePolicy">;
	/** The PreToolUse hook step of the `tool_call` pipeline; it sees the `!cmd` as a `bash` call. */
	preToolUse: (event: ToolCallEvent, ctx: ExtensionContext) => Promise<GateVerdict | undefined>;
}

/**
 * The `user_bash` handler for the user's own `!cmd`: typing it is consent, so it runs and is recorded. A PreToolUse hook
 * that blocks it still refuses it, in every mode (audited, naming the hook), as it does an agent's call. In manual and
 * workspace a destructive command or one a hook asks about still asks, through the same permission check (audited, with
 * its reason lines); in full it runs. With no UI to ask in, the matrix decides. Octocode runs a `!cmd` in its bash shell on
 * every platform (`executeBash` → `getShellConfig`: Git Bash on Windows, never PowerShell; that is the `powershell`
 * tool's), so the bash rules classify it.
 */
export function userBashGate({ permission, preToolUse }: UserBashGateOptions) {
	return async (event: UserBashEvent, ctx: ExtensionContext): Promise<UserBashEventResult | undefined> => {
		const call = {
			type: "tool_call",
			toolCallId: "user-bash",
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
		const hook = verdict?.ask;
		const destructive = catastrophicCommand(event.command, ctx.cwd) !== undefined;
		if (!destructive && !hook && !permission.hasSourcePolicy) {
			permission.typed(event.command, ctx.cwd);
			return undefined;
		}
		const checked = await permission.check(ctx, {
			invocation: captureToolInvocation(call.toolCallId, call.toolName, call.input),
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
