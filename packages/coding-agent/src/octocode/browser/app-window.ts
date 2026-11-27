import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { OPEN_BROWSER_ENV } from "@octocodeai/octocode-common/env";
import { openTarget } from "@octocodeai/octocode-common/open-target";
import { processAlive } from "../shared/process.ts";

/** Prefix of every temporary browser profile; the stale cleanup removes only directories that carry it. */
export const APP_PROFILE_PREFIX = "octocode-app-";
/** Names the browser's pid inside its profile, so a later launch can tell a live profile from a crash's leftover. */
const OWNER_FILE = "owner.pid";
/** A profile still without an owner file this young is being launched by another process. */
const LAUNCH_GRACE_MS = 60_000;
/** How long a closing browser gets after SIGTERM before SIGKILL. */
const CLOSE_GRACE_MS = 2_000;

/** `0`: no window starts and `open` gives the page's address instead (`common/src/env.ts`). */
export { OPEN_BROWSER_ENV };

/** `app` opens an isolated Chromium app window; `browser` uses the system default browser. */
export type WebWindowMode = "app" | "browser";

const MAC_APPS = ["Google Chrome", "Chromium", "Microsoft Edge", "Brave Browser"];
const LINUX_COMMANDS = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];
/** Relative to a Program Files or LocalAppData root. */
const WINDOWS_EXECUTABLES = [
	"Google\\Chrome\\Application\\chrome.exe",
	"Microsoft\\Edge\\Application\\msedge.exe",
	"BraveSoftware\\Brave-Browser\\Application\\brave.exe",
];

interface DiscoveryOptions {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	/** Root of the user's applications (`~/Applications` on macOS); the OS home by default. */
	home?: string;
	/** Root of the system applications (`/Applications` on macOS). */
	applicationsDir?: string;
}

