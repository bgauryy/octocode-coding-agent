import { AcpBackend, type AcpConnectInput, type AcpPermission } from "../../../../acp/src/client/client.ts";
import { findOnPath } from "../../../../common/src/find-on-path.ts";
import { acpClientHost } from "../external/acp-host.ts";
import { agentEnv } from "../external/runner-env.ts";
import { claudeIsolationOptions } from "../external/runner-isolation.ts";
import { isConnected, type RunnerState } from "../external/runner-status.ts";
import { adapterArgs, runnerSpec } from "../external/runners.ts";
import { CLAUDE_CODE_RUNNER, TOOL_SERVER } from "./models.ts";

/** How Claude Code's ACP adapter starts: the adapter, its arguments, and the user's own `claude` it runs. */
export interface ClaudeCodeLaunch {
	command: string;
	args: string[];
	/** The user's installed `claude`; the adapter runs it in place of the binary it bundles. */
	cli: string;
}

/**
 * The launch when Claude Code is connected with plan billing (installed with its adapter, signed in at its last check);
 * undefined otherwise, read from the cached check without starting anything. A metered login has the direct Anthropic
 * provider for that.
 */
export function claudeCodeLaunch(states: readonly RunnerState[], env = process.env): ClaudeCodeLaunch | undefined {
	const spec = runnerSpec(CLAUDE_CODE_RUNNER);
	const state = states.find((entry) => entry.id === CLAUDE_CODE_RUNNER);
	// The adapter carries the turns: a CLI connected only for headless runner tasks does not offer the models.
	if (!spec || !state || !isConnected(state) || !state.adapter || state.auth?.billing !== "plan") return undefined;
	const command = findOnPath(spec.adapter.command, env);
	const cli = findOnPath(spec.cli, env);
	return command && cli ? { command, args: adapterArgs(spec, "plan"), cli } : undefined;
}

/**
 * The adapter's environment: the cleaned one every external agent gets (no provider key or token), plus the user's own
 * `claude`, the chosen model alias, and every MCP tool declared up front (Octocode's tools are the only tools).
 */
export function adapterEnv(launch: ClaudeCodeLaunch, model: string, env = process.env): NodeJS.ProcessEnv {
	return {
		...agentEnv(CLAUDE_CODE_RUNNER, env),
		CLAUDE_CODE_EXECUTABLE: launch.cli,
		ANTHROPIC_MODEL: model,
		ENABLE_TOOL_SEARCH: "false",
	};
}

/**
 * The session options Claude Code starts with: none of its own tools, Octocode's allowed without its own prompt (the
 * permission gate decides inside each call), no settings, hooks or MCP servers from its configuration files, and
 * Octocode's short instruction appended to its own system prompt.
 */
export const sessionMeta = (append: string): Record<string, unknown> => ({
	systemPrompt: { append },
	claudeCode: {
		options: {
			tools: [],
			allowedTools: [`mcp__${TOOL_SERVER}`],
			...claudeIsolationOptions(),
		},
	},
});

type PermissionRequest = Parameters<AcpPermission>[0];

/** The tool an ACP permission request is about, by Claude Code's name for it. */
function toolOf(request: PermissionRequest): string {
	const meta = request.toolCall._meta as { claudeCode?: { toolName?: unknown } } | undefined;
	const name = meta?.claudeCode?.toolName;
	return typeof name === "string" ? name : (request.toolCall.title ?? "");
}

/**
 * Claude Code's own permission requests. It should send none (its tools are off and Octocode's are allowed); one for an
 * Octocode tool is allowed, since Octocode's gate decides inside the call, and any other is refused.
 */
export const claudeCodePermission: AcpPermission = async (request) => {
	const ours = toolOf(request).startsWith(`mcp__${TOOL_SERVER}__`);
	const option = request.options.find((entry) => entry.kind === (ours ? "allow_once" : "reject_once"));
	return option
		? { outcome: { outcome: "selected", optionId: option.optionId } }
		: { outcome: { outcome: "cancelled" } };
};

/** Connects to the adapter with `env` as its whole environment; tests pass a scripted peer's command. */
export function connectClaudeCode(
	input: AcpConnectInput,
	env: NodeJS.ProcessEnv,
	signal?: AbortSignal,
): Promise<AcpBackend> {
	return AcpBackend.connect({ ...acpClientHost, childEnv: () => env }, input, claudeCodePermission, signal);
}
