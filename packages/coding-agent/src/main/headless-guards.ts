import { envFlag, MCP_DESKTOP_ENV, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { setAuthGuidanceSurface } from "../core/auth-guidance.ts";
import { installHeadlessCrashHandlers } from "../modes/headless-crash.ts";
import type { AppMode } from "./startup.ts";

/**
 * Desktop control asks the user before every start. A print or JSON run has nobody to ask, so it has no desktop server
 * and no desktop specialist, and the subagents it starts inherit that (RPC and ACP runs have a person or a client that
 * answers, and keep both).
 */
export function withoutDesktopWhenNobodyCanAnswer(mode: AppMode): void {
	if (mode === "print" || mode === "json") process.env[MCP_DESKTOP_ENV] = "0";
}

/**
 * A headless run's sign-in errors reach a shell or a client program, where /providers cannot be typed, so they say how
 * to reach it; a subagent's reach its coordinator's terminal, where it can.
 */
export function guideSignInFromShell(mode: AppMode): void {
	if (mode !== "interactive" && !envFlag(process.env, SUBAGENT_ENV)) setAuthGuidanceSurface("cli");
}

/** The headless crash handlers, installed on the first call only, however many mode checks ask. */
export function onceInstalledCrashHandlers(): { install: () => void } {
	let installed = false;
	return {
		install: () => {
			if (installed) return;
			installed = true;
			installHeadlessCrashHandlers();
		},
	};
}
