/**
 * Where a page can be opened from this process, decided from the environment alone. A browser on the machine that runs
 * Octocode is only useful when a person sits at it: over SSH or with no display the address is printed instead, and
 * VS Code or Cursor then make it a link that their own port forwarding resolves.
 */
type OpenHost = "vscode" | "cursor" | "iterm" | "apple-terminal" | "tmux" | "ssh" | "headless" | "terminal";

export interface OpenPlan {
	host: OpenHost;
	action: "open" | "print";
	/** Why the address is printed instead of opened. */
	reason?: string;
}

const TERM_PROGRAMS: Record<string, OpenHost> = {
	vscode: "vscode",
	cursor: "cursor",
	"iTerm.app": "iterm",
	Apple_Terminal: "apple-terminal",
};

function termHost(env: NodeJS.ProcessEnv): OpenHost {
	const known = env.TERM_PROGRAM ? TERM_PROGRAMS[env.TERM_PROGRAM] : undefined;
	if (known) return known;
	return env.TMUX ? "tmux" : "terminal";
}

export function planOpen(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): OpenPlan {
	const host = termHost(env);
	if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) {
		return {
			host: host === "vscode" || host === "cursor" ? host : "ssh",
			action: "print",
			reason: "This session runs over SSH, so a browser here would open on the remote machine.",
		};
	}
	if (platform !== "darwin" && platform !== "win32" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
		return { host: "headless", action: "print", reason: "No display is available for a browser." };
	}
	return { host, action: "open" };
}

/**
 * Opens `url` with `open` (the platform's browser launcher) when the host can show it, else returns the notice that
 * gives the address. A notice from `open` itself (a fallback to the default browser) is passed on.
 */
export async function openOnHost(
	url: string,
	open: (url: string) => Promise<string | void>,
	plan: OpenPlan = planOpen(),
): Promise<string | undefined> {
	if (plan.action === "print") return `${plan.reason} Open this link: ${url}`;
	return (await open(url)) || undefined;
}
