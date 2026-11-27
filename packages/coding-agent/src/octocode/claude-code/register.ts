import type { FeatureSetup } from "../../core/features/index.ts";
import { attachBackend } from "../cli-models/attach.ts";
import { forgetRunner, type RunnerState } from "../external/runner-status.ts";
import { claudeCodeLaunch } from "./launch.ts";
import { CLAUDE_CODE_RUNNER } from "./models.ts";
import { createClaudeCodeBackend } from "./provider.ts";

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
