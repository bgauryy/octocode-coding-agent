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

export type ScopedModel = { model: Model<any>; thinkingLevel?: ThinkingLevel };

export class SessionModelControl {
	scopedModels: ScopedModel[];

	private readonly host: Pick<SessionInternals, "session" | "emit">;

	constructor(host: Pick<SessionInternals, "session" | "emit">, scopedModels: ScopedModel[]) {
		this.host = host;
		this.scopedModels = scopedModels;
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
	 * responses would record it on every prompt while `prepareRequest` redirects to another model.
	 */
	recordSelection(): void {
		const { session } = this.host;
		const model = session.model;
		if (!model) return;
		const getModel = (provider: string, modelId: string) => session.modelRuntime.getModel(provider, modelId);
		const recorded = getBranchSelection(session.sessionManager.getBranch(), getModel);
		if (!recorded || (recorded.provider === model.provider && recorded.modelId === model.id)) return;
		const recordedModel = getModel(recorded.provider, recorded.modelId);
		if (!isVirtualModel(model) && !(recordedModel && isVirtualModel(recordedModel))) return;
		session.sessionManager.appendModelChange(model.provider, model.id);
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
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this.host.session.extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	async setModel(model: Model<any>, options: ModelMutationOptions): Promise<void> {
		const { session } = this.host;
		if (!(await session.modelRuntime.checkAuth(model.provider))) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = session.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch(model);
		session.agent.state.model = model;
		session.sessionManager.appendModelChange(model.provider, model.id);
		if (options.persist) {
			session.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
			this._addPersistedDefaultToNonEmptyScope(model);
		}

		// Apply thinking level for the new model.
		// Per-model thinking level overrides take priority over the global default.
		// Model persistence does not implicitly rewrite the global thinking default.
		session.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(model, previousModel, "set");
	}

	private _addPersistedDefaultToNonEmptyScope(model: Model<any>): void {
		if (this.scopedModels.length === 0) return;
		if (this.scopedModels.some((scoped) => modelsAreEqual(scoped.model, model))) return;

		this.scopedModels = [...this.scopedModels, { model }];

		const settingsManager = this.host.session.settingsManager;
		const enabledModels = settingsManager.getEnabledModels();
		if (!enabledModels?.length) return;

		const modelReference = `${model.provider}/${model.id}`;
		if (enabledModels.some((pattern) => pattern.toLowerCase() === modelReference.toLowerCase())) return;
		settingsManager.setEnabledModels([...enabledModels, modelReference]);
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
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.model, next.thinkingLevel);

		// Apply model
		session.agent.state.model = next.model;
		session.sessionManager.appendModelChange(next.model.provider, next.model.id);
		if (options.persist) {
			session.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);
			this._addPersistedDefaultToNonEmptyScope(next.model);
		}

		// Apply thinking level for the new model.
		// - Explicit scoped model thinking level overrides defaults
		// - Per-model thinking level overrides take priority over the global default
		// setThinkingLevel clamps to model capabilities.
		// Model persistence does not implicitly rewrite the global thinking default.
		session.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(next.model, currentModel, "cycle");

		return {
			model: next.model,
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
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch(nextModel);
		session.agent.state.model = nextModel;
		session.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		if (options.persist) {
			session.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);
			this._addPersistedDefaultToNonEmptyScope(nextModel);
		}

		// Apply thinking level for the new model.
		// Model persistence does not implicitly rewrite the global thinking default.
		session.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(nextModel, currentModel, "cycle");

		return {
			model: nextModel,
			thinkingLevel: session.thinkingLevel,
			isScoped: false,
		};
	}

	setThinkingLevel(level: ThinkingLevel, options: ModelMutationOptions): void {
		const { session } = this.host;
		const availableLevels = session.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const previousLevel = session.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		session.agent.state.thinkingLevel = effectiveLevel;

		if (options.persist) {
			session.settingsManager.setDefaultThinkingLevel(level);
		}

		if (isChanging) {
			session.sessionManager.appendThinkingLevelChange(effectiveLevel);
			this.host.emit({ type: "thinking_level_changed", level: effectiveLevel });
			void session.extensionRunner.emit({
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

	private _getThinkingLevelForModelSwitch(targetModel?: Model<any>, explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		const { session } = this.host;
		// Per-model default takes priority when switching to a model that has one
		if (targetModel) {
			const perModel = session.settingsManager.getModelThinkingLevel(targetModel.provider, targetModel.id);
			if (perModel !== undefined) {
				return perModel;
			}
		}
		return session.settingsManager.getDefaultThinkingLevel() ?? session.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
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

		session.agent.state.model = refreshedModel;
	}
}
