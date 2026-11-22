import { join } from "node:path";
import { getAgentDir, providerFallbackDirs } from "../config.ts";
import { prepareAgentDb } from "../storage/database.ts";
import { modelsFileHoldsLiteralKey } from "./models-json-keys.ts";
import { resolvePath } from "@octocodeai/octocode-common/paths";
import { ModelRuntime } from "./model-runtime.ts";
import { DefaultResourceLoader, type DefaultResourceLoaderOptions, type ResourceLoader } from "./resource-loader.ts";
import { SettingsManager } from "./settings-manager.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { checkAuthFileSafety } from "./auth-storage/file-safety.ts";
import { applyProviderVisibility } from "./provider-models.ts";
import { providerSourceGate } from "./provider-sources/gate.ts";

/**
 * Non-fatal issues collected while creating services or sessions.
 *
 * Runtime creation returns diagnostics to the caller instead of printing or
 * exiting. The app layer decides whether warnings should be shown and whether
 * errors should abort startup.
 */
export interface AgentSessionRuntimeDiagnostic {
	type: "info" | "warning" | "error";
	message: string;
}

/**
 * Inputs for creating cwd-bound runtime services.
 *
 * These services are recreated whenever the effective session cwd changes.
 * CLI-provided resource paths should be resolved to absolute paths before they
 * reach this function, so later cwd switches do not reinterpret them.
 */
export interface CreateAgentSessionServicesOptions {
	cwd: string;
	agentDir?: string;
	settingsManager?: SettingsManager;
	modelRuntime?: ModelRuntime;
	modelRuntimeSignal?: AbortSignal;
	resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
}

/**
 * Coherent cwd-bound runtime services for one effective session cwd.
 *
 * This is infrastructure only. The AgentSession itself is created separately so
 * session options can be resolved against these services first.
 */
export interface AgentSessionServices {
	cwd: string;
	agentDir: string;
	modelRuntime: ModelRuntime;
	settingsManager: SettingsManager;
	resourceLoader: ResourceLoader;
	diagnostics: AgentSessionRuntimeDiagnostic[];
	/**
	 * Release what these services created: the model runtime's credential watcher when `createAgentSessionServices`
	 * built the runtime (a runtime passed in stays with its owner). The host calls it once the services are replaced.
	 */
	dispose?(): void;
}

/**
 * Create cwd-bound runtime services.
 *
 * Returns services plus diagnostics. It does not create an AgentSession.
 */
export async function createAgentSessionServices(
	options: CreateAgentSessionServicesOptions,
): Promise<AgentSessionServices> {
	await prepareAgentDb(process.env, options.modelRuntimeSignal);
	const cwd = resolvePath(options.cwd);
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getAgentDir();
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	// Before the runtime loads credentials and models.json, so the first availability pass already honours the sources.
	providerSourceGate.set(settingsManager.getProviderSources());
	const modelRuntime =
		options.modelRuntime ??
		(await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			signal: options.modelRuntimeSignal,
		}));
	try {
		applyProviderVisibility(modelRuntime, settingsManager);
		const resourceLoader = new DefaultResourceLoader({
			...options.resourceLoaderOptions,
			cwd,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();

		const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
		if (!options.modelRuntime) {
			const dirs = [agentDir, ...providerFallbackDirs(agentDir)];
			const keyFiles = [
				...dirs.map((dir) => join(dir, "auth.json")),
				...dirs.map((dir) => join(dir, "models.json")).filter(modelsFileHoldsLiteralKey),
			];
			for (const file of keyFiles) {
				diagnostics.push(...checkAuthFileSafety(file).map((message) => ({ type: "warning" as const, message })));
			}
			for (const message of modelRuntime.getConfigWarnings()) diagnostics.push({ type: "warning", message });
		}
		const featuresResult = resourceLoader.getFeatures();
		for (const { name, config, source } of featuresResult.runtime.pendingProviderRegistrations) {
			try {
				modelRuntime.registerProvider(name, config);
			} catch (error) {
				const message = errorMessage(error);
				diagnostics.push({
					type: "error",
					message: `Feature "${source}" error: ${message}`,
				});
			}
		}
		featuresResult.runtime.pendingProviderRegistrations = [];
		for (const { provider, source } of featuresResult.runtime.pendingNativeProviderRegistrations) {
			try {
				modelRuntime.registerNativeProvider(provider);
			} catch (error) {
				const message = errorMessage(error);
				diagnostics.push({
					type: "error",
					message: `Feature "${source}" error: ${message}`,
				});
			}
		}
		featuresResult.runtime.pendingNativeProviderRegistrations = [];
		await modelRuntime.refresh({ allowNetwork: false });
		if (!options.modelRuntime) {
			for (const message of modelRuntime.getMissingCredentialWarnings()) diagnostics.push({ type: "warning", message });
		}

		const ownsRuntime = !options.modelRuntime;
		return {
			cwd,
			agentDir,
			modelRuntime,
			settingsManager,
			resourceLoader,
			diagnostics,
			dispose: () => {
				if (ownsRuntime) modelRuntime.dispose();
			},
		};
	} catch (error) {
		if (!options.modelRuntime) modelRuntime.dispose();
		throw error;
	}
}
