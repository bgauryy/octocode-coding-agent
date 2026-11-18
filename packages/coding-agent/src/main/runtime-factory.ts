import { existsSync } from "node:fs";
import { deadline } from "@octocodeai/octocode-common/deadline";
import type { Args } from "../cli/args.ts";
import type {
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
} from "../core/agent-session-runtime.ts";
import type { SessionStartEvent } from "../core/features/index.ts";
import type { SessionManager } from "../core/session-manager.ts";
import {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	createAgentSessionServices,
} from "../core/agent-session-services.ts";
import { createSessionFromServices } from "../core/agent-session/create-session.ts";
import { warningsBesideListing } from "../core/resource-loader/feature-loading.ts";
import { resolveModelScope, unattendedUseNotice } from "../core/model-resolver.ts";
import type { FolderTrustResolver } from "../core/folder-trust.ts";
import type { NativeFeatureSet } from "../core/resource-loader/types.ts";
import type { SkillResourceSnapshot } from "../core/skill-resource-snapshot.ts";
import { collectSettingsDiagnostics } from "../core/settings-diagnostics.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { isLocalPath } from "@octocodeai/octocode-common/paths";
import { setPlanStartup } from "../octocode/plan/startup.ts";
import { recordOperatorLimits } from "../octocode/subagents/process/operator-limits.ts";
import { applyRunConfiguration } from "./run-configuration.ts";
import { missingCliPathWarnings } from "./cli-path-warnings.ts";
import { buildSessionOptions, resolveCliPaths } from "./session-options.ts";
import type { AppMode } from "./startup.ts";

/** What the CLI runtime factory needs from `main()`. */
export interface CliRuntimeFactoryOptions {
	parsed: Args;
	/** The startup cwd that relative CLI resource paths resolve against. */
	cwd: string;
	/** The stored folder-trust decision (`octocode/trust/port.ts`): the factory never asks and never records. */
	folderTrust: FolderTrustResolver;
	/**
	 * True for a run that opens a session: a folder that is not trusted then throws before any project file is read. False
	 * for `--help` and `--list-models`, which run without a session and load global configuration only.
	 */
	requireTrust: boolean;
	/** The current app mode; piped stdin can switch interactive startup to print after the factory is created. */
	getAppMode(): AppMode;
	/** This process serves an ACP client's session (`--mode acp` started it as a worker): no one watches it either. */
	acpWorker?: boolean;
	skillResourceSnapshot: SkillResourceSnapshot | undefined;
	/** The native feature set every runtime registers; a CLI session never runs without it. */
	nativeFeatures: NativeFeatureSet;
}

