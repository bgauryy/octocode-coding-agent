import { spawn } from "node:child_process";
import { getResearchCliInvocation } from "../../../../coding-agent/src/config.ts";

/**
 * GitHub sign-in for Octocode research, through the installed native CLI's `octocode auth` commands. The research server
 * runs the same native runtime and reads the same credential store, so a login here reaches it without a restart (it
 * re-reads credentials within a minute).
 */

/** `octocode auth status --json`. `tokenSource` is `env:<VAR>`, `octocode-storage`, `gh-cli` or `none`. */
export interface GithubStatus {
	authenticated: boolean;
	verification: "verified" | "unverified" | "invalid" | "none";
	username: string | null;
	hostname: string;
	tokenSource: string;
}

/** `octocode auth login --json`: `none` when a stored login was still valid and left in place. */
interface GithubLogin {
	success: true;
	action: "login" | "refresh" | "none";
	alreadyAuthenticated?: boolean;
	hostname: string;
	username?: string | null;
}

/** `octocode auth logout --json`. Environment and `gh` credentials are not touched. */
interface GithubLogout {
	loggedOut: true;
	hostname: string;
	home: string;
}

interface GithubAuthResults {
	status: GithubStatus;
	login: GithubLogin;
	logout: GithubLogout;
}

export type GithubAuthAction = keyof GithubAuthResults;

export interface GithubDeviceCode {
	verificationUri: string;
	userCode: string;
}

export interface GithubAuthOptions {
	/** Aborting interrupts the CLI, which cancels a pending device login. */
	signal?: AbortSignal;
	/** Called with the device prompt a login prints before it waits for the browser. */
	onDeviceCode?: (code: GithubDeviceCode) => void;
	invocation?: { command: string; prefix: string[] };
	env?: NodeJS.ProcessEnv;
}

/** The prompt the native device flow writes to stderr. */
const DEVICE_PROMPT = /^Open (\S+) and enter code (\S+)$/;

export function parseDeviceCode(line: string): GithubDeviceCode | undefined {
	const match = DEVICE_PROMPT.exec(line.trim());
	return match ? { verificationUri: match[1], userCode: match[2] } : undefined;
}

/** The last JSON object line of the CLI's stdout. */
function lastJson(stdout: string): Record<string, unknown> | undefined {
	for (const line of stdout.trim().split("\n").reverse()) {
		try {
			const value: unknown = JSON.parse(line);
			if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
		} catch {
			// Not a JSON line.
		}
	}
	return undefined;
}

/** Runs `octocode auth <action> --json`; resolves with its result, rejects with its error message. */
export function runGithubAuth<A extends GithubAuthAction>(
	action: A,
	options: GithubAuthOptions = {},
): Promise<GithubAuthResults[A]> {
	const { signal, onDeviceCode } = options;
	const invocation = options.invocation ?? getResearchCliInvocation("native");
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}
		// Login requires a terminal on stdin but reads nothing from it, so it can share the TUI's terminal.
		const child = spawn(invocation.command, [...invocation.prefix, "auth", action, "--json"], {
			stdio: ["inherit", "pipe", "pipe"],
			env: options.env ?? process.env,
		});
		let stdout = "";
		let stderr = "";
		let partial = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
			const lines = (partial + chunk).split("\n");
			partial = lines.pop() ?? "";
			for (const line of lines) {
				const code = parseDeviceCode(line);
				if (code) onDeviceCode?.(code);
			}
		});
		// The device flow treats SIGINT as cancel; the npm launcher forwards it to the binary.
		const interrupt = () => child.kill("SIGINT");
		signal?.addEventListener("abort", interrupt, { once: true });
		child.once("error", (error) => {
			signal?.removeEventListener("abort", interrupt);
			reject(error);
		});
		child.once("close", () => {
			signal?.removeEventListener("abort", interrupt);
			if (signal?.aborted) {
				reject(new Error("Login cancelled"));
				return;
			}
			// Status exits non-zero when signed out but still prints its result.
			const result = lastJson(stdout);
			if (result && typeof result.error === "string") reject(new Error(result.error));
			else if (result) resolve(result as unknown as GithubAuthResults[A]);
			else reject(new Error(stderr.trim() || `octocode auth ${action} printed no result`));
		});
	});
}

function tokenSourceLabel(source: string): string {
	if (source.startsWith("env:")) return source.slice("env:".length);
	if (source === "octocode-storage") return "Octocode login";
	if (source === "gh-cli") return "gh CLI";
	return source;
}

/** One status line: the account and the token's source, or what to do next. */
export function describeGithubStatus(status: GithubStatus): string {
	const source = tokenSourceLabel(status.tokenSource);
	if (status.verification === "invalid") {
		// An environment token wins over a stored login, so signing in again does not help until it is fixed or unset.
		return status.tokenSource.startsWith("env:")
			? `GitHub: GitHub rejected ${source}. Fix or unset it; it takes priority over /github login.`
			: `GitHub: GitHub rejected the token from ${source}. Run /github login.`;
	}
	if (!status.authenticated) return "GitHub: not signed in. Run /github login, or set GITHUB_TOKEN.";
	if (status.verification === "unverified") {
		return `GitHub: token found on ${status.hostname} (${source}), not verified: GitHub could not be reached`;
	}
	return `GitHub: signed in as ${status.username ?? "an unknown account"} on ${status.hostname} (${source})`;
}
