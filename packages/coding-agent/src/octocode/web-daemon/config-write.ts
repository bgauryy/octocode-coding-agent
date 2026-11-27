/**
 * The write path of the configuration page. The host owns persistence: a change goes through `SettingsManager`, which
 * locks and atomically replaces the settings file, keeps the keys it did not touch, and refuses a project write for an
 * untrusted folder. This module adds what the page needs on top: a refusal that says why (and a status for it), and the
 * rule that a file that failed to parse is never overwritten.
 */

import type { ConfigSettingCommand } from "@octocodeai/octocode-contracts/config";
import { join } from "node:path";
import { closestIds } from "../../configuration/result.ts";
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

/** Refuses a provider or model the runtime does not know, naming the closest known ones. Reads, never writes. */
async function assertKnownModel(agentDir: string, provider: string, model: string): Promise<void> {
	const { ModelRuntime } = await import("../../core/model-runtime.ts");
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
		readOnlyCredentials: true,
	});
	try {
		const known = runtime.getModels();
		if (known.some((entry) => entry.provider === provider && entry.id === model)) return;
		const providers = [...new Set(known.map((entry) => entry.provider))];
		if (!providers.includes(provider)) {
			const near = closestIds(provider, providers);
			throw new ConfigWriteError(
				400,
				`Unknown provider "${provider}".${near.length > 0 ? ` Closest: ${near.join(", ")}.` : ""} Hosts and custom providers are defined in models.json.`,
				"unknown-provider",
			);
		}
		const near = closestIds(
			model,
			known.filter((entry) => entry.provider === provider).map((entry) => entry.id),
		);
		throw new ConfigWriteError(
			400,
			`Unknown model "${model}" for ${provider}.${near.length > 0 ? ` Closest: ${near.join(", ")}.` : ""}`,
			"unknown-model",
		);
	} finally {
		runtime.dispose();
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
		const pair = command.value
			? { provider: command.value.provider.trim(), model: command.value.model.trim() }
			: undefined;
		if (pair) await assertKnownModel(options.agentDir, pair.provider, pair.model);
		manager.setDefaultSelectionPair(scope, pair);
	} else manager.setDefaultSelection(scope, command.key, command.value ?? undefined);
	await manager.flush();
	if (manager.drainErrors().length > 0)
		throw new ConfigWriteError(500, `The ${command.scope} settings file could not be written.`);
}
