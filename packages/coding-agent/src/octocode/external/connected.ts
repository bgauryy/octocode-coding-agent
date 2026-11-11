import type { ExtensionContext } from "../../core/features/index.ts";
import type { AcpPermission } from "../../../../acp/src/client/client.ts";
import { GLYPH } from "@octocodeai/octocode-tui/text";
import { cachedRunners, isConnected, type RunnerState } from "./runner-status.ts";
import { type RunnerTurnInput, runnerTurn, runnerTurnDeps } from "./runner-session.ts";

/**
 * The runners a session can start tasks in: with the `externalAgents` setting on, those whose cached check (`/providers`,
 * External agents) found them installed and signed in. Read once, when the `agent` tool is declared, so its schema is
 * fixed for the session; nothing is started to find them.
 */
export function connectedRunners(enabled: boolean, permission: (ctx: ExtensionContext) => AcpPermission) {
	const states = enabled ? cachedRunners().filter(isConnected) : [];
	const deps = runnerTurnDeps(permission);
	return {
		ids: states.map((state) => state.id),
		states,
		turn: (input: RunnerTurnInput) => runnerTurn(input, deps),
	};
}

/** One runner as a `models` row: who it is, its version and how it is signed in and billed. */
const runnerRow = (state: RunnerState): string =>
	`  ${GLYPH.live} ${state.id} · ${[
		`${state.name}${state.version ? ` ${state.version}` : ""}`,
		state.auth?.method,
		state.auth?.billing === "metered" ? "metered key" : "plan",
	]
		.filter(Boolean)
		.join(" · ")}`;

/** The `models` block for the session's connected runners; empty without one. */
export function runnerRows(states: readonly RunnerState[]): string[] {
	if (states.length === 0) return [];
	return [
		[
			"Connected runners: pass `runner` on a task to run it in that vendor's own CLI and sign-in",
			...states.map(runnerRow),
		].join("\n"),
	];
}
