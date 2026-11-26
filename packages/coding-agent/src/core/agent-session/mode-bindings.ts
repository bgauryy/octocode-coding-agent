/**
 * How the session binds a feature runner: the mode bindings (UI, command actions, abort,
 * shutdown and error handlers), the core actions features call, and resources features discover.
 */

import { basename, dirname } from "node:path";
import type { AgentToolCallOutcome } from "@octocodeai/octocode-agent-core";
import type {
	ExecuteToolOptions,
	CommandActions,
	FeatureErrorListener,
	UiMode,
	FeatureHost,
	SessionUI,
	ShutdownHandler,
} from "../features/index.ts";
import { validateCompactionInstructions } from "../compaction/manual-options.ts";
import { sameItems } from "../features/runner/registrations.ts";
import { getPromptCommands } from "../prompt-templates.ts";
import type { ResourceFeaturePaths } from "../resource-loader/types.ts";
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
import { cacheWarmingReport } from "../cache-warmer/report.ts";
import type { ModeBindingOptions } from "./types.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

export interface ModeBindingsHost extends Pick<SessionInternals, "session" | "run" | "cwd" | "emit"> {
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

function getFeatureSourceLabel(source: string): string {
	if (isSyntheticPath(source)) {
		return `extension:${source.replace(/[<>]/g, "")}`;
	}
	const base = basename(source);
	const name = base.replace(/\.(ts|js)$/, "");
	return `extension:${name}`;
}

function buildFeatureResourcePaths(entries: Array<{ path: string; source: string }>): Array<{
	path: string;
	metadata: {
		source: string;
		scope: "temporary";
		origin: "top-level";
		baseDir?: string;
	};
}> {
	return entries.map((entry) => {
		const source = getFeatureSourceLabel(entry.source);
		const baseDir = isSyntheticPath(entry.source) ? undefined : dirname(entry.source);
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

export class ModeBindings {
	private _uiContext?: SessionUI;
	private _mode: UiMode = "print";
	private _commandContextActions?: CommandActions;
	private _abortHandler?: () => void;
	private _shutdownHandler?: ShutdownHandler;
	private _errorListener?: FeatureErrorListener;
	private _errorUnsubscriber?: () => void;

	private readonly host: ModeBindingsHost;

	constructor(host: ModeBindingsHost) {
		this.host = host;
	}

	/** Whether a mode bound features, so a reload starts the reloaded features. */
	get hasBindings(): boolean {
		return !!(this._uiContext ?? this._commandContextActions ?? this._shutdownHandler ?? this._errorListener);
	}

	/** Keep the given bindings; omitted ones keep their current value. */
	update(bindings: ModeBindingOptions): void {
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

	apply(runner: FeatureHost): void {
		runner.setUIContext(this._uiContext, this._mode);
		runner.bindCommandContext(this._commandContextActions);

		this._errorUnsubscriber?.();
		this._errorUnsubscriber = this._errorListener ? runner.onError(this._errorListener) : undefined;
	}

	async extendResourcesFromFeatures(reason: "startup" | "reload"): Promise<void> {
		const { session } = this.host;
		if (!session.featureHost.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await session.featureHost.emitResourcesDiscover(
			this.host.cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const featurePaths: ResourceFeaturePaths = {
			skillPaths: buildFeatureResourcePaths(skillPaths),
			promptPaths: buildFeatureResourcePaths(promptPaths),
			themePaths: buildFeatureResourcePaths(themePaths),
		};

		session.resourceLoader.extendResources(featurePaths);
		this.host.tools.rebuildSystemPrompt(session.getActiveToolNames());
	}

	bindCore(runner: FeatureHost): void {
		const { session, run, tools, models } = this.host;
		// Read on every editor render (skill-word highlight): rebuilt only when a command, prompt or skill list changes.
		let built: { inputs: unknown[]; commands: SlashCommandInfo[] } | undefined;
		const getCommands = (): SlashCommandInfo[] => {
			const inputs = [
				runner.getRegisteredCommands(),
				session.promptTemplates,
				...session.promptTemplates,
				session.resourceLoader.getSkills().skills,
				...session.resourceLoader.getSkills().skills,
			];
			if (!built || !sameItems(built.inputs, inputs)) built = { inputs, commands: buildCommands() };
			return [...built.commands];
		};
		const buildCommands = (): SlashCommandInfo[] => {
			const featureCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
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
				...(skill.triggers ? { triggers: skill.triggers } : {}),
			}));

			return [...featureCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					const sending = session.sendCustomMessage(message, options);
					void sending.catch((err) => {
						runner.emitError({
							source: "<runtime>",
							event: "send_message",
							error: errorMessage(err),
						});
					});
					return sending;
				},
				sendUserMessage: (content, options) => {
					session.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							source: "<runtime>",
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
				getHiddenDeclarations: () => [...tools.hiddenDeclarations()],
				getAllTools: () => session.getAllTools(),
				getSettings: () => session.settingsManager.getSettings(),
				// A feature's own loadout is a span boundary: held tools do not defer it, so it reaches the next request whole.
				setActiveTools: (toolNames, options) => {
					if (options?.boundary) tools.held.releaseNext();
					session.setActiveToolsByName(toolNames);
				},
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
					if (run.active) run.featureRunAbortRequested = true;
					if (this._abortHandler && reason === "interrupted") {
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
				getCacheWarmingReport: () => cacheWarmingReport(session),
				compact: (options) => {
					const work = (async () => {
						try {
							const result = await session.compact({
								customInstructions: options?.customInstructions,
								...(options?.requestedBy ? { requestedBy: options.requestedBy } : {}),
							});
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})().finally(() => run.settledWork.delete(work));
					run.settledWork.add(work);
				},
				requestBoundaryCompaction: (options) => {
					const text = validateCompactionInstructions(options?.customInstructions);
					if (run.active)
						run.boundaryCompaction = { focus: text ? { text, source: options?.requestedBy ?? "agent" } : undefined };
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
			},
		);
	}
}
