import { animationClock, LIGHT_GLYPH, MOTION } from "@octocodeai/octocode-tui";
import type { UiState } from "../../../theme/status.ts";
import type { ThemeColor } from "../../../theme/theme-tokens.ts";

/** What an agent's light tells at a glance. */
type AgentLight = "done" | "running" | "failed" | "waiting";

/**
 * Every state an agent row can be in, as one of the four lights: green is done (`done`, `partial`), red is a failure
 * (`failed`, `stopped`), a pulse is work in progress (`working`), and steady yellow is everything that is not moving
 * (`needs you`, `asks parent`, `blocked`, `idle`, `left` without a reported outcome).
 */
const LIGHT_OF: Readonly<Record<UiState, AgentLight>> = {
	done: "done",
	failed: "failed",
	stopped: "failed",
	running: "running",
	waiting: "waiting",
	pending: "waiting",
};

const STEADY: Readonly<Record<Exclude<AgentLight, "running">, ThemeColor>> = {
	done: "success",
	failed: "error",
	waiting: "warning",
};

/** The two colours a working agent's light alternates between. */
const PULSE: readonly [ThemeColor, ThemeColor] = ["warning", "muted"];

/**
 * The colour of `state`'s light at `now`. A working agent alternates once per `MOTION.tickMs`, the cadence its panel
 * repaints at; in reduced motion it holds the first colour, and its glyph still sets it apart from a waiting one.
 */
function agentLightColor(state: UiState, now: number): ThemeColor {
	const light = LIGHT_OF[state];
	if (light !== "running") return STEADY[light];
	return animationClock.isReducedMotion() ? PULSE[0] : PULSE[Math.floor(now / MOTION.tickMs) % 2];
}

/** The light as drawn: the state's own circle in its light colour. */
export function paintAgentLight(
	theme: { fg(color: ThemeColor, text: string): string },
	state: UiState,
	now: number,
): string {
	return theme.fg(agentLightColor(state, now), LIGHT_GLYPH[state]);
}
