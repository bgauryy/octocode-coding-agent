/**
 * The provider switches of the configuration page. Both are global settings written through `SettingsManager`, as
 * `/providers` and `/settings` do: `disabledProviders` hides a provider's models and keeps its credentials, and
 * `providerSources.pi` turns Pi's credentials and models.json on or off. No credential or configuration file changes.
 * The custom provider edits (host, limits, removal) change Octocode's models.json instead; see `custom-provider-write.ts`.
 * Running sessions apply a change when they reload their settings (`/reload`); the daemon holds no session to tell.
 */

import type { ConfigProviderCommand } from "@octocodeai/octocode-contracts/config";
import type { ConfigAuditEntry } from "../../../../db/src/api.ts";
import { setProviderHiddenModels } from "../../core/provider-models.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { buildConfigSnapshot, type ConfigStatusOptions } from "./config-status.ts";
import { ConfigWriteError } from "./config-write.ts";
import { createProviderFromTemplate, isTemplateProviderCommand } from "./template-provider-write.ts";
import { applyCustomProviderChange, isCustomProviderCommand } from "./custom-provider-write.ts";

export interface ProviderWriteOptions extends Pick<
	ConfigStatusOptions,
	"agentDir" | "env" | "piDirs" | "home" | "keychain"
> {
	/** Who is acting, for the audit entry, such as `web:<daemon instance>`. */
	actor: string;
	/** Receives one entry per attempt. It must not throw; the write does not depend on it. */
	audit?: (entry: ConfigAuditEntry) => void;
}

async function apply(command: ConfigProviderCommand, options: ProviderWriteOptions): Promise<void> {
	if (isTemplateProviderCommand(command)) return createProviderFromTemplate(command, options);
	if (isCustomProviderCommand(command)) return applyCustomProviderChange(command, options);
	const manager = SettingsManager.create(options.agentDir, options.agentDir, { projectTrusted: false });
	// A file that did not parse is read as empty: writing now would replace it, so the write is refused instead.
	if (manager.drainErrors().some((error) => error.scope === "global"))
		throw new ConfigWriteError(
			409,
			"The global settings file is invalid, so it was not changed. Fix it in a terminal first.",
			"invalid-file",
		);
	if (command.action === "set-source") {
		manager.setProviderSourceEnabled(command.source, command.enabled);
	} else if (command.action === "set-models") {
		const known = (await buildConfigSnapshot({ ...options, cwd: undefined })).providers.some(
			(row) => row.provider === command.provider,
		);
		if (!known) throw new ConfigWriteError(404, "Unknown provider.", "unknown");
		setProviderHiddenModels(manager, command.provider, command.hidden);
	} else {
		const disabled = manager.getDisabledProviders();
		if (!disabled.includes(command.provider)) {
			const known = (await buildConfigSnapshot({ ...options, cwd: undefined })).providers.some(
				(row) => row.provider === command.provider,
			);
			if (!known) throw new ConfigWriteError(404, "Unknown provider.", "unknown");
		}
		manager.setDisabledProviders(
			command.enabled ? disabled.filter((id) => id !== command.provider) : [...disabled, command.provider],
		);
	}
	await manager.flush();
	if (manager.drainErrors().length > 0)
		throw new ConfigWriteError(500, "The global settings file could not be written.", "write");
}

function auditAction(command: ConfigProviderCommand): string {
	if (command.action === "set-source") return "source.toggle";
	if (command.action === "set-models") return "provider.models";
	return command.action === "set-provider" ? "provider.toggle" : `provider.${command.action}`;
}

/** Turns a provider or the Pi source on or off, or changes a custom provider. Resolves once saved; throws `ConfigWriteError` otherwise. */
export async function writeConfigProvider(
	command: ConfigProviderCommand,
	options: ProviderWriteOptions,
): Promise<void> {
	const entry: ConfigAuditEntry = {
		at: Date.now(),
		actor: options.actor,
		action: auditAction(command),
		target: command.action === "set-source" ? command.source : command.provider,
		scope: "global",
		...("enabled" in command ? { afterKind: command.enabled ? "on" : "off" } : {}),
		outcome: "failed",
	};
	try {
		await apply(command, options);
		entry.outcome = "ok";
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
			// The audit is best effort: a missing database must not undo or hide a change that was made.
		}
	}
}
