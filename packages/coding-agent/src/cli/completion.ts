import { shellCompletion as renderShellCompletion } from "../octocode/shared/shell-completion.ts";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { getBuiltinProviders, getBuiltinModels } from "@octocodeai/octocode-ai/providers/all";
import { loadMcpConfig } from "../extensions/mcp/config.ts";
import { ProjectTrustStore } from "../core/trust-manager.ts";
import { APP_NAME, getAgentDir } from "../config.ts";
import { VALID_THINKING_LEVELS } from "./args.ts";

export const CLI_FLAGS = [
	"--help",
	"-h",
	"--version",
	"-v",
	"--mode",
	"--continue",
	"-c",
	"--resume",
	"-r",
	"--provider",
	"--model",
	"--api-key",
	"--system-prompt",
	"--append-system-prompt",
	"--name",
	"-n",
	"--no-session",
	"--session",
	"--session-id",
	"--fork",
	"--session-dir",
	"--models",
	"--no-tools",
	"-nt",
	"--no-builtin-tools",
	"-nbt",
	"--tools",
	"-t",
	"--exclude-tools",
	"-xt",
	"--thinking",
	"--print",
	"-p",
	"--export",
	"--extension",
	"-e",
	"--no-extensions",
	"-ne",
	"--no-mcp",
	"--skill",
	"--prompt-template",
	"--theme",
	"--use-theme",
	"--no-skills",
	"-ns",
	"--no-prompt-templates",
	"-np",
	"--no-themes",
	"--no-context-files",
	"-nc",
	"--list-models",
	"--tui-mode",
	"--verbose",
	"--approve",
	"-a",
	"--no-approve",
	"-na",
	"--offline",
	"--",
];
const exposures = ["auto", "deferred", "direct", "hidden"];
const commands: Record<string, readonly string[]> = {
	auth: ["check", "print-api-key", "print-bearer-token"],
	mcp: ["add", "remove", "enable", "disable", "exposure", "list", "tools", "config", "login", "logout"],
	install: [],
	remove: [],
	update: ["self"],
	list: [],
	config: [],
	migrate: [],
	research: [],
	native: [],
	completion: ["bash", "zsh", "fish"],
};
const values: Record<string, readonly string[]> = {
	"--mode": ["text", "json", "rpc", "acp"],
	"--thinking": VALID_THINKING_LEVELS,
	"--tui-mode": ["fullscreen", "regular"],
	"--exposure": exposures,
};
const paths = new Set([
	"--session",
	"--fork",
	"--session-dir",
	"--export",
	"--extension",
	"-e",
	"--skill",
	"--prompt-template",
	"--theme",
	"--cwd",
]);
const textFlags = new Set([
	"--provider",
	"--model",
	"--models",
	"--api-key",
	"--system-prompt",
	"--append-system-prompt",
	"--name",
	"-n",
	"--session-id",
	"--use-theme",
	"--list-models",
	"--url",
	"--env",
	"--header",
	"--bearer-token-env-var",
	"--oauth-client-id",
	"--oauth-client-secret",
	"--oauth-callback-port",
	"--oauth-client-name",
	"--description",
	"--timeout",
	"--min-expiry",
]);
const tools = ["bash", "file", "agent", "backlog", "web", "memory"];

function fileValues(prefix: string, cwd: string): string[] {
	const slash = prefix.lastIndexOf("/");
	const parent = prefix.slice(0, slash + 1);
	const name = prefix.slice(slash + 1);
	const expanded = prefix.startsWith("~/") ? homedir() + prefix.slice(1) : prefix;
	try {
		return readdirSync(resolve(cwd, prefix.endsWith("/") ? expanded : dirname(expanded)), { withFileTypes: true })
			.filter((entry) => entry.name.startsWith(name) && (name.startsWith(".") || !entry.name.startsWith(".")))
			.map((entry) => parent + entry.name + (entry.isDirectory() ? "/" : ""))
			.sort();
	} catch {
		return [];
	}
}

