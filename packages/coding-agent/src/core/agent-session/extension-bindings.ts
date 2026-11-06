/**
 * How the session binds an extension runner: the mode bindings (UI, command actions, abort,
 * shutdown and error handlers), the core actions extensions call, and resources extensions discover.
 */

import { basename, dirname } from "node:path";
import type { AgentToolCallOutcome } from "@octocodeai/octocode-agent-core";
import type {
	ExecuteToolOptions,
	ExtensionCommandContextActions,
	ExtensionErrorListener,
	ExtensionMode,
	ExtensionRunner,
	ExtensionUIContext,
	ShutdownHandler,
} from "../features/index.ts";
import { getPromptCommands } from "../prompt-templates.ts";
import type { ResourceExtensionPaths } from "../resource-loader/types.ts";
import { captureSkillResourceSnapshot } from "../skill-resource-snapshot.ts";
import { getSkillCommands } from "../skill-commands.ts";
import { loadedSkillDirectories } from "../skills.ts";
import type { SlashCommandInfo } from "../slash-commands.ts";
import { isSyntheticPath } from "../source-info.ts";
import type { AbortReason, SessionInternals } from "./host.ts";
import { recordRunFailure } from "./run-outcome.ts";
import type { SessionInputQueue } from "./input-queue.ts";
import type { SessionModelControl } from "./model-control.ts";
import type { SessionToolLoadout } from "./tool-loadout.ts";
import type { ExtensionBindings } from "./types.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

export interface ExtensionBindingsHost extends Pick<SessionInternals, "session" | "run" | "cwd" | "emit"> {
	readonly tools: SessionToolLoadout;
	readonly models: SessionModelControl;
	readonly inputs: Pick<
		SessionInputQueue,
		"hasWaitingCustomMessages" | "isCustomMessageQueued" | "replaceQueuedCustomMessage"
	>;
	readonly defaultToolModifiers: readonly string[];
	recordAbortReason(reason: AbortReason): void;
	executeNestedToolCall(
		parentToolCallId: string,
		name: string,
		args: unknown,
		options: ExecuteToolOptions,
	): Promise<AgentToolCallOutcome>;
}

function getExtensionSourceLabel(extensionPath: string): string {
	if (isSyntheticPath(extensionPath)) {
		return `extension:${extensionPath.replace(/[<>]/g, "")}`;
	}
	const base = basename(extensionPath);
	const name = base.replace(/\.(ts|js)$/, "");
	return `extension:${name}`;
}

function buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
	path: string;
	metadata: {
		source: string;
		scope: "temporary";
		origin: "top-level";
		baseDir?: string;
	};
}> {
	return entries.map((entry) => {
		const source = getExtensionSourceLabel(entry.extensionPath);
		const baseDir = isSyntheticPath(entry.extensionPath) ? undefined : dirname(entry.extensionPath);
		return {
			path: entry.path,
			metadata: {
				source,
				scope: "temporary",
				origin: "top-level",
				baseDir,
			},
		};
	});
}

export class SessionExtensionBindings {
	private _uiContext?: ExtensionUIContext;
	private _mode: ExtensionMode = "print";
	private _commandContextActions?: ExtensionCommandContextActions;
	private _abortHandler?: () => void;
	private _shutdownHandler?: ShutdownHandler;
	private _errorListener?: ExtensionErrorListener;
	private _errorUnsubscriber?: () => void;

	private readonly host: ExtensionBindingsHost;

	constructor(host: ExtensionBindingsHost) {
		this.host = host;
	}

	/** Whether a mode bound extensions, so a reload starts the reloaded extensions. */
	get hasBindings(): boolean {
		return !!(this._uiContext ?? this._commandContextActions ?? this._shutdownHandler ?? this._errorListener);
	}

	/** Keep the given bindings; omitted ones keep their current value. */
	update(bindings: ExtensionBindings): void {
		if (bindings.uiContext !== undefined) {
			this._uiContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this._mode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this._commandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._abortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._shutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._errorListener = bindings.onError;
		}
	}

	apply(runner: ExtensionRunner): void {
		runner.setUIContext(this._uiContext, this._mode);
		runner.bindCommandContext(this._commandContextActions);

		this._errorUnsubscriber?.();
		this._errorUnsubscriber = this._errorListener ? runner.onError(this._errorListener) : undefined;
	}

	async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		const { session } = this.host;
		if (!session.extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await session.extensionRunner.emitResourcesDiscover(
			this.host.cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: buildExtensionResourcePaths(skillPaths),
			promptPaths: buildExtensionResourcePaths(promptPaths),
			themePaths: buildExtensionResourcePaths(themePaths),
		};

		session.resourceLoader.extendResources(extensionPaths);
		this.host.tools.rebuildSystemPrompt(session.getActiveToolNames());
	}

