/**
 * Whether this run was started with `--plan`. The CLI records it before the session starts, and planning reads it on
 * the startup `session_start` event; a later session in the same process (resume, new) never starts in plan mode.
 */
let startInPlanMode = false;

export function setPlanStartup(on: boolean): void {
	startInPlanMode = on;
}

export function planStartupRequested(): boolean {
	return startInPlanMode;
}