function isExecutable(file: string, platform: NodeJS.Platform): boolean {
	try {
		accessSync(file, platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		// Not there, or not runnable: the next candidate decides.
		return false;
	}
}

/** Every place a Chromium browser executable may be on `platform`, most preferred first. */
function candidates(options: DiscoveryOptions): string[] {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	if (platform === "darwin") {
		const roots = [options.applicationsDir ?? "/Applications", join(options.home ?? homedir(), "Applications")];
		return roots.flatMap((root) => MAC_APPS.map((app) => join(root, `${app}.app`, "Contents", "MacOS", app)));
	}
	if (platform === "win32") {
		const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(
			(root): root is string => !!root,
		);
		return roots.flatMap((root) => WINDOWS_EXECUTABLES.map((exe) => `${root}\\${exe}`));
	}
	const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
	return LINUX_COMMANDS.flatMap((command) => dirs.map((dir) => join(dir, command)));
}

/** The first installed Chromium browser executable, or undefined when there is none. */
export function findChromium(options: DiscoveryOptions = {}): string | undefined {
	const platform = options.platform ?? process.platform;
	return candidates(options).find((file) => isExecutable(file, platform));
}

/**
 * The arguments of an isolated app window on `url`. Not `--kiosk` (no way out) and not `--incognito` (Chrome denies
 * notifications there, which the page needs). The profile is empty and temporary, with extensions, sync and the
 * first-run and default-browser prompts off; autoplay is allowed because the page plays an optional chime.
 */
export function appWindowArgs(url: string, profile: string, platform: NodeJS.Platform = process.platform): string[] {
	return [
		`--app=${url}`,
		`--user-data-dir=${profile}`,
		"--disable-extensions",
		"--disable-sync",
		"--disable-default-apps",
		"--no-first-run",
		"--no-default-browser-check",
		"--autoplay-policy=no-user-gesture-required",
		// A fresh profile has no keyring entry; without these the OS asks for the login keychain or wallet.
		...(platform === "darwin" ? ["--use-mock-keychain"] : []),
		...(platform === "linux" ? ["--password-store=basic"] : []),
	];
}

interface AppWindowOptions extends DiscoveryOptions {
	/** Replaceable so a test never starts a real browser; with it or `openDefault` given, `OPEN_BROWSER_ENV` is not read. */
	spawn?: typeof spawn;
	/** Parent of the temporary profiles; the OS temp directory by default. */
	tmpDir?: string;
	/** Reads the window mode when a page opens, so a settings change applies to the next `/web`. */
	mode?: () => WebWindowMode;
	/** The fallback opener; the system default application by default. */
	openDefault?: (url: string) => Promise<void>;
	/** Whether a process exists; tests replace it. */
	isAlive?: (pid: number) => boolean;
	/** Receives a failure that has no caller to throw to (a profile that could not be removed after the window closed). */
	onError?: (message: string) => void;
	closeGraceMs?: number;
	now?: () => number;
}

interface Running {
	child: ChildProcess;
	profile: string;
	exited: Promise<void>;
	/** Settles once the browser is gone and its profile is removed. */
	cleaned: Promise<void>;
}

export interface AppWindow {
	/**
	 * Opens `url`. Resolves to a notice when the page opened in the default browser instead (no Chromium browser, or
	 * the setting asks for it), and to undefined when an app window opened.
	 */
	open(url: string): Promise<string | undefined>;
	/** Closes every window this opener started and removes their profiles. */
	close(): Promise<void>;
}

/**
 * Opens pages in an installed Chromium browser as an app window with a fresh temporary profile, apart from the user's
 * own browser profile. The window owner decides when it closes: a per-session server calls `close` with the session,
 * while the daemon's page outlives its session, so its opener never closes and relies on the profile's removal when the
 * browser exits (or, if this process ended first, on the stale cleanup at the next launch).
 */
export function createAppWindow(options: AppWindowOptions = {}): AppWindow {
	const platform = options.platform ?? process.platform;
	const parent = options.tmpDir ?? tmpdir();
	const launch = options.spawn ?? spawn;
	const isAlive = options.isAlive ?? processAlive;
	const report = options.onError ?? ((message: string) => process.stderr.write(`${message}\n`));
	const now = options.now ?? Date.now;
	const running = new Set<Running>();
	// The off switch guards the real launchers only: a caller that hands in its own (a test of this module) decides.
	const ownLaunchers = options.spawn === undefined && options.openDefault === undefined;

	const removeProfile = async (profile: string) => {
		try {
			await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		} catch (error) {
			report(`Could not remove the temporary browser profile ${profile}: ${errorMessage(error)}`);
		}
	};

	/** Removes the profiles of browsers that are gone, which a crash or a closed terminal leaves behind. */
	const removeStale = async () => {
		const names = (await readdir(parent)).filter((name) => name.startsWith(APP_PROFILE_PREFIX));
		for (const name of names) {
			const profile = join(parent, name);
			if (await profileInUse(profile)) continue;
			await removeProfile(profile);
		}
	};

	const profileInUse = async (profile: string): Promise<boolean> => {
		let text: string;
		try {
			text = await readFile(join(profile, OWNER_FILE), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			// Created but not yet owned: another launch may be between mkdtemp and spawn.
			try {
				return now() - (await stat(profile)).mtimeMs < LAUNCH_GRACE_MS;
			} catch (statError) {
				// Another process removed it meanwhile: nothing left to clean.
				if ((statError as NodeJS.ErrnoException).code === "ENOENT") return true;
				throw statError;
			}
		}
		return isAlive(Number.parseInt(text, 10));
	};

	const start = async (executable: string, url: string): Promise<Running> => {
		const profile = await mkdtemp(join(parent, APP_PROFILE_PREFIX));
		try {
			const child = launch(executable, appWindowArgs(url, profile, platform), {
				detached: true,
				stdio: "ignore",
				windowsHide: true,
			});
			await new Promise<void>((resolve, reject) => {
				child.once("error", reject);
				child.once("spawn", resolve);
			});
			const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
			const entry: Running = {
				child,
				profile,
				exited,
				cleaned: exited.then(async () => {
					running.delete(entry);
					await removeProfile(profile);
				}),
			};
			child.on("error", (error) => report(`The browser window failed: ${errorMessage(error)}`));
			running.add(entry);
			child.unref();
			if (child.pid !== undefined) await writeFile(join(profile, OWNER_FILE), String(child.pid), { mode: 0o600 });
			return entry;
		} catch (error) {
			await removeProfile(profile);
			throw error;
		}
	};

	const stop = async (entry: Running) => {
		const grace = options.closeGraceMs ?? CLOSE_GRACE_MS;
		entry.child.kill("SIGTERM");
		let timer: NodeJS.Timeout | undefined;
		const timedOut = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(true), grace);
		});
		const forced = await Promise.race([entry.exited.then(() => false), timedOut]);
		clearTimeout(timer);
		if (forced) {
			entry.child.kill("SIGKILL");
		}
		await entry.cleaned;
	};

	return {
		async open(url) {
			// Read at each open, like the mode: the environment decides for every window this opener would start.
			if (ownLaunchers && process.env[OPEN_BROWSER_ENV] === "0")
				return `Opening a browser is turned off (${OPEN_BROWSER_ENV}=0). Open this link: ${url}`;
			const openDefault = options.openDefault ?? openTarget;
			if ((options.mode?.() ?? "app") === "browser") {
				await openDefault(url);
				return undefined;
			}
			const executable = findChromium(options);
			if (!executable) {
				await openDefault(url);
				return "No Chromium browser (Chrome, Edge, Chromium or Brave) was found, so the page opened in your default browser.";
			}
			await removeStale().catch((error: unknown) =>
				report(`Could not clean old temporary browser profiles: ${errorMessage(error)}`),
			);
			try {
				await start(executable, url);
				return undefined;
			} catch (error) {
				await openDefault(url);
				return `The app window could not start (${errorMessage(error)}), so the page opened in your default browser.`;
			}
		},
		async close() {
			await Promise.all([...running].map(async (entry) => stop(entry)));
		},
	};
}
