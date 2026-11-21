import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { DESKTOP_ALLOW_APPS_ENV, DESKTOP_APPS_ENV } from "@octocodeai/octocode-common/env";

const run = promisify(execFile);

/**
 * Apps a desktop call never targets, in any mode: terminals, code editors, password managers and Keychain. Driving one
 * is a shell or a vault by another route, so the start approval cannot stand for it. Names are matched
 * case-insensitively without `.app`; `family` also matches a longer name that begins with it ("IntelliJ IDEA Ultimate",
 * "1Password 7"); `bundles` are bundle-id prefixes. The user lifts it for an app by naming it in `OCTOCODE_DESKTOP_ALLOW_APPS`.
 */
interface DeniedApp {
	name: string;
	kind: "terminal" | "code editor" | "password manager" | "security app";
	family?: true;
	bundles: readonly string[];
}

const DENIED_APPS: readonly DeniedApp[] = [
	{ name: "Terminal", kind: "terminal", bundles: ["com.apple.terminal"] },
	{ name: "iTerm2", kind: "terminal", bundles: ["com.googlecode.iterm2"] },
	{ name: "Ghostty", kind: "terminal", bundles: ["com.mitchellh.ghostty"] },
	{ name: "Warp", kind: "terminal", bundles: ["dev.warp."] },
	{ name: "Alacritty", kind: "terminal", bundles: ["org.alacritty", "io.alacritty"] },
	{ name: "kitty", kind: "terminal", bundles: ["net.kovidgoyal.kitty"] },
	{ name: "WezTerm", kind: "terminal", bundles: ["com.github.wez.wezterm"] },
	{ name: "Hyper", kind: "terminal", bundles: ["co.zeit.hyper"] },
	{ name: "Visual Studio Code", kind: "code editor", bundles: ["com.microsoft.vscode"] },
	{ name: "Code", kind: "code editor", bundles: [] },
	{ name: "Cursor", kind: "code editor", bundles: ["com.todesktop.230313mzl4w4u92", "com.cursor."] },
	{ name: "Xcode", kind: "code editor", family: true, bundles: ["com.apple.dt.xcode"] },
	{ name: "Sublime Text", kind: "code editor", bundles: ["com.sublimetext."] },
	{ name: "Nova", kind: "code editor", bundles: ["com.panic.nova"] },
	{ name: "Zed", kind: "code editor", bundles: ["dev.zed."] },
	...["IntelliJ IDEA", "PyCharm", "WebStorm", "GoLand", "CLion", "Rider"].map((name): DeniedApp => ({
		name,
		kind: "code editor",
		family: true,
		bundles: ["com.jetbrains."],
	})),
	{ name: "1Password", kind: "password manager", family: true, bundles: ["com.1password.", "com.agilebits."] },
	{ name: "Bitwarden", kind: "password manager", bundles: ["com.bitwarden."] },
	{ name: "LastPass", kind: "password manager", bundles: ["com.lastpass.", "com.lastpass"] },
	{ name: "Dashlane", kind: "password manager", bundles: ["com.dashlane."] },
	{ name: "Keychain Access", kind: "security app", bundles: ["com.apple.keychainaccess"] },
	{ name: "Passwords", kind: "security app", bundles: ["com.apple.passwords"] },
];

const normalize = (name: string): string =>
	name
		.trim()
		.replace(/\.app$/i, "")
		.toLowerCase();

/** The apps the user allowed by name in their own environment, normalized. */
const allowedApps = (env: NodeJS.ProcessEnv): string[] =>
	(env[DESKTOP_ALLOW_APPS_ENV] ?? "").split(",").map(normalize).filter(Boolean);

/** The denylist entry a launch `name` or `bundle_id` (or a name resolved from a pid) is, or undefined. */
function deniedApp(identifier: string, env: NodeJS.ProcessEnv = process.env): DeniedApp | undefined {
	const id = normalize(identifier);
	if (id === "") return undefined;
	if (allowedApps(env).includes(id)) return undefined;
	return DENIED_APPS.find((app) => {
		const name = app.name.toLowerCase();
		return (
			id === name || (app.family === true && id.startsWith(`${name} `)) || app.bundles.some((b) => id.startsWith(b))
		);
	});
}

/** The refusal for an app the default denylist covers, naming it, or undefined. `OCTOCODE_DESKTOP_ALLOW_APPS` lifts it for the apps it names. */
export function deniedAppRefusal(identifier: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const app = deniedApp(identifier, env);
	return app
		? `${normalize(identifier) === app.name.toLowerCase() ? app.name : identifier} is a ${app.kind} and is refused in every mode: driving it would reach a shell, code or secrets around the desktop approval.`
		: undefined;
}

/** The apps this task may control (`OCTOCODE_DESKTOP_APPS`, normalized), or undefined when no list is set. */
const taskApps = (env: NodeJS.ProcessEnv): string[] | undefined => {
	const raw = env[DESKTOP_APPS_ENV];
	return raw === undefined ? undefined : raw.split(",").map(normalize).filter(Boolean);
};

/** Whether a name or bundle id (`com.apple.calculator`) is in `apps`: by name, or a bundle id by its last segment. */
const inApps = (identifier: string, apps: readonly string[]): boolean => {
	const id = normalize(identifier);
	return apps.includes(id) || apps.includes(id.slice(id.lastIndexOf(".") + 1));
};

/**
 * The refusal for an app outside the list this task may control (`OCTOCODE_DESKTOP_APPS`), naming the app and the list,
 * or undefined when no list is set or the app is on it. The match ignores case and `.app`; a bundle id matches by its
 * last segment. This never lifts the denylist: `deniedAppRefusal` still applies.
 */
export function outsideAppsRefusal(identifier: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const apps = taskApps(env);
	if (apps === undefined || normalize(identifier) === "" || inApps(identifier, apps)) return undefined;
	return `${identifier} is outside the apps this task may control: ${apps.join(", ")}.`;
}

/** The app a process belongs to: the first `.app` bundle name in its executable path, else the executable's name; undefined when no such process. */
export async function psApp(pid: number): Promise<string | undefined> {
	let stdout: string;
	try {
		({ stdout } = await run("ps", ["-p", String(pid), "-o", "comm="], { timeout: 2000 }));
	} catch (error) {
		const code: unknown = (error as { code?: unknown }).code;
		// No such process (exit 1) or no `ps` at all (Windows): the pid cannot be resolved, so it is not refused.
		if (code === 1 || code === "ENOENT") return undefined;
		throw error;
	}
	const command = stdout.trim();
	if (command === "") return undefined;
	const bundle = command.split("/").find((part) => /\.app$/i.test(part));
	return bundle ?? path.basename(command);
}
