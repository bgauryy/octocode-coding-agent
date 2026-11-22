/**
 * The External agents panel of the configuration page. Detection and checks are `external/runner-status.ts` and the
 * enable/disable rules are `external/runner-selection.ts`, the code `/providers` → External agents runs, so the page and
 * the terminal cannot disagree. Only `settings.json` changes (through `SettingsManager`); no credential is read, and the
 * vendor's own login is run by the user in a terminal. Running sessions apply a change after `/reload`.
 */

import type { RunnerCommand, RunnerList, RunnerRow } from "@octocodeai/octocode-contracts/config";
import type { ConfigAuditEntry } from "../../../../db/src/api.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { headlessAvailable, runnerRoute } from "../external/runner-headless.ts";
import { isRunnerActive, setRunnerEnabled } from "../external/runner-selection.ts";
import { checkRunners, isConnected, listRunners, type RunnerState } from "../external/runner-status.ts";
import { runnerSpec, type RunnerSpec } from "../external/runners.ts";
import { ConfigWriteError } from "./config-write.ts";

export interface RunnerConfigOptions {
	agentDir: string;
	/** Where runners are found and checked; tests pass a temporary PATH and home. */
	env?: NodeJS.ProcessEnv;
}

export interface RunnerActOptions extends RunnerConfigOptions {
	/** Who is acting, for the audit entry, such as `web:<daemon instance>`. */
	actor: string;
	/** Receives one entry per attempt. It must not throw; the write does not depend on it. */
	audit?: (entry: ConfigAuditEntry) => void;
}

function globalSettings(agentDir: string): SettingsManager {
	return SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
}

function signInOf(state: RunnerState): RunnerRow["signIn"] {
	const checkedAt = state.checkedAt === undefined ? {} : { checkedAt: state.checkedAt };
	if (state.checkedAt === undefined) return { state: "unchecked" };
	if (!state.auth)
		return { state: "unknown", ...(state.error ? { error: state.error.slice(0, 300) } : {}), ...checkedAt };
	return {
		state: state.auth.signedIn ? "signed-in" : "signed-out",
		...(state.auth.method ? { method: state.auth.method.slice(0, 80) } : {}),
		...(state.auth.billing ? { billing: state.auth.billing } : {}),
		...checkedAt,
	};
}

function rowOf(state: RunnerState, spec: RunnerSpec, settings: SettingsManager): RunnerRow {
	const route = runnerRoute(state);
	return {
		id: state.id,
		name: state.name,
		cli: {
			command: spec.cli,
			installed: state.cli,
			...(state.version ? { version: state.version.slice(0, 80) } : {}),
			tested: spec.tested,
			...(state.untested ? { untested: true } : {}),
		},
		adapter: {
			command: spec.adapter.command,
			// A headless-only runner never uses an adapter: its CLI is the route.
			installed: state.adapter || headlessAvailable(state),
			install: spec.adapter.install,
			...(route ? { route } : {}),
		},
		signIn: signInOf(state),
		login: [spec.cli, ...spec.login].join(" "),
		connected: isConnected(state),
		enabled: isRunnerActive(settings, state.id),
	};
}

function listOf(states: readonly RunnerState[], agentDir: string, message?: string): RunnerList {
	const settings = globalSettings(agentDir);
	return {
		tasksEnabled: settings.getExternalAgents(),
		runners: states.flatMap((state) => {
			const spec = runnerSpec(state.id);
			return spec ? [rowOf(state, spec, settings)] : [];
		}),
		...(message ? { message } : {}),
	};
}

/** Every runner as last checked, read without starting any vendor command. */
export function listRunnerRows(options: RunnerConfigOptions): RunnerList {
	return listOf(listRunners(options.env ?? process.env, options.agentDir), options.agentDir);
}

async function apply(command: RunnerCommand, options: RunnerActOptions): Promise<string> {
	if (command.action !== "set-tasks" && !runnerSpec(command.id))
		throw new ConfigWriteError(404, "Unknown external agent.", "unknown");
	if (command.action === "check") {
		await checkRunners({
			ids: [command.id],
			refresh: true,
			signal: AbortSignal.timeout(30_000),
			env: options.env ?? process.env,
			agentDir: options.agentDir,
		});
		return `${runnerSpec(command.id)?.name} checked.`;
	}
	const settings = globalSettings(options.agentDir);
	// A file that did not parse is read as empty: writing now would replace it, so the write is refused instead.
	if (settings.drainErrors().some((error) => error.scope === "global"))
		throw new ConfigWriteError(
			409,
			"The global settings file is invalid, so it was not changed. Fix it in a terminal first.",
			"invalid-file",
		);
	let message: string;
	if (command.action === "set-tasks") {
		settings.setExternalAgents(command.enabled);
		message = `External agent tasks ${command.enabled ? "enabled" : "paused"}.`;
	} else {
		setRunnerEnabled(settings, command.id, command.enabled);
		message = `${runnerSpec(command.id)?.name} ${command.enabled ? "enabled" : "disabled"} for agent tasks.`;
	}
	await settings.flush();
	if (settings.drainErrors().length > 0)
		throw new ConfigWriteError(500, "The global settings file could not be written.", "write");
	return `${message} Run /reload in a running session to apply.`;
}

function auditAction(command: RunnerCommand): string {
	if (command.action === "check") return "runner.check";
	if (command.action === "set-tasks") return command.enabled ? "runner.resume" : "runner.pause";
	return command.enabled ? "runner.enable" : "runner.disable";
}

/** Runs one command and answers with the fresh list. Throws `ConfigWriteError` for a refusal. */
export async function actRunners(command: RunnerCommand, options: RunnerActOptions): Promise<RunnerList> {
	const entry: ConfigAuditEntry = {
		at: Date.now(),
		actor: options.actor,
		action: auditAction(command),
		target: command.action === "set-tasks" ? "external-agents" : command.id,
		scope: "global",
		...(command.action === "check" ? {} : { afterKind: command.enabled ? "on" : "off" }),
		outcome: "failed",
	};
	try {
		const message = await apply(command, options);
		entry.outcome = "ok";
		return listOf(listRunners(options.env ?? process.env, options.agentDir), options.agentDir, message);
	} catch (error) {
		if (error instanceof ConfigWriteError) {
			entry.outcome = error.status >= 500 ? "failed" : "refused";
			entry.errorCode = error.code;
		} else entry.errorCode = "write";
		throw error;
	} finally {
		try {
			options.audit?.(entry);
		} catch {
			// The audit is best effort: a missing database must not hide a change that was made.
		}
	}
}
