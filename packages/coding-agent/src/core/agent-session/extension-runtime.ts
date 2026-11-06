/** Building the session's extension runtime and tools, at construction and on reload. */

import type { AgentTool } from "@octocodeai/octocode-agent-core";
import { resetApiProviders } from "@octocodeai/octocode-ai/compat";
import { ExtensionRunner, type ToolDefinition } from "../features/index.ts";
import { emitSessionShutdownEvent } from "../features/runner.ts";
import { ModelRegistry } from "../model-registry.ts";
import { defaultToolNames } from "../native-tools.ts";
import { applyToolModifiers } from "../settings-manager.ts";
import { createBashToolDefinition } from "../tools/index.ts";
import { createToolDefinitionFromAgentTool } from "../tools/tool-definition-wrapper.ts";
import type { SessionExtensionBindings } from "./extension-bindings.ts";
import type { SessionInternals } from "./host.ts";
import type { SessionToolLoadout } from "./tool-loadout.ts";

export interface ExtensionRuntimeHost extends Pick<SessionInternals, "session" | "cwd"> {
	readonly tools: SessionToolLoadout;
	readonly bindings: SessionExtensionBindings;
	readonly baseToolsOverride: Record<string, AgentTool> | undefined;
	readonly extensionRunnerRef: { current?: ExtensionRunner } | undefined;
	readonly usesDefaultTools: boolean;
	readonly defaultToolModifiers: string[];
	/** Make `runner` the session's extension runner. */
	setExtensionRunner(runner: ExtensionRunner): void;
	syncQueueModesFromSettings(): void;
}

export interface BuildRuntimeOptions {
	activeToolNames?: string[];
	includeAllExtensionTools?: boolean;
}

export function buildExtensionRuntime(host: ExtensionRuntimeHost, options: BuildRuntimeOptions): void {
	const { session, tools } = host;
	const shellCommandPrefix = session.settingsManager.getShellCommandPrefix();
	const shellPath = session.settingsManager.getShellPath();
	const extensionsResult = session.resourceLoader.getExtensions();
	const hasNativeTools = extensionsResult.extensions.some((extension) => extension.sourceInfo.owner === "native");
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

	const runner = new ExtensionRunner(
		extensionsResult.extensions,
		extensionsResult.runtime,
		host.cwd,
		session.sessionManager,
		new ModelRegistry(session.modelRuntime),
	);
	host.setExtensionRunner(runner);
	if (host.extensionRunnerRef) {
		host.extensionRunnerRef.current = runner;
	}
	host.bindings.bindCore(runner);
	host.bindings.apply(runner);

	const defaultActiveToolNames = host.baseToolsOverride
		? Object.keys(host.baseToolsOverride)
		: defaultToolNames(extensionsResult.extensions);
	const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
	tools.refresh({
		activeToolNames: baseActiveToolNames,
		includeAllExtensionTools: options.includeAllExtensionTools,
	});
}

export async function reloadExtensionRuntime(
	host: ExtensionRuntimeHost,
	options?: { beforeSessionStart?: () => void | Promise<void> },
): Promise<void> {
	const { session, tools } = host;
	const oldRunner = session.extensionRunner;
	await emitSessionShutdownEvent(oldRunner, {
		type: "session_shutdown",
		reason: "reload",
	});
	oldRunner.invalidate();
	const policyRequestedTools = tools.resetToolPolicy();
	const getDefaultTools = () =>
		host.usesDefaultTools
			? applyToolModifiers(
					session.settingsManager.getDefaultTools(
						defaultToolNames(session.resourceLoader.getExtensions().extensions),
					) ?? defaultToolNames(session.resourceLoader.getExtensions().extensions),
					host.defaultToolModifiers,
				)
			: [];
	const previousDefaultTools = new Set(getDefaultTools());
	await session.settingsManager.reload();
	host.syncQueueModesFromSettings();
	resetApiProviders();
	await session.resourceLoader.reload();
	// Activate tools newly added to defaultTools. Removed ones stay active, and tools disabled
	// during the session stay disabled unless the setting newly adds them.
	const addedDefaultTools = getDefaultTools().filter((name) => !previousDefaultTools.has(name));
	// Tools the new extensions register later, such as MCP tools, are pending until then.
	tools.markActiveToolsPending();
	buildExtensionRuntime(host, {
		activeToolNames: [...policyRequestedTools, ...addedDefaultTools],
		includeAllExtensionTools: true,
	});

	if (host.bindings.hasBindings) {
		await options?.beforeSessionStart?.();
		await session.extensionRunner.emit({
			type: "session_start",
			reason: "reload",
		});
		session.extensionRunner.reportUnhandledMcpServers();
		await host.bindings.extendResourcesFromExtensions("reload");
	}
}
