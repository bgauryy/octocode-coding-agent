import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderPrompt } from "../../../core/prompt-template.ts";
import { getShellEnv } from "../../../utils/shell.ts";
import { octocodeCliAvailable } from "../../cli/shim.ts";
import { ghLoggedIn } from "../../shared/gh-login.ts";

/** The CLI tools the guide (`native/tools/bash/cli.md`) names that a host may lack, probed on the shell's PATH. */
const PROBED = ["git", "rg", "fd", "jq", "ast-grep", "yq", "gh", "python3", "lsof"] as const;

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { darwin: "macOS", linux: "Linux", win32: "Windows" };

const GH_STATUS = { ready: "logged in", "logged-out": "installed, not logged in", absent: "not installed" } as const;

/** What a shell command finds on this machine: the platform, which probed tools are on PATH, and GitHub CLI login. */
export type CliHost = {
	platform: NodeJS.Platform;
	arch: string;
	present: string[];
	missing: string[];
	gh: keyof typeof GH_STATUS;
};

/** Probe the host once from the environment shell commands start with (Octocode's `bin` on PATH): stats only, no process. */
export function probeCliHost(
	env: NodeJS.ProcessEnv = getShellEnv(),
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
	home: string = os.homedir(),
	/** Whether agent shells have the research CLI as `octocode-cli` (`cli/shim.ts`): it is listed on PATH like any other program. */
	octocodeCli: boolean = octocodeCliAvailable(),
): CliHost {
	const windows = platform === "win32";
	const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
	const dirs = pathValue.split(windows ? ";" : ":").filter(Boolean);
	const exts = windows ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)] : [""];
	const found = (name: string) =>
		dirs.some((dir) => exts.some((ext) => isExecutable(path.join(dir, name + ext.toLowerCase()), windows)));
	// `octocode-cli` counts only as the research CLI the shim installs; `octocode` in agent shells is the agent itself.
	const present: string[] = [...PROBED.filter(found), ...(octocodeCli ? ["octocode-cli"] : [])];
	const missing = PROBED.filter((name) => !present.includes(name));
	const gh = !present.includes("gh") ? "absent" : ghLoggedIn(env, windows, home) ? "ready" : "logged-out";
	return { platform, arch, present, missing, gh };
}

/** The bash tool's CLI guide for a host: the probed facts, the platform's quirks, then the habits every host shares. */
export function renderCliGuide(host: CliHost): string {
	const known = host.platform === "darwin" || host.platform === "linux" || host.platform === "win32";
	return renderPrompt("tools/bash/cli.md", {
		os: OS_NAMES[host.platform] ?? host.platform,
		arch: host.arch,
		present: host.present.join(", ") || "none of the probed tools",
		missing: host.missing.join(", "),
		gh: GH_STATUS[host.gh],
		darwin: host.platform === "darwin",
		linux: host.platform === "linux",
		windows: host.platform === "win32",
		otherOs: !known,
	});
}

function isExecutable(file: string, windows: boolean): boolean {
	try {
		if (!fs.statSync(file).isFile()) return false;
		if (!windows) fs.accessSync(file, fs.constants.X_OK);
		return true;
	} catch {
		// Missing or not executable: the expected answer for most PATH entries, not an error.
		return false;
	}
}
