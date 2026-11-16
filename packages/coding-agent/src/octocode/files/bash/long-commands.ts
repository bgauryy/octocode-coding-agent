/**
 * Commands that are known to run for a long time, and the waits that should be a background job. Both read the command
 * text only, so a wrapper or a script the shell runs by another name is not recognised (it keeps the default threshold).
 */

/** The `bash.longCommand*` and `bash.deliberateMaxSeconds` settings; each field falls back to its default. */
export interface LongCommandSettings {
	/** Seconds a known long command may run in the foreground before it moves to the background. */
	afterSeconds?: number;
	/** The longest a foreground wait with its own timeout holds the turn. */
	deliberateMaxSeconds?: number;
	/** Regular expressions for more long commands, matched where a command starts. */
	patterns?: readonly string[];
}

/** Where a command starts: the line, or after `;`, `&`, `|`, `(` and any `VAR=value` words. */
const START = String.raw`(?:^|[;&|(\n]\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*`;
const RUNNER = String.raw`(?:yarn|npm|pnpm|bun)(?:\s+(?:workspace|workspaces|-w|--workspace)\s+\S+)?(?:\s+--?\S+)*`;

const LONG_COMMANDS = [
	// Test runners.
	String.raw`(?:npx\s+|yarn\s+|pnpm\s+(?:exec\s+)?)?(?:vitest|jest|pytest|py\.test)\b`,
	String.raw`node\s+(?:\S+\s+)*--test\b`,
	String.raw`(?:\S*/)?test\.sh\b`,
	String.raw`${RUNNER}\s+(?:run\s+)?test\S*`,
	String.raw`python3?\s+-m\s+pytest\b`,
	String.raw`cargo\s+(?:\S+\s+)?(?:test|build|nextest)\b`,
	String.raw`go\s+(?:test|build)\b`,
	// The repository check and builds.
	String.raw`${RUNNER}\s+(?:run\s+)?(?:check|build)\S*`,
	String.raw`(?:npx\s+)?tsc\s+(?:\S+\s+)*(?:-b|--build)\b`,
	// Servers.
	String.raw`${RUNNER}\s+(?:run\s+)?(?:dev|serve|start)\S*`,
];

const END = String.raw`(?=\s|$|;|&|\|)`;
const compile = (patterns: readonly string[]) => new RegExp(`${START}(?:${patterns.join("|")})${END}`);
const LONG_COMMAND = compile(LONG_COMMANDS);

/** Compiled user patterns by their source list; entries that are not regular expressions are dropped. */
const customCache = new Map<string, RegExp | undefined>();
function customPattern(patterns: readonly string[]): RegExp | undefined {
	const key = JSON.stringify(patterns);
	if (customCache.has(key)) return customCache.get(key);
	const valid = patterns.filter((pattern) => {
		try {
			new RegExp(pattern);
			return true;
		} catch {
			return false;
		}
	});
	const compiled = valid.length ? compile(valid) : undefined;
	if (customCache.size >= 16) customCache.clear();
	customCache.set(key, compiled);
	return compiled;
}

/**
 * Commands that follow a stream and never exit by themselves: `tail -f`/`-F`/`--follow`, `journalctl -f`, `kubectl logs -f`,
 * `docker logs -f`, `watch`. A pipe after one (`tail -f log | grep -m1 x`) does not end it either: tail notices the closed
 * pipe only when it writes again, which may be never.
 */
/** Arguments before the flag, within one part of the line. */
const ARGS = String.raw`(?:[^\s;&|]+\s+)*?`;
const FOLLOW = new RegExp(
	`${START}(?:${[
		String.raw`tail\s+${ARGS}(?:-[A-Za-z0-9+]*[fF][A-Za-z0-9]*|--follow\S*)`,
		String.raw`journalctl\s+${ARGS}(?:-[A-Za-z]*f[A-Za-z]*|--follow)`,
		String.raw`(?:kubectl|docker|podman)\s+${ARGS}logs\s+${ARGS}(?:-f|--follow)`,
		"watch",
	].join("|")})(?=\\s|$|;|&|\\|)`,
);

/** Whether `command` follows a stream and never exits by itself (see {@link FOLLOW}). */
export const neverExits = (command: string): boolean => FOLLOW.test(command);

/** Whether `command` runs a test runner, the repository check, a build, a server or a stream follower, or a command matching the configured `patterns` (checked at the start of each part of the line). */
export const isKnownLongCommand = (command: string, patterns: readonly string[] = []): boolean =>
	LONG_COMMAND.test(command) ||
	neverExits(command) ||
	(patterns.length > 0 && customPattern(patterns)?.test(command) === true);

const SLEEP_SECONDS = /(?:^|[;&|(\n]\s*)sleep\s+(\d+(?:\.\d+)?)([smhd]?)(?=\s|$|;|&|\|)/g;
const POLL_LOOP = /(?:^|[;&|(\n]\s*)(?:while|until|for)\b[\s\S]*\bsleep\s+\d/;
const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 } as const;
/** A plain sleep shorter than this is a pause, not a wait for something else. */
const LONG_SLEEP_SECONDS = 20;

/**
 * Appended to the result of a foreground command that is a long `sleep` or a sleep-poll loop: the wait should be a
 * background job whose completion arrives as a message, or, for state outside the session, a timer. The command still
 * runs. `wait` says the session declares the `wait` tool, so the hint names only what the model can call.
 */
const sleepHintText = (timer: boolean): string =>
	`Hint: waiting by sleeping in the foreground holds the turn. Start the long command with \`background: true\` and wait for its completion message${
		timer ? ", or set a `wait` to be woken when outside state holds," : ""
	} instead of sleeping or polling.`;

/** The hint when `command` sleeps 20 s or more, or polls in a loop with `sleep`; undefined otherwise. */
export function sleepHint(command: string, timer = false): string | undefined {
	if (POLL_LOOP.test(command)) return sleepHintText(timer);
	for (const match of command.matchAll(SLEEP_SECONDS)) {
		const unit = (match[2] || "s") as keyof typeof UNIT_SECONDS;
		if (Number(match[1]) * UNIT_SECONDS[unit] >= LONG_SLEEP_SECONDS) return sleepHintText(timer);
	}
	return undefined;
}
