/** Building the session's feature runtime and tools, at construction and on reload. */

import type { AgentTool } from "@octocodeai/octocode-agent-core";
import { resetApiProviders } from "@octocodeai/octocode-ai/compat";
import { FeatureHost, type ToolDefinition } from "../features/index.ts";
import { emitSessionShutdownEvent } from "../features/runner.ts";
import { ModelRegistry } from "../model-registry.ts";
import { applyProviderVisibility } from "../provider-models.ts";
import { applyProviderSources } from "../provider-sources/index.ts";
import { defaultToolNames } from "../native-tools.ts";
import { applyToolModifiers } from "../settings-manager.ts";
import { createBashToolDefinition } from "../tools/index.ts";
import { createToolDefinitionFromAgentTool } from "../tools/tool-definition-wrapper.ts";
import type { ModeBindings } from "./mode-bindings.ts";
import type { SessionInternals } from "./host.ts";
import type { SessionToolLoadout } from "./tool-loadout.ts";

export interface FeatureRuntimeHost extends Pick<SessionInternals, "session" | "cwd"> {
	readonly tools: SessionToolLoadout;
	readonly bindings: ModeBindings;
	readonly baseToolsOverride: Record<string, AgentTool> | undefined;
	readonly featureHostRef: { current?: FeatureHost } | undefined;
	readonly usesDefaultTools: boolean;
	readonly defaultToolModifiers: string[];
	setFeatureHost(runner: FeatureHost): void;
	syncQueueModesFromSettings(): void;
}

export interface BuildRuntimeOptions {
	activeToolNames?: string[];
	includeAllFeatureTools?: boolean;
}

export function buildFeatureRuntime(host: FeatureRuntimeHost, options: BuildRuntimeOptions): void {
	const { session, tools } = host;
	const shellCommandPrefix = session.settingsManager.getShellCommandPrefix();
	const shellPath = session.settingsManager.getShellPath();
	const featuresResult = session.resourceLoader.getFeatures();
	const hasNativeTools = featuresResult.features.some((feature) => feature.sourceInfo.owner === "native");
	const baseToolDefinitions = host.baseToolsOverride
		? Object.fromEntries(
				Object.entries(host.baseToolsOverride).map(([name, tool]) => [name, createToolDefinitionFromAgentTool(tool)]),
			)
		: hasNativeTools
			? {}
			: {
					bash: createBashToolDefinition(host.cwd, {
						commandPrefix: shellCommandPrefix,
						shellPath,
						maxOutputBytes: session.settingsManager.getBashOutputMaxBytes(),
						spillMaxBytes: session.settingsManager.getBashSpillMaxBytes(),
					}),
				};

	tools.setBaseToolDefinitions(
		new Map(Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition])),
	);

	const runner = new FeatureHost(
		featuresResult.features,
		featuresResult.runtime,
		host.cwd,
		session.sessionManager,
		new ModelRegistry(session.modelRuntime),
	);
	host.setFeatureHost(runner);
	if (host.featureHostRef) {
		host.featureHostRef.current = runner;
	}
	host.bindings.bindCore(runner);
	host.bindings.apply(runner);

	const defaultActiveToolNames = host.baseToolsOverride
		? Object.keys(host.baseToolsOverride)
		: defaultToolNames(featuresResult.features);
	const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
	tools.refresh({
		activeToolNames: baseActiveToolNames,
		includeAllFeatureTools: options.includeAllFeatureTools,
	});
}

export async function reloadFeatureRuntime(
	host: FeatureRuntimeHost,
	options?: { beforeSessionStart?: () => void | Promise<void> },
): Promise<void> {
	const { session, tools } = host;
	const oldRunner = session.featureHost;
	await emitSessionShutdownEvent(oldRunner, {
		type: "session_shutdown",
		reason: "reload",
	});
	oldRunner.invalidate();
	const policyRequestedTools = tools.resetToolPolicy();
	const getDefaultTools = () =>
		host.usesDefaultTools
			? applyToolModifiers(
					session.settingsManager.getDefaultTools(defaultToolNames(session.resourceLoader.getFeatures().features)) ??
						defaultToolNames(session.resourceLoader.getFeatures().features),
					host.defaultToolModifiers,
				)
			: [];
	const previousDefaultTools = new Set(getDefaultTools());
	await session.settingsManager.reload();
	applyProviderVisibility(session.modelRuntime, session.settingsManager);
	await applyProviderSources(session.modelRuntime, session.settingsManager.getProviderSources());
	host.syncQueueModesFromSettings();
	resetApiProviders();
	await session.resourceLoader.reload();
	// Activate tools newly added to defaultTools. Removed ones stay active, and tools disabled
	// during the session stay disabled unless the setting newly adds them.
	const addedDefaultTools = getDefaultTools().filter((name) => !previousDefaultTools.has(name));
	// Tools the new features register later, such as MCP tools, are pending until then.
	tools.markActiveToolsPending();
	buildFeatureRuntime(host, {
		activeToolNames: [...policyRequestedTools, ...addedDefaultTools],
		includeAllFeatureTools: true,
	});

	if (host.bindings.hasBindings) {
		await options?.beforeSessionStart?.();
		await session.featureHost.emit({
			type: "session_start",
			reason: "reload",
		});
		session.featureHost.reportUnhandledMcpServers();
		await host.bindings.extendResourcesFromFeatures("reload");
	}
}
