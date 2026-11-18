/** Model and thinking-level selection of a session: setting, cycling, scoped models and routing limits. */

import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import {
	type AssistantMessage,
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Model,
	modelsAreEqual,
} from "@octocodeai/octocode-ai/compat";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "../defaults.ts";
import { findLatestResponse, getBranchSelection, isVirtualModel } from "../virtual-models.ts";
import type { SessionInternals } from "./host.ts";
import type { ModelCycleResult, ModelMutationOptions } from "./types.ts";
import { persistDefaultModel } from "./model-default.ts";
import { deadline } from "@octocodeai/octocode-common/deadline";
import { SessionContextCapacity } from "./context-capacity.ts";
export { workingContextTokens } from "./context-capacity.ts";

export type ScopedModel = { model: Model<any>; thinkingLevel?: ThinkingLevel };

type SetModelOptions = ModelMutationOptions & { source?: "set" | "fallback"; level?: ThinkingLevel; reason?: string };

export class SessionModelControl {
	scopedModels: ScopedModel[];
	private readonly context: SessionContextCapacity;
	/** The level this session last asked for, before clamping; a model switch carries it over. */
	private requested?: { sessionId: string; level: ThinkingLevel };

	private readonly host: Pick<SessionInternals, "session" | "emit">;

	constructor(
		host: Pick<SessionInternals, "session" | "emit">,
		scopedModels: ScopedModel[],
		requestedThinkingLevel?: ThinkingLevel,
	) {
		this.host = host;
		this.context = new SessionContextCapacity(host);
		this.scopedModels = scopedModels;
		if (requestedThinkingLevel) this.requested = { sessionId: this.sessionId(), level: requestedThinkingLevel };
	}
	private sessionId(): string {
		return this.host.session.sessionManager.getSessionId();
	}
	/** Record a selection unless the branch already implies it (what a resume restores), so a no-op adds nothing. */
	private recordModel(model: Model<any>): void {
		const { session } = this.host;
		const manager = session.sessionManager;
		const getModel = (provider: string, modelId: string) => session.modelRuntime.getModel(provider, modelId);
		const recorded = getBranchSelection(manager.getBranch(), getModel);
		if (recorded?.provider === model.provider && recorded.modelId === model.id) return;
		const entry = manager.getEntry(manager.appendModelChange(model.provider, model.id));
		if (entry) this.host.emit({ type: "entry_appended", entry });
	}

	private withContextBudget(model: Model<any>): Model<any> {
		return this.context.select(model);
	}

	applyContextBudget(): void {
		const { session } = this.host;
		if (session.model) session.agent.state.model = this.withContextBudget(session.model);
	}

	/** The effective capacity, before this session's smaller working budget. */
	getContextWindowLimit(): number | undefined {
		return this.context.limit();
	}

	setContextWindow(tokens?: number): number {
		return this.context.set(tokens);
	}

	observeContextCapacity(message: AssistantMessage): void {
		this.context.observe(message);
	}

	/**
	 * The model whose limits apply to `message`, or undefined when the message came from another
	 * model. Under a virtual selection, that is the physical model that produced it.
	 */
	modelForMessage(message: AssistantMessage): Model<any> | undefined {
		const { session } = this.host;
		const model = session.model;
		if (model && isVirtualModel(model)) return session.modelRuntime.getPhysicalModel(message.provider, message.model);
		return model?.provider === message.provider && model.id === message.model ? model : undefined;
	}

	/**
	 * Record the selection on the current branch when the branch implies another one, so a resume
	 * restores it. Tree navigation can leave the latest `model_change` on another branch; responses
	 * cannot record a virtual selection because they name physical models. Responses do record a
	 * physical selection unless the branch holds a virtual one; checking a physical selection against
	 * responses would record it on every prompt while `prepareRequest` redirects to another model, so a
	 * physical one is checked against the branch's last `model_change`: a session reopened with another
	 * model (a subagent resume, `--session X --model Y`) records it once, with its first prompt.
	 */
	recordSelection(): void {
		const { session } = this.host;
		const model = session.model;
		if (!model) return;
		const getModel = (provider: string, modelId: string) => session.modelRuntime.getModel(provider, modelId);
		const recorded = getBranchSelection(session.sessionManager.getBranch(), getModel);
		if (!recorded || (recorded.provider === model.provider && recorded.modelId === model.id)) return;
		const recordedModel = getModel(recorded.provider, recorded.modelId);
		if (!isVirtualModel(model) && !(recordedModel && isVirtualModel(recordedModel))) {
			const branch = session.sessionManager.getBranch();
			const change = branch.findLast((entry) => entry.type === "model_change");
			if (change?.type !== "model_change" || (change.provider === model.provider && change.modelId === model.id))
				return;
		}
		this.recordModel(model);
	}

	/** The model whose limits apply to the conversation. */
	limitsModel(): Model<any> | undefined {
		return this.host.session.routedModel?.model ?? this.host.session.model;
	}

