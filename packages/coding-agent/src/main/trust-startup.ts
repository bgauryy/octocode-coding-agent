import { join } from "node:path";
import { cliStyle } from "../utils/cli-style.ts";
import type { Args } from "../cli/args.ts";
import { showFolderTrustPrompt, type TrustChoice, type TrustPromptInput } from "../cli/trust-prompt.ts";
import { getAgentDir } from "../config.ts";
import { formatNoModelsAvailableMessage } from "../core/auth-guidance.ts";
import type { FolderTrustAsker } from "../core/folder-trust.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import { providerSourceGate } from "../core/provider-sources/gate.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { envFlag, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { enforceFolderTrust, type TrustSurface } from "./trust-gate.ts";
import type { AppMode } from "./startup.ts";

/** The trust surface of this process: a subagent child never asks, whatever mode it runs in. */
function trustSurface(appMode: AppMode): TrustSurface {
	if (envFlag(process.env, SUBAGENT_ENV)) return "subagent";
	return appMode === "interactive" ? "tui" : appMode;
}

/** ACP decides trust per session (the broker's `folderTrust` port), so `--trust` has no folder to apply to. */
export function prepareAcpTrust(parsed: Args): void {
	if (parsed.trust) {
		console.error(
			cliStyle.error(
				"Error: --trust does not apply to ACP: each session's folder must already be trusted. Run: octocode trust add <path>",
			),
		);
		process.exit(1);
	}
}

/**
 * What a running session asks before it moves into another folder (a resumed or imported session, a new session with a
 * `cwd`, a worktree switch): the same gate as startup, minus `--trust`, which belongs to the folder the process started
 * in. With `prompt` the user is asked in the session; without it every non-trusted folder is refused with a message.
 */
export function folderTrustAsker(
	getAppMode: () => AppMode,
	prompt?: (input: TrustPromptInput) => Promise<TrustChoice>,
): FolderTrustAsker {
	return async (cwd) => {
		const result = await enforceFolderTrust({
			cwd,
			surface: trustSurface(getAppMode()),
			moving: true,
			...(prompt ? { prompt } : {}),
		});
		return result.ok ? { ok: true } : { ok: false, message: result.message };
	};
}

/**
 * The provider step a refused headless run would meet next, so one refusal names both: undefined when a model is
 * available. Reads only the user's own credentials and models.json, never the folder's (it is not trusted), offline.
 */
async function missingProviderStep(cwd: string, settingsManager: SettingsManager): Promise<string | undefined> {
	providerSourceGate.set(settingsManager.getProviderSources());
	const agentDir = getAgentDir();
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		project: { cwd, isTrusted: () => false },
		readOnlyCredentials: true,
		allowModelNetwork: false,
	});
	try {
		return (await runtime.getAvailable()).length > 0 ? undefined : formatNoModelsAvailableMessage("cli");
	} finally {
		runtime.dispose();
	}
}

/**
 * Decides whether a session may start in `cwd`; returns only when it may. Otherwise it prints why and exits: the
 * interactive prompt's own answers exit 0, every refusal of a headless run exits 1. Nothing of the folder was read.
 */
export async function gateStartup(input: {
	parsed: Args;
	appMode: AppMode;
	cwd: string;
	settingsManager: SettingsManager;
}): Promise<void> {
	const { parsed, appMode } = input;
	const surface = trustSurface(appMode);
	const result = await enforceFolderTrust({
		cwd: input.cwd,
		surface,
		trustFlag: parsed.trust,
		prompt:
			appMode === "interactive" ? (question) => showFolderTrustPrompt(input.settingsManager, question) : undefined,
	});
	if (result.ok) {
		if (result.notice) console.error(cliStyle.warn(result.notice));
		return;
	}
	// A subagent's parent has a provider; a person starting a text or JSON run may have neither step done.
	const next =
		result.undecided && (surface === "print" || surface === "json")
			? await missingProviderStep(input.cwd, input.settingsManager)
			: undefined;
	(result.exitCode === 0 ? console.log : console.error)(next ? `${result.message}\nThen: ${next}` : result.message);
	process.exit(result.exitCode);
}