	bindCore(runner: ExtensionRunner): void {
		const { session, run, tools, models } = this.host;
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				...(command.argumentHint && { argumentHint: command.argumentHint }),
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = getPromptCommands(
				session.promptTemplates,
				runner.getRegisteredCommands(),
			).map(({ template, name }) => ({
				name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = getSkillCommands(session.resourceLoader.getSkills().skills, [
				...runner.getRegisteredCommands(),
				...session.promptTemplates,
			]).map(({ skill, name }) => ({
				name,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					const sending = session.sendCustomMessage(message, options);
					void sending.catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: errorMessage(err),
						});
					});
					return sending;
				},
				sendUserMessage: (content, options) => {
					session.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: errorMessage(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					const entryId = session.sessionManager.appendCustomEntry(customType, data);
					const entry = session.sessionManager.getEntry(entryId);
					if (entry) {
						this.host.emit({ type: "entry_appended", entry });
					}
				},
				setSessionName: (name, source) => {
					session.setSessionName(name, source);
				},
				getSessionName: () => {
					return session.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					const id = session.sessionManager.appendLabelChange(entryId, label);
					const entry = session.sessionManager.getEntry(id);
					if (entry) this.host.emit({ type: "entry_appended", entry });
				},
				getActiveTools: () => session.getActiveToolNames(),
				getHiddenDeclarations: () => [...tools.hiddenDeclarations],
				getAllTools: () => session.getAllTools(),
				getSettings: () => session.settingsManager.getSettings(),
				setActiveTools: (toolNames) => session.setActiveToolsByName(toolNames),
				selectsTools: (prefix, activeByDefault) =>
					tools.selectsTools(prefix, activeByDefault, [
						...this.host.defaultToolModifiers,
						...(session.settingsManager.getSettings().defaultTools ?? []),
					]),
				setToolPolicy: (allows) => tools.setToolPolicy(allows),
				refreshTools: () => tools.refresh(),
				getCommands,
				getSkillDirectories: () => loadedSkillDirectories(session.resourceLoader.getSkills()),
				getSkillResourceSnapshot: (names) =>
					captureSkillResourceSnapshot(session.resourceLoader.getSkills(), names, getCommands()),
				setModel: async (model) => {
					if (!session.modelRuntime.hasConfiguredAuth(model.provider)) return false;
					await session.setModel(model);
					return true;
				},
				getThinkingLevel: () => session.thinkingLevel,
				setThinkingLevel: (level) => session.setThinkingLevel(level),
			},
			{
				onUsageRecorded: (entry) => this.host.emit({ type: "entry_appended", entry }),
				getModel: () => session.model,
				getScopedModels: () => models.scopedModels,
				getExplicitToolNames: () => tools.explicitToolNames(this.host.defaultToolModifiers),
				isIdle: () => session.isIdle,
				isProjectTrusted: () => session.settingsManager.isProjectTrusted(),
				getSignal: () => session.agent.signal ?? (run.isBeforeSettle ? run.beforeSettleAbort.signal : undefined),
				getTurnId: () => run.logicalTurnId,
				abort: (reason = "interrupted") => {
					this.host.recordAbortReason(reason);
					if (run.active) run.extensionRunAbortRequested = true;
					if (this._abortHandler) {
						this._abortHandler();
						return;
					}
					void session.abort(reason);
				},
				failRun: (reason) => {
					if (run.active) recordRunFailure(run.outcome, reason);
				},
				hasPendingMessages: () => session.pendingMessageCount > 0 || this.host.inputs.hasWaitingCustomMessages,
				isMessageQueued: (details) => this.host.inputs.isCustomMessageQueued(details),
				replaceQueuedMessage: (details, content) => this.host.inputs.replaceQueuedCustomMessage(details, content),
				shutdown: () => {
					this._shutdownHandler?.();
				},
				getContextUsage: () => session.getContextUsage(),
				compact: (options) => {
					const work = (async () => {
						try {
							const result = await session.compact({ customInstructions: options?.customInstructions });
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})().finally(() => run.settledWork.delete(work));
					run.settledWork.add(work);
				},
				getSystemPrompt: () => session.systemPrompt,
				getSystemPromptOptions: () => tools.baseSystemPromptOptions,
				executeTool: (callerId, name, args, options) => this.host.executeNestedToolCall(callerId, name, args, options),
				getCallableTools: () => tools.getCallableTools(),
			},
			{
				registerProvider: (name, config) => {
					session.modelRuntime.registerProvider(name, config);
					models.refreshCurrentModelFromRegistry();
				},
				registerNativeProvider: (provider) => {
					session.modelRuntime.registerNativeProvider(provider);
					models.refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					session.modelRuntime.unregisterProvider(name);
					models.refreshCurrentModelFromRegistry();
				},
				registerVirtualModel: (definition) => {
					session.modelRuntime.registerVirtualModel(definition);
					models.refreshCurrentModelFromRegistry();
				},
				unregisterVirtualModel: (provider, id) => {
					session.modelRuntime.unregisterVirtualModel(provider, id);
					models.refreshCurrentModelFromRegistry();
				},
			},
		);
	}
}
