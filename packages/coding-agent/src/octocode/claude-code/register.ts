import { type FeatureSetup, readsMessagesOnly } from "../../core/features/index.ts";
import { forgetRunner, type RunnerState } from "../external/runner-status.ts";
import { claudeCodeLaunch } from "./launch.ts";
import { CLAUDE_CODE_PROVIDER, CLAUDE_CODE_RUNNER } from "./models.ts";
import { type ClaudeCodeBackend, createClaudeCodeBackend } from "./provider.ts";

/**
 * The `claude-code` models, offered when the Claude Code runner is connected on its plan (`states`: the session's
 * connected runners, read once without starting anything).
 */
export function registerClaudeCode(api: FeatureSetup, states: readonly RunnerState[]): void {
	const launch = claudeCodeLaunch(states);
	if (launch)
		attachBackend(
			api,
			createClaudeCodeBackend(launch, () => forgetRunner(CLAUDE_CODE_RUNNER)),
		);
}

/**
 * Registers the provider and ties it to the session: each Octocode session reuses one Claude Code session, closed when
 * the session ends or another starts, and only the agent loop's own requests are its turns.
 */
export function attachBackend(api: FeatureSetup, backend: ClaudeCodeBackend): void {
	api.providers.register(backend.provider);
	api.bus.on("session_start", async (_event, ctx) => backend.bind(ctx.sessionManager.getSessionId(), ctx.cwd));
	api.bus.on(
		"context",
		readsMessagesOnly(async (_event, ctx) => {
			if (ctx.model?.provider === CLAUDE_CODE_PROVIDER) backend.markTurn();
		}),
	);
	api.bus.on("session_shutdown", async () => backend.close());
}
