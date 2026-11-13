import chalk from "chalk";
import { parseArgs } from "../cli/args.ts";
import {
	type AuthCheckResult,
	checkProviderAuth,
	createAuthCheckModelRuntime,
	getProviderCredential,
} from "../cli/auth-check.ts";
import {
	type AuthCommand,
	AuthCommandError,
	getAuthCommandName,
	getAuthCommandUsage,
	isAuthCommandHelp,
	parseAuthCommand,
	printAuthCommandHelp,
	validateAuthCommandArgs,
} from "../cli/auth-command.ts";
import { resolveCredentialForPrint } from "../cli/credential-print.ts";
import { APP_NAME, getAgentDir } from "../config.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import { createDefaultCredentialStore } from "../core/model-runtime/create.ts";
import { providerSourceGate } from "../core/provider-sources/gate.ts";
import { SettingsManager } from "../core/settings-manager.ts";

export async function runAuthCommand(args: string[]): Promise<boolean> {
	if (isAuthCommandHelp(args)) {
		printAuthCommandHelp();
		return true;
	}

	let command: AuthCommand | undefined;
	try {
		command = parseAuthCommand(args);
	} catch (error) {
		const message = error instanceof AuthCommandError ? error.message : "Failed to parse auth command";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
	if (!command) return false;

	const parsed = parseArgs(command.args);
	if (parsed.unknownFlags.length > 0) {
		const option = parsed.unknownFlags[0];
		console.error(chalk.red(`Unknown option --${option} for "${getAuthCommandName(command.kind)}".`));
		console.error(chalk.dim(`Use "${APP_NAME} --help" or "${getAuthCommandUsage(command.kind)}".`));
		process.exitCode = 1;
		return true;
	}
	let modelRuntime: ModelRuntime | undefined;
	try {
		if (parsed.diagnostics.length > 0) {
			throw new AuthCommandError(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
		}
		providerSourceGate.set(SettingsManager.create(process.cwd(), getAgentDir()).getProviderSources());
		const signal = AbortSignal.timeout(15_000);
		if (command.kind !== "check") {
			modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, signal });
			const credential = await resolveCredentialForPrint(
				parsed,
				modelRuntime,
				command.kind,
				command.minExpiryMs,
				signal,
			);
			process.stdout.write(`${credential}\n`);
			return true;
		}

		const requestedAuth = validateAuthCommandArgs(parsed, command.kind);
		let result: AuthCheckResult;
		let credential: string | undefined;
		try {
			const credentials = createDefaultCredentialStore({ readOnlyCredentials: command.noRefresh });
			modelRuntime = await createAuthCheckModelRuntime(credentials, signal);
			result = await checkProviderAuth(parsed, modelRuntime, { refresh: !command.noRefresh, signal });
			if (command.credentials && result.status === "ready") {
				credential = await getProviderCredential(result.provider, modelRuntime, credentials, {
					refresh: !command.noRefresh,
					signal,
				});
				if (!credential) {
					result = { status: "not_ready", provider: result.provider, reason: "credential_not_available" };
				}
			}
		} catch {
			result = {
				status: "invalid",
				provider: requestedAuth.provider ?? requestedAuth.model!,
				reason: "invalid_state",
			};
		}
		const output = command.json
			? JSON.stringify({ ...result, ...(credential ? { credentials: credential } : {}) })
			: (credential ?? result.status);
		process.stdout.write(`${output}\n`);
		process.exitCode = result.status === "ready" ? 0 : result.status === "not_ready" ? 1 : 2;
	} catch (error) {
		const message = error instanceof AuthCommandError ? error.message : "Failed to resolve credential";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = command.kind === "check" ? 2 : 1;
	} finally {
		modelRuntime?.dispose();
	}
	return true;
}