	/** Under a virtual selection, the physical model and thinking level of the latest successful response. */
	routedModel(): { model: Model<any>; thinkingLevel?: ThinkingLevel } | undefined {
		const { session } = this.host;
		if (!session.model || !isVirtualModel(session.model)) return undefined;
		const latest = findLatestResponse(session.agent.state.messages);
		const model = latest && session.modelRuntime.getPhysicalModel(latest.provider, latest.model);
		return model && { model, thinkingLevel: latest?.thinkingLevel };
	}

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore" | "fallback",
		reason?: string,
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this.host.session.featureHost.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
			...(reason ? { reason } : {}),
		});
	}

	/** `fallback`: `retry.fallbackModels` replaces a failed model for `reason`, at `level` when the entry names one. */
	async setModel(model: Model<any>, options: SetModelOptions): Promise<void> {
		const limit = deadline(15_000);
		const authed = await this.host.session.modelRuntime
			.checkAuth(model.provider, { signal: limit.signal })
			.finally(limit.clear);
		if (!authed) throw new Error(`No usable credentials for ${model.provider}/${model.id}. Connect it in /providers.`);
		await this._switchTo(model, options, options.source ?? "set", options.level, options.reason);
	}

	/**
	 * Select `model` and the thinking level for it (see `_getThinkingLevelForModelSwitch`), clamped to the model. The
	 * switch neither rewrites the global thinking default nor replaces the level the session asked for.
	 */
	private async _switchTo(
		model: Model<any>,
		options: ModelMutationOptions,
		source: "set" | "cycle" | "fallback",
		explicitLevel?: ThinkingLevel,
		reason?: string,
	): Promise<Model<any>> {
		const { session } = this.host;
		const previousModel = session.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch(model, explicitLevel);
		const selectedModel = this.withContextBudget(model);
		session.agent.state.model = selectedModel;
		this.recordModel(model);
		this.applyThinkingLevel(thinkingLevel, false);
		await this._emitModelSelect(selectedModel, previousModel, source, reason);
		if (options.persist)
			await persistDefaultModel(
				session.settingsManager,
				model,
				options.scope === "project" ? undefined : this._addPersistedDefaultToNonEmptyScope(model),
				options.scope,
			);
		return selectedModel;
	}

	private _addPersistedDefaultToNonEmptyScope(model: Model<any>): string[] | undefined {
		if (this.scopedModels.length > 0 && !this.scopedModels.some((scoped) => modelsAreEqual(scoped.model, model)))
			this.scopedModels = [...this.scopedModels, { model }];

		const settingsManager = this.host.session.settingsManager;
		const enabledModels = settingsManager.getGlobalSettings().enabledModels;
		if (!enabledModels?.length) return;

		const modelReference = `${model.provider}/${model.id}`;
		if (enabledModels.some((pattern) => pattern.toLowerCase() === modelReference.toLowerCase())) return;
		return [...enabledModels, modelReference];
	}

	async cycleModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined> {
		if (this.scopedModels.length > 0) {
			return this._cycleScopedModel(direction, options);
		}
		return this._cycleAvailableModel(direction, options);
	}

	private async _cycleScopedModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined> {
		const { session } = this.host;
		const availableIds = new Set(
			session.modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}\0${model.id}`),
		);
		const scopedModels = this.scopedModels.filter((scoped) =>
			availableIds.has(`${scoped.model.provider}\0${scoped.model.id}`),
		);
		if (scopedModels.length <= 1) return undefined;

		const currentModel = session.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const selectedModel = await this._switchTo(next.model, options, "cycle", next.thinkingLevel);
		return {
			model: selectedModel,
			thinkingLevel: session.thinkingLevel,
			isScoped: true,
		};
	}

	private async _cycleAvailableModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined> {
		const { session } = this.host;
		const availableModels = session.modelRuntime.getAvailableSnapshot();
		if (availableModels.length <= 1) return undefined;

		const currentModel = session.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const selectedModel = await this._switchTo(availableModels[nextIndex], options, "cycle");
		return {
			model: selectedModel,
			thinkingLevel: session.thinkingLevel,
			isScoped: false,
		};
	}

	/** Set the level the session asks for; the effective level is clamped to the model, the requested one kept as is. */
	setThinkingLevel(level: ThinkingLevel, options: ModelMutationOptions): void {
		this.requested = { sessionId: this.sessionId(), level };
		this.applyThinkingLevel(level, options.persist === true);
	}

	private applyThinkingLevel(level: ThinkingLevel, persist: boolean): void {
		const { session } = this.host;
		const availableLevels = session.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level);

		// Only persist if actually changing
		const previousLevel = session.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		session.agent.state.thinkingLevel = effectiveLevel;

		if (persist) {
			session.settingsManager.setDefaultThinkingLevel(level);
		}

		if (isChanging) {
			session.sessionManager.appendThinkingLevelChange(effectiveLevel);
			this.host.emit({ type: "thinking_level_changed", level: effectiveLevel });
			void session.featureHost.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	cycleThinkingLevel(options: ModelMutationOptions): ThinkingLevel | undefined {
		const { session } = this.host;
		if (!session.supportsThinking()) return undefined;

		const levels = session.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(session.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		session.setThinkingLevel(nextLevel, options);
		return nextLevel;
	}

	getAvailableThinkingLevels(): ThinkingLevel[] {
		const model = this.host.session.model;
		if (!model) return [...THINKING_LEVEL_OPTIONS];
		return getSupportedThinkingLevels(model);
	}

	/**
	 * The level for a switch to `targetModel`: an explicit (scoped) level, else the model's `modelThinkingLevels` entry,
	 * else the level this session last asked for, else the global default, else the current level.
	 */
	private _getThinkingLevelForModelSwitch(targetModel: Model<any>, explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) return explicitLevel;
		const { session } = this.host;
		const requested = this.requested?.sessionId === this.sessionId() ? this.requested.level : undefined;
		return (
			session.settingsManager.getModelThinkingLevel(targetModel.provider, targetModel.id) ??
			requested ??
			session.settingsManager.getDefaultThinkingLevel() ??
			session.thinkingLevel ??
			DEFAULT_THINKING_LEVEL
		);
	}

	private _clampThinkingLevel(level: ThinkingLevel): ThinkingLevel {
		const model = this.host.session.model;
		return model ? clampThinkingLevel(model, level) : "off";
	}

	refreshCurrentModelFromRegistry(): void {
		const { session } = this.host;
		const currentModel = session.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = session.modelRuntime.getModel(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		session.agent.state.model = this.withContextBudget(refreshedModel);
	}
}
