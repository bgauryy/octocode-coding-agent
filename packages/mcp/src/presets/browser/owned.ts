import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { PARENT_PID_ENV } from "../../../../common/src/env.ts";

/**
 * A headless Chrome outlives the browser subagent that opened it, so that a follow-up can reuse it, and a subagent that
 * failed, was stopped or simply did not call `cleanup` leaves it running. Nothing else ends it: the package starts Chrome
 * detached and keeps it "until cleanup". So the record of each Chrome Octocode started names the session it belongs to,
 * the top session of the process tree (a subagent's parent, else this process), and that session stops the ones it still
 * owns when it shuts down. A visible Chrome stays: it is a window the user may be using. A session killed outright runs
 * no shutdown; `/processes` lists what it left.
 */

/** Where the package keeps the isolated profile and session of the Chrome on a port, under the workspace. */
export const browserStateDir = (cwd: string): string =>
	join(cwd, ".octocode", "octocode-chrome-devtools", "tmp", "browser-state");

const RECORD = /^octocode-proxy-(\d+)\.json$/;
const proxyRecord = (cwd: string, port: string): string => join(browserStateDir(cwd), `octocode-proxy-${port}.json`);

const readJson = (file: string): Record<string, unknown> | undefined => {
	try {
		const value: unknown = JSON.parse(readFileSync(file, "utf8"));
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
};

/** The session a browser opened in this process belongs to: `PARENT_PID_ENV` holds the parent's pid, then its start time. */
function browserOwner(env: NodeJS.ProcessEnv = process.env): number {
	const parent = Number.parseInt(env[PARENT_PID_ENV]?.trim().split(" ")[0] ?? "", 10);
	return Number.isInteger(parent) && parent > 0 ? parent : process.pid;
}

/** The proxy port Octocode gave the Chrome on CDP `port`, recorded when it started that Chrome. */
export function recordedProxyPort(cwd: string, port: string): number | undefined {
	const value = readJson(proxyRecord(cwd, port))?.proxyPort;
	return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536 ? value : undefined;
}

/** Records the Chrome's proxy port and that this process's session owns it; a session that reuses a Chrome takes it over. */
export function recordBrowser(cwd: string, port: string, proxyPort: number): void {
	mkdirSync(browserStateDir(cwd), { recursive: true });
	writeFileSync(proxyRecord(cwd, port), JSON.stringify({ proxyPort, owner: browserOwner() }), { mode: 0o600 });
}

const running = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** Whether `pid` is still the Chrome on this CDP port, not a process that took over its number; unknown counts as no. */
function isChromeOn(pid: number, port: string): boolean {
	try {
		const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
		return command.includes(`--remote-debugging-port=${port}`);
	} catch {
		return false;
	}
}

async function stopChrome(pid: number): Promise<void> {
	process.kill(pid, "SIGTERM");
	for (let waited = 0; waited < 3000 && running(pid); waited += 50)
		await new Promise((resolve) => setTimeout(resolve, 50));
	if (running(pid)) process.kill(pid, "SIGKILL");
}

/** Stops the headless Chromes this session owns under `cwd` and removes their state, as `cleanup` would. Never throws. */
export async function stopOwnedBrowsers(cwd: string): Promise<void> {
	let files: string[];
	try {
		files = readdirSync(browserStateDir(cwd));
	} catch {
		return;
	}
	for (const file of files) {
		const port = RECORD.exec(file)?.[1];
		if (!port || readJson(join(browserStateDir(cwd), file))?.owner !== process.pid) continue;
		const sessionFile = join(browserStateDir(cwd), `cdp-session-${port}.json`);
		const session = readJson(sessionFile);
		if (session?.headless !== true || session.isolated !== true || typeof session.pid !== "number") continue;
		try {
			if (isChromeOn(session.pid, port)) await stopChrome(session.pid);
			if (typeof session.profileDir === "string") rmSync(session.profileDir, { recursive: true, force: true });
			rmSync(sessionFile, { force: true });
			rmSync(join(browserStateDir(cwd), file), { force: true });
		} catch {
			// Shutdown goes on: the Chrome stays listed in `/processes`, and `cleanup` still reaches it.
		}
	}
}