/** Create the factory that builds each CLI runtime, initially and after session switches. */
export function createCliRuntimeFactory(options: CliRuntimeFactoryOptions): CreateAgentSessionRuntimeFactory {
	const { parsed, cwd, folderTrust, requireTrust, getAppMode, acpWorker, skillResourceSnapshot, nativeFeatures } =
		options;
	// Without the native set a session would run with no permission checks or native tools: refuse to build one.
	if (!nativeFeatures) throw new Error("createCliRuntimeFactory needs the native feature set (nativeFeatures).");

	const resolvedSkillPaths = resolveCliPaths(cwd, parsed.skills);
	const resolvedPromptTemplatePaths = resolveCliPaths(cwd, parsed.promptTemplates);
	const resolvedThemePaths = resolveCliPaths(cwd, parsed.themes);
	recordOperatorLimits(parsed);
	setPlanStartup(parsed.plan === true);
	// The runtime that receives these services releases them when it replaces or disposes them; a creation that fails
	// after building them releases them here.
	return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		// The startup gate decided the first folder before this runs. A session switch into another folder lands here
		// without a gate: it must already be trusted, and nothing of an untrusted folder is read.
		const trust = folderTrust(cwd);
		const projectTrusted = trust.state === "trusted";
		if (!projectTrusted && requireTrust)
			throw new Error(
				`${cwd} is not trusted, so Octocode did not open it. Run octocode in that folder to decide, or: octocode trust add ${cwd}`,
			);
		const runtimeSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
		// The run's own configuration goes onto this manager before tools and resources load from it.
		await applyRunConfiguration(parsed, { cwd, agentDir, settings: runtimeSettingsManager, projectTrusted });
		const loading = deadline(15_000);
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager: runtimeSettingsManager,
			modelRuntimeSignal: loading.signal,
			resourceLoaderOptions: {
				skillResourceSnapshot,
				nativeFeatures,
				additionalSkillPaths: resolvedSkillPaths,
				additionalPromptTemplatePaths: resolvedPromptTemplatePaths,
				additionalThemePaths: resolvedThemePaths,
				disabledFeatures: parsed.noMcp ? ["mcp"] : undefined,
				noSkills: parsed.noSkills,
				noPromptTemplates: parsed.noPromptTemplates,
				noThemes: parsed.noThemes,
				// Project instructions load from the trust grant's folder down to the working folder, and only when trusted.
				noContextFiles: parsed.noContextFiles || !projectTrusted,
				contextRoot: trust.root,
				systemPrompt: parsed.systemPrompt,
				appendSystemPrompt: parsed.appendSystemPrompt,
			},
		}).finally(loading.clear);
		try {
			return await createCliRuntime(services, sessionManager, sessionStartEvent);
		} catch (error) {
			services.dispose?.();
			throw error;
		}
	};
	async function createCliRuntime(
		services: AgentSessionServices,
		sessionManager: SessionManager,
		sessionStartEvent: SessionStartEvent | undefined,
	): Promise<CreateAgentSessionRuntimeResult> {
		const { settingsManager, modelRuntime, resourceLoader } = services;
		const diagnostics: AgentSessionRuntimeDiagnostic[] = [
			...services.diagnostics,
			// A path the user passed with `--skill` that is not there loads nothing: say so, and carry on.
			...(skillResourceSnapshot
				? []
				: (resolvedSkillPaths ?? [])
						.filter((path) => isLocalPath(path) && !existsSync(path))
						.map((path) => ({
							type: "warning" as const,
							message: `--skill path does not exist: ${path}. No skill was loaded from it.`,
						}))),
			...missingCliPathWarnings("--prompt-template", "prompt template", resolvedPromptTemplatePaths),
			...missingCliPathWarnings("--theme", "theme", resolvedThemePaths),
			...collectSettingsDiagnostics(settingsManager),
			...resourceLoader.getFeatures().errors.map(({ path, error }) => ({
				type: "error" as const,
				message: `Failed to register feature "${path}": ${error}`,
			})),
			// The interactive listing names code that is not loaded in its own row; the other modes have only this line.
			...(getAppMode() === "interactive"
				? warningsBesideListing(resourceLoader.getFeatures().warnings)
				: (resourceLoader.getFeatures().warnings ?? [])
			).map(({ path, warning }) => ({
				type: "warning" as const,
				message: `${path}: ${warning}`,
			})),
		];

		const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
		const scopeLimit = deadline(15_000);
		const scopedModels = await (
			modelPatterns && modelPatterns.length > 0
				? resolveModelScope(modelPatterns, modelRuntime, { signal: scopeLimit.signal })
				: Promise.resolve([])
		).finally(scopeLimit.clear);
		const { options: sessionOptions, diagnostics: sessionOptionDiagnostics } = buildSessionOptions(
			parsed,
			scopedModels,
			sessionManager.buildSessionContext().messages.length > 0,
			modelRuntime,
			settingsManager,
		);
		diagnostics.push(...sessionOptionDiagnostics);

		if (parsed.apiKey) {
			if (!sessionOptions.model) {
				diagnostics.push({
					type: "error",
					message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
				});
			} else {
				await modelRuntime.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
			}
		}

		// Print mode and an ACP server's session run unattended: the vendor of an interactive-only plan does not allow them.
		const unattended = acpWorker === true || getAppMode() === "print" || getAppMode() === "json";
		const created = await createSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			unattended,
			model: sessionOptions.model,
			thinkingLevel: sessionOptions.thinkingLevel,
			scopedModels: sessionOptions.scopedModels,
			tools: sessionOptions.tools,
			excludeTools: sessionOptions.excludeTools,
			noTools: sessionOptions.noTools,
			customTools: sessionOptions.customTools,
		});
		const chosen = created.session.model;
		const notice = unattended && chosen ? unattendedUseNotice(chosen, modelRuntime) : undefined;
		if (notice) diagnostics.push({ type: "warning", message: notice });

		return {
			...created,
			services,
			diagnostics,
		};
	}
}
