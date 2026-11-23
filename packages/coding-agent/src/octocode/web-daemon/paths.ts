import path from "node:path";
import { sessionDirName } from "../shared/home.ts";
import { getOctocodeHome } from "../../config.ts";

/** Minutes without a browser tab or an attached session after which the daemon exits (decimals allowed; default 10). */
const WEB_DAEMON_IDLE_ENV = "OCTOCODE_WEB_DAEMON_IDLE_MINUTES";
const DEFAULT_IDLE_MINUTES = 10;

/** The daemon's idle limit in minutes from `OCTOCODE_WEB_DAEMON_IDLE_MINUTES`; a value that is not a positive number gives 10. */
export function webDaemonIdleMinutes(env: NodeJS.ProcessEnv): number {
	const minutes = Number.parseFloat(env[WEB_DAEMON_IDLE_ENV] ?? "");
	return Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_IDLE_MINUTES;
}

export interface WebDaemonPaths {
	/** `<octocode home>/web`, owner-only. */
	dir: string;
	record: string;
	/** Held briefly by a launcher while it checks for, drains or spawns a daemon. */
	launchLock: string;
	/** Held by the daemon for its whole run: a second daemon cannot start beside it. */
	runLock: string;
	/** One `<sessionId>.json` per session that accepts the daemon. */
	attachDir: string;
}

export function webDaemonPaths(env: NodeJS.ProcessEnv = process.env): WebDaemonPaths {
	const dir = path.join(getOctocodeHome(env), "web");
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
