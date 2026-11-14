import os from "node:os";
import path from "node:path";
import type { ProviderPlan } from "@octocodeai/octocode-ai";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

/** Who pays for a runner's turns: its plan (a subscription it signed in with) or a metered API key. */
export type RunnerBilling = ProviderPlan["billing"];

/** What a runner's own status command says, reduced to the sign-in state and method: never its output. */
export interface RunnerAuth {
	signedIn: boolean;
	/** How it is signed in (`claude.ai`, `ChatGPT`, `api_key`), when it says. */
	method?: string;
	billing?: RunnerBilling;
}

/**
 * A vendor CLI that runs Octocode tasks as an external runner: its own CLI owns the sign-in and the turns, and an ACP
 * adapter connects it to Octocode. Each entry was checked with its CLI's `--help` (2026-11-10); add one only after the
 * same check.
 */
export interface RunnerSpec {
	/** The `runner` value of an `agent` task, and the ACP vendor. */
	id: string;
	name: string;
	/** The vendor's own CLI: its version, status and login. */
	cli: string;
	/** The ACP adapter that runs the turns, and the npm package or formula that installs it. */
	adapter: { command: string; args: readonly string[]; install: string };
	/** The CLI version whose status and login commands were checked; an older one still runs, and its row says so. */
	tested: string;
	/** The CLI's own status command and how to read it; absent: an ACP session check decides. */
	status?: { args: readonly string[]; read(output: string, code: number | null): RunnerAuth | undefined };
	/** The CLI's own login, handed the terminal. */
	login: readonly string[];
	/** The files that hold its sign-in (never folders or general state files): a change makes the cached check stale. */
	signInFiles(env: NodeJS.ProcessEnv, home: string): string[];
	/** Its own configuration variables: they pass to it even when a removal rule would match them. */
	keep: readonly string[];
}

const parseJson = (text: string): unknown => {
	try {
		return JSON.parse(text.slice(text.indexOf("{") >= 0 ? text.indexOf("{") : 0).trim());
	} catch {
		return undefined;
	}
};

/** `claude auth status --json`: `loggedIn` and `authMethod`; a Bedrock, Vertex or API-key login is metered. */
function readClaudeStatus(output: string): RunnerAuth | undefined {
	const status = parseJson(output);
	if (!isRecord(status) || typeof status.loggedIn !== "boolean") return undefined;
	const method = typeof status.authMethod === "string" ? status.authMethod : undefined;
	const provider = typeof status.apiProvider === "string" ? status.apiProvider : "firstParty";
	if (!status.loggedIn) return { signedIn: false };
	const metered =
		Boolean(status.apiKeySource) || method === "api_key" || (provider !== "firstParty" && provider !== "gateway");
	const plan = method === "claude.ai" || (method === "oauth_token" && provider === "firstParty");
	const billing = metered ? "metered" : plan ? "plan" : undefined;
	return {
		signedIn: true,
		...(method ? { method: provider === "firstParty" ? method : `${method} (${provider})` } : {}),
		...(billing ? { billing } : {}),
	};
}

/** `codex login status`: one line naming ChatGPT or an API key (the key's prefix is printed: only the kind is kept). */
function readCodexStatus(output: string, code: number | null): RunnerAuth | undefined {
	if (/not logged in/i.test(output)) return { signedIn: false };
	if (/logged in using chatgpt/i.test(output)) return { signedIn: true, method: "ChatGPT", billing: "plan" };
	if (/logged in using an api key/i.test(output)) return { signedIn: true, method: "API key", billing: "metered" };
	return code === 1 ? { signedIn: false } : undefined;
}

/** OpenCode V2 lists provider connections: stored credentials or credentials supplied by its server environment. */
function readOpencodeStatus(output: string): RunnerAuth | undefined {
	const parsed = parseJson(output.trim().startsWith("[") ? `{"list":${output.trim()}}` : output);
	const rows = isRecord(parsed) && Array.isArray(parsed.list) ? parsed.list : undefined;
	if (!rows) return undefined;
	let connected = false;
	for (const row of rows) {
		if (!isRecord(row)) return undefined;
		if (typeof row.id === "string" && Array.isArray(row.connections)) {
			for (const connection of row.connections) {
				if (!isRecord(connection) || !["credential", "env"].includes(String(connection.type))) return undefined;
				connected = true;
			}
		} else if (typeof row.provider === "string" && ["api", "oauth"].includes(String(row.type))) {
			// Earlier CLIs returned credential rows directly.
			connected = true;
		} else return undefined;
	}
	return connected ? { signedIn: true, method: "opencode auth" } : { signedIn: false };
}

