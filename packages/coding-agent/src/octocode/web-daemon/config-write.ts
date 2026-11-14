/**
 * The write path of the configuration page. The host owns persistence: a change goes through `SettingsManager`, which
 * locks and atomically replaces the settings file, keeps the keys it did not touch, and refuses a project write for an
 * untrusted folder. This module adds what the page needs on top: a refusal that says why (and a status for it), and the
 * rule that a file that failed to parse is never overwritten.
 */

import type { ConfigSettingCommand } from "@octocodeai/octocode-contracts/config";
import { SettingsManager } from "../../core/settings-manager.ts";
import { resolveFolderTrust } from "../trust/resolve.ts";

/** A refused or failed write. `message` is fixed text; it never quotes file content. */
export class ConfigWriteError extends Error {
	readonly status: number;
	/** A short fixed code for the audit trail; never text from a file or a key. */
	readonly code: string;
	constructor(status: number, message: string, code = "refused") {
		super(message);
		this.name = "ConfigWriteError";
		this.status = status;
		this.code = code;
	}
}

export interface ConfigWriteOptions {
	agentDir: string;
	/** The workspace root the daemon resolved from `command.repoId`; absent when the id is unknown or not sent. */
	cwd?: string;
}

/**
 * Sets or clears one allow-listed setting in the global or the workspace settings file. A workspace write needs the
 * workspace to be trusted, as at startup. Resolves after the file is written; running sessions read it on `/reload`.
 */
export async function writeConfigSetting(command: ConfigSettingCommand, options: ConfigWriteOptions): Promise<void> {
	const workspace = command.scope === "workspace";
	if (workspace) {
		if (options.cwd === undefined) throw new ConfigWriteError(400, "Choose a workspace to change its settings.");
		if (resolveFolderTrust(options.cwd).state !== "trusted")
			throw new ConfigWriteError(
				403,
				"This workspace is not trusted, so its settings cannot be changed. Trust it with /trust in a terminal session.",
			);
	}
	const manager = SettingsManager.create(workspace ? options.cwd! : options.agentDir, options.agentDir, {
		projectTrusted: workspace,
	});
	const scope = workspace ? "project" : "global";
	// A file that did not parse is read as empty: writing now would replace it, so the write is refused instead.
	if (manager.drainErrors().some((error) => error.scope === scope))
		throw new ConfigWriteError(
			409,
			`The ${command.scope} settings file is invalid, so it was not changed. Fix it in a terminal first.`,
		);
	if (command.key === "modelDefault") {
		if (command.value && (!command.value.provider.trim() || !command.value.model.trim()))
			throw new ConfigWriteError(400, "Choose both a provider and a model.");
		manager.setDefaultSelectionPair(
			scope,
			command.value ? { provider: command.value.provider.trim(), model: command.value.model.trim() } : undefined,
		);
	} else manager.setDefaultSelection(scope, command.key, command.value ?? undefined);
	await manager.flush();
	if (manager.drainErrors().length > 0)
		throw new ConfigWriteError(500, `The ${command.scope} settings file could not be written.`);
}
