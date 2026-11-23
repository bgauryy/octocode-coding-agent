/**
 * The one-shot commands `octocode <name> ...` runs instead of a session: each name loads its module on use and answers
 * with an exit code.
 */

import { loadMcpCommand } from "../../../mcp/src/api.ts";
import { parseArgs } from "../cli/args.ts";
import { CLI_COMMAND_NAMES, isSubcommand } from "../cli/completion.ts";
import { APP_NAME } from "../config.ts";
import { handleConfigCommand, handlePackageCommand } from "../package-manager-cli.ts";
import { prepareAgentDb } from "../storage/database.ts";
import { drainStdio } from "./drain-stdio.ts";

interface SubcommandContext {
	cwd: string;
	agentDir: string;
}

type Subcommand = (args: string[], context: SubcommandContext) => Promise<number>;

/** Subcommands by name; each receives the arguments after its name. */
export const SUBCOMMANDS: Readonly<Record<string, Subcommand>> = {
	mcp: async (args, context) =>
		(await loadMcpCommand()).runMcpCommand(args, { ...context, prepareTrust: () => prepareAgentDb() }),
	trust: async (args, { cwd }) => (await import("../cli/trust-command.ts")).runTrustCommand(args, { cwd }),
	security: async (args, { cwd, agentDir }) =>
		(await import("../cli/security-command.ts")).runSecurityCommand(args, { cwd, agentDir }),
	backlog: async (args, { cwd }) => (await import("../cli/backlog-command.ts")).runBacklogCommand(args, { cwd }),
	profile: async (args, { cwd }) => (await import("../cli/profile-command.ts")).runProfileCommand(args, { cwd }),
	marketplace: async (args, { cwd }) =>
		(await import("../octocode/plugins/marketplace/command.ts")).runMarketplaceCommand(args, { cwd }),
	plugin: async (args, { cwd }) =>
		(await import("../octocode/plugins/marketplace/command.ts")).runPluginCommand(args, { cwd }),
	context: async (args, { cwd, agentDir }) =>
		(await import("../octocode/context-optimization/command.ts")).runContextCommand(args, { agentDir, cwd }),
};

/**
 * A lone lowercase word typed at a terminal that no command claims: a mistyped command, not a prompt. Quoted
 * sentences, flags and piped input stay prompts.
 */
function looksLikeMistypedSubcommand(args: readonly string[]): boolean {
	return args.length === 1 && process.stdin.isTTY && /^[a-z][a-z-]*$/.test(args[0]) && !isSubcommand(args);
}

/**
 * A command name after session options (`--offline mcp list`), where a session would send it to the model as a prompt.
 * Returns where it starts in `args`. A word after `--` is a message.
 */
function misplacedSubcommand(args: readonly string[]): number | undefined {
	const end = args.indexOf("--");
	const head = end === -1 ? args : args.slice(0, end);
	const first = parseArgs([...head]).messages[0];
	if (first === undefined || !isSubcommand([first])) return undefined;
	// The same word can be an option's value earlier (`--name mcp mcp list`): the first prefix that yields it as a message.
	const at = head.findIndex(
		(word, index) => word === first && parseArgs(head.slice(0, index + 1)).messages[0] === first,
	);
	return at > 0 ? at : undefined;
}

/**
 * Runs the one-shot command `args` names, if any, and says whether it did. Package and config commands exit the
 * process, so a feature they load cannot keep it alive; the others set `process.exitCode` and return.
 */
export async function runSubcommand(args: string[], context: SubcommandContext): Promise<boolean> {
	if (await handlePackageCommand(args)) {
		const exitCode = process.exitCode ?? 0;
		// On Windows, Node can assert after fetch() when process.exit(0) runs during teardown
		// (https://github.com/nodejs/node/issues/56645): a successful `octocode update` drains naturally instead.
		if (process.platform === "win32" && exitCode === 0 && args[0] === "update") return true;
		await drainStdio();
		process.exit(exitCode);
		return true;
	}
	if (await handleConfigCommand(args)) {
		await drainStdio();
		process.exit(process.exitCode ?? 0);
		return true;
	}
	if (looksLikeMistypedSubcommand(args)) {
		process.stderr.write(
			`octocode: unknown command "${args[0]}". Commands: ${CLI_COMMAND_NAMES.join(", ")}.\n` +
				`To send "${args[0]}" as a prompt, quote it with more words or use -p.\n`,
		);
		process.exitCode = 2;
		return true;
	}
	const name = args[0];
	const run = name !== undefined && Object.hasOwn(SUBCOMMANDS, name) ? SUBCOMMANDS[name] : undefined;
	const misplaced = run ? undefined : misplacedSubcommand(args);
	if (misplaced !== undefined) {
		const command = args[misplaced];
		process.stderr.write(
			`octocode: "${command}" is a command, so it goes first: ${APP_NAME} ${args.slice(misplaced).join(" ")}\n` +
				`The options before it (${args.slice(0, misplaced).join(" ")}) start a session; a command takes only its own (${APP_NAME} ${command} --help).\n` +
				`To send "${command}" as a prompt, put it after --.\n`,
		);
		process.exitCode = 2;
		return true;
	}
	if (!run) return false;
	process.exitCode = await run(args.slice(1), context);
	return true;
}
