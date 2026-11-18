/**
 * The one-shot commands `octocode <name> ...` runs instead of a session: each name loads its module on use and answers
 * with an exit code.
 */

import { loadMcpCommand } from "../../../mcp/src/api.ts";
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
	profile: async (args, { cwd }) => (await import("../cli/profile-command.ts")).runProfileCommand(args, { cwd }),
	marketplace: async (args, { cwd }) =>
		(await import("../octocode/plugins/marketplace/command.ts")).runMarketplaceCommand(args, { cwd }),
	plugin: async (args, { cwd }) =>
		(await import("../octocode/plugins/marketplace/command.ts")).runPluginCommand(args, { cwd }),
	context: async (args, { cwd, agentDir }) =>
		(await import("../octocode/context-optimization/command.ts")).runContextCommand(args, { agentDir, cwd }),
};

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
	const name = args[0];
	const run = name !== undefined && Object.hasOwn(SUBCOMMANDS, name) ? SUBCOMMANDS[name] : undefined;
	if (!run) return false;
	process.exitCode = await run(args.slice(1), context);
	return true;
}