const configDir = (env: NodeJS.ProcessEnv, name: string, fallback: string) => env[name]?.trim() || fallback;

export const RUNNERS: readonly RunnerSpec[] = [
	{
		id: "claude-code",
		name: "Claude Code",
		cli: "claude",
		adapter: { command: "claude-agent-acp", args: [], install: "npm install -g @agentclientprotocol/claude-agent-acp" },
		tested: "2.1.322",
		status: { args: ["auth", "status", "--json"], read: readClaudeStatus },
		login: ["auth", "login"],
		// The token file on Linux and Windows; on macOS the token is in the Keychain, so a sign-out shows at the next run.
		signInFiles: (env, home) => [
			path.join(configDir(env, "CLAUDE_CONFIG_DIR", path.join(home, ".claude")), ".credentials.json"),
		],
		keep: ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"],
	},
	{
		id: "codex",
		name: "Codex CLI",
		cli: "codex",
		adapter: { command: "codex-acp", args: [], install: "npm install -g @agentclientprotocol/codex-acp" },
		tested: "0.166.0",
		status: { args: ["login", "status"], read: readCodexStatus },
		login: ["login"],
		signInFiles: (env, home) => [path.join(configDir(env, "CODEX_HOME", path.join(home, ".codex")), "auth.json")],
		keep: ["CODEX_HOME"],
	},
	{
		id: "opencode",
		name: "OpenCode",
		cli: "opencode",
		adapter: { command: "opencode", args: ["acp"], install: "brew install opencode" },
		tested: "2.0.32",
		// Checked with V2 2.0.32: a private server receives this run's environment; ACP starts its own private server.
		status: { args: ["auth", "list", "--format", "json", "--standalone"], read: readOpencodeStatus },
		login: ["auth", "login"],
		signInFiles: (env, home) => [
			path.join(configDir(env, "XDG_DATA_HOME", path.join(home, ".local", "share")), "opencode", "auth.json"),
		],
		keep: [],
	},
	{
		id: "gemini",
		name: "Gemini CLI",
		cli: "gemini",
		adapter: { command: "gemini", args: ["--acp"], install: "npm install -g @google/gemini-cli" },
		tested: "0.64.0",
		// No status command: an ACP session check tells signed in from signed out.
		login: [],
		signInFiles: (env, home) => [path.join(configDir(env, "GEMINI_CLI_HOME", home), ".gemini", "oauth_creds.json")],
		keep: ["GEMINI_CLI_CUSTOM_HEADERS"],
	},
];

export const runnerSpec = (id: string): RunnerSpec | undefined => RUNNERS.find((runner) => runner.id === id);

/** The home a runner's paths resolve under: `HOME` as this process sees it. */
export const runnerHome = (env: NodeJS.ProcessEnv = process.env): string => env.HOME?.trim() || os.homedir();

/**
 * The adapter's arguments for a run: Claude Code signed in with an API key gets `--hide-claude-auth`, so the adapter
 * refuses to bill a Claude subscription by accident; a plan login runs without it.
 */
export function adapterArgs(spec: RunnerSpec, billing: RunnerBilling | undefined): string[] {
	return [...spec.adapter.args, ...(spec.id === "claude-code" && billing === "metered" ? ["--hide-claude-auth"] : [])];
}

/** The leading `major.minor.patch` of a version line (`2.1.322 (Claude Code)`, `codex-cli 0.166.0`, `v2.0.32`). */
export function versionOf(text: string): string | undefined {
	return /(\d+)\.(\d+)\.(\d+)/.exec(text)?.[0];
}

/** Whether `version` is older than `tested`, compared part by part. */
export function olderThan(version: string, tested: string): boolean {
	const a = version.split(".").map(Number);
	const b = tested.split(".").map(Number);
	for (let index = 0; index < 3; index++)
		if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) < (b[index] ?? 0);
	return false;
}