export function completeCli(words: string[], cwd = process.cwd()): string[] {
	const prefix = words.at(-1) ?? "";
	const previous = words.at(-2) ?? "";
	const before = words.slice(0, -1);
	const [command, action] = before;
	if (before.includes("--")) return [];
	const filter = (candidates: readonly string[]) =>
		candidates.filter((value) => value.startsWith(prefix) && !/[\r\n\t]/.test(value));
	if (previous === "--provider") return filter(getBuiltinProviders());
	if ((previous === "--model" || previous === "--models") && command !== "update") {
		const providerIndex = before.indexOf("--provider");
		const provider = providerIndex < 0 ? undefined : before[providerIndex + 1];
		const last = previous === "--models" ? prefix.lastIndexOf(",") + 1 : 0;
		return filter(
			getBuiltinProviders()
				.filter((id) => !provider || id === provider)
				.flatMap((id) =>
					getBuiltinModels(id).map(
						(model) =>
							prefix.slice(0, last) + (provider && !prefix.slice(last).includes("/") ? model.id : `${id}/${model.id}`),
					),
				),
		);
	}
	if (values[previous]) return filter(values[previous]);
	if (["--tools", "-t", "--exclude-tools", "-xt"].includes(previous)) {
		const last = prefix.lastIndexOf(",") + 1;
		return filter(tools.map((tool) => prefix.slice(0, last) + tool));
	}
	if (paths.has(previous)) return filter(fileValues(prefix, cwd));
	if (textFlags.has(previous) && !(command === "update" && previous === "--models")) return [];
	if (
		command === "mcp" &&
		words.length === 3 &&
		["remove", "enable", "disable", "exposure", "tools", "login", "logout"].includes(action) &&
		!prefix.startsWith("-")
	) {
		const agentDir = getAgentDir();
		try {
			return filter(
				loadMcpConfig({ agentDir, cwd, projectTrusted: new ProjectTrustStore(agentDir).get(cwd) === true }).servers.map(
					(server) => server.name,
				),
			);
		} catch {
			return [];
		}
	}
	if (command === "mcp" && action === "exposure" && words.length === 4) return filter(exposures);
	if (command && commands[command]) {
		if (words.length === 2 && !prefix.startsWith("-")) return filter(commands[command]);
		const flags = ["--help", "-h"];
		if (command === "auth")
			flags.push(
				"--provider",
				"--model",
				...(action === "check"
					? ["--json", "--credentials", "--no-refresh"]
					: action === "print-bearer-token"
						? ["--min-expiry"]
						: []),
			);
		if (command === "mcp") {
			if (["add", "remove", "enable", "disable", "exposure"].includes(action)) flags.push("--local", "-l");
			if (["list", "tools", "config"].includes(action)) flags.push("--json");
			if (action === "login") flags.push("--timeout");
			if (action === "add")
				flags.push(
					"--url",
					"--env",
					"--cwd",
					"--header",
					"--bearer-token-env-var",
					"--oauth-client-id",
					"--oauth-client-secret",
					"--oauth-callback-port",
					"--oauth-client-name",
					"--exposure",
					"--description",
					"--",
				);
		}
		if (["install", "remove", "config", "list", "update"].includes(command)) flags.push("--approve", "--no-approve");
		if (["install", "remove", "config"].includes(command)) flags.push("--local", "-l");
		if (command === "update") flags.push("--self", "--extensions", "--models", "--all", "--extension", "--force");
		return prefix.startsWith("-") ? filter(flags) : [];
	}
	return filter(prefix.startsWith("-") ? CLI_FLAGS : words.length <= 1 ? [...Object.keys(commands), ...CLI_FLAGS] : []);
}

export function shellCompletion(shell: "bash" | "zsh" | "fish"): string {
	return renderShellCompletion(shell, APP_NAME);
}

export function runCompletionCommand(args: string[]): boolean {
	if (args[0] !== "completion") return false;
	if (args[1] === "--values") {
		const candidates = completeCli(args.slice(2));
		if (candidates.length) process.stdout.write(candidates.join("\n") + "\n");
	} else if (args.length === 2 && ["bash", "zsh", "fish"].includes(args[1])) {
		process.stdout.write(shellCompletion(args[1] as "bash" | "zsh" | "fish"));
	} else {
		console.log(`Usage: ${APP_NAME} completion <bash|zsh|fish>`);
		if (args.length > 1 && !["--help", "-h"].includes(args[1])) process.exitCode = 1;
	}
	return true;
}
