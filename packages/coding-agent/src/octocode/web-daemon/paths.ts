import path from "node:path";
import { envFlag } from "../shared/env.ts";
import { octocodeHome, sessionDirName } from "../shared/home.ts";

/** `1` makes every session accept the user-level web daemon and `/octocode` use it; unset or `0` keeps the per-session server. */
export const WEB_DAEMON_ENV = "OCTOCODE_WEB_DAEMON";
/** Minutes without a browser tab or an attached session after which the daemon exits (decimals allowed; default 10). */
export const WEB_DAEMON_IDLE_ENV = "OCTOCODE_WEB_DAEMON_IDLE_MINUTES";

export function webDaemonEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return envFlag(env, WEB_DAEMON_ENV);
}

export interface WebDaemonPaths {
	/** `<octocode home>/web`, owner-only. */
	dir: string;
	/** The running daemon's record. */
	record: string;
	/** Held briefly by a launcher while it checks for, drains or spawns a daemon. */
	launchLock: string;
	/** Held by the daemon for its whole run: a second daemon cannot start beside it. */
	runLock: string;
	/** One `<sessionId>.json` per session that accepts the daemon. */
	attachDir: string;
}

export function webDaemonPaths(env: NodeJS.ProcessEnv = process.env): WebDaemonPaths {
	const dir = path.join(octocodeHome(env), "web");
	return {
		dir,
		record: path.join(dir, "daemon.json"),
		launchLock: path.join(dir, "daemon.launch"),
		runLock: path.join(dir, "daemon.run"),
		attachDir: path.join(dir, "attach"),
	};
}

export function attachRecordPath(env: NodeJS.ProcessEnv, sessionId: string): string {
	return path.join(webDaemonPaths(env).attachDir, `${sessionDirName(sessionId)}.json`);
}
