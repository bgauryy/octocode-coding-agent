import { createRouteBackend, type RouteBackend } from "../cli-models/backend.ts";
import { claudeCodeRoute, type ClaudeCodeLaunch } from "./launch.ts";

/**
 * The `claude-code` provider: Claude Code, signed in with its own login, runs each turn of Octocode's agent loop and
 * calls Octocode's tools over MCP (`cli-models/backend.ts`).
 */
export function createClaudeCodeBackend(
	launch: ClaudeCodeLaunch,
	signedOut?: () => void | Promise<void>,
): RouteBackend {
	return createRouteBackend(claudeCodeRoute(launch, signedOut));
}
