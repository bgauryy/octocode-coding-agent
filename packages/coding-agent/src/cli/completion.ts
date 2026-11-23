import "../octocode/mcp-host/core-install.ts";
import { shellCompletion as renderShellCompletion } from "../octocode/shared/shell-completion.ts";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { getBuiltinProviders, getBuiltinModels } from "@octocodeai/octocode-ai/providers/all";
import { MCP_COMMANDS, loadMcpConfig, MCP_EXPOSURES } from "../../../mcp/src/api.ts";
import { MCP_MANAGE_TOOL_NAME } from "@octocodeai/octocode-common/mcp-names";
import { resolveFolderTrust } from "../octocode/trust/resolve.ts";
import { getNativeToolNames } from "../octocode/permission/native-tools.ts";
import { APP_NAME, getAgentDir } from "../config.ts";
import { FLAG_SPECS } from "./args/flags.ts";

/** Top-level flags, from the same table the parser and `--help` read. */
export const CLI_FLAGS = [
	...FLAG_SPECS.flatMap((spec) => (spec.hidden ? [] : [spec.name, ...(spec.short ? [spec.short] : [])])),
	"--",
];
/** Subcommands and their actions. A first argument named here is a command, not a prompt. */
const commands: Record<string, readonly string[]> = {
	models: ["discover"],
	auth: ["check", "print-api-key", "print-bearer-token"],
	mcp: MCP_COMMANDS.map(([name]) => name),
	context: ["list", "check", "apply"],
	trust: ["list", "add", "remove"],
	security: [],
	backlog: ["get", "list", "export", "groom", "graph"],
	configuration: ["list", "get", "enable", "disable", "set", "unset", "add", "remove"],
	profile: [],
	marketplace: ["add", "list", "update", "remove"],
	plugin: ["install", "update", "remove", "list"],
	install: [],
	remove: [],
	update: ["self"],
	list: [],
	config: [],
	research: [],
	native: [],
	completion: ["bash", "zsh", "fish"],
	remote: ["list", "link", "stop"],
};
/** Every top-level command name: the one list completion, the parser and the unknown-command error read. */
export const CLI_COMMAND_NAMES: readonly string[] = Object.keys(commands);
/** True when `args` run a subcommand (`install`, `mcp`, …) rather than a session. */
export const isSubcommand = (args: readonly string[]): boolean =>
	args[0] !== undefined && Object.hasOwn(commands, args[0]);
// Subcommand options (`mcp`, `auth`, …) complete alongside the top-level table.
const values: Record<string, readonly string[]> = {
	"--scope": ["folder", "parent", "grandparent"],
	...Object.fromEntries(FLAG_SPECS.filter((spec) => spec.values).map((spec) => [spec.name, spec.values!])),
	"--exposure": MCP_EXPOSURES,
};
const byCompletion = (kind: "path" | "text") =>
	FLAG_SPECS.flatMap((spec) => (spec.completion === kind ? [spec.name, ...(spec.short ? [spec.short] : [])] : []));
const paths = new Set([...byCompletion("path"), "--cwd"]);
const textFlags = new Set([
	...byCompletion("text"),
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
const tools = [...getNativeToolNames(), MCP_MANAGE_TOOL_NAME];

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
	if (["--tools", "-t", "--exclude-tools"].includes(previous)) {
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
				loadMcpConfig({ agentDir, cwd, projectTrusted: resolveFolderTrust(cwd).state === "trusted" }).servers.map(
					(server) => server.name,
				),
			);
		} catch {
			return [];
		}
	}
	if (command === "mcp" && action === "exposure" && words.length === 4) return filter(MCP_EXPOSURES);
	if (command && commands[command]) {
		if (words.length === 2 && !prefix.startsWith("-")) return filter(commands[command]);
		const flags = ["--help", "-h"];
		if (command === "models" && action === "discover") flags.push("--provider", "--offline", "--json");
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
		if (command === "context") {
			if (action === "list") flags.push("--json");
			if (action === "check" || action === "apply") flags.push("--overrides");
			if (action === "apply") flags.push("--optimized-by");
		}
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
		if (command === "backlog" && action === "get") flags.push("--limit", "--offset", "--changes");
		if (command === "backlog" && action === "list")
			flags.push("--query", "--states", "--ids", "--type", "--under", "--tag", "--sort", "--limit", "--offset");
		if (command === "profile")
			flags.push("--session", "--json", "--insights", "--agent", "--request", "--detail", "--timeline", "--trace");
		if (["install", "remove", "config", "list", "update"].includes(command)) flags.push("--trust");
		if (command === "plugin" && ["install", "update"].includes(action)) flags.push("--yes");
		if (command === "trust") {
			if (action === "list") flags.push("--json");
			if (action === "add") flags.push("--scope", "--yes");
			if (action === "remove") flags.push("--yes");
		}
		if (["install", "remove", "config"].includes(command)) flags.push("--local", "-l");
		if (command === "update") flags.push("--self", "--packages", "--models", "--all", "--package", "--force");
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
		// Help goes to stdout and succeeds; a missing or unknown shell is a usage error on stderr.
		const usage = `Usage: ${APP_NAME} completion <bash|zsh|fish>`;
		if (["--help", "-h", "help"].includes(args[1] ?? "")) console.log(usage);
		else {
			console.error(args[1] === undefined ? usage : `Unknown shell "${args[1]}".\n${usage}`);
			process.exitCode = 1;
		}
	}
	return true;
}
