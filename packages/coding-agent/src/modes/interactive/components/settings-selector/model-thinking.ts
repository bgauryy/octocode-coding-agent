import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import { getSupportedThinkingLevels, type Model } from "@octocodeai/octocode-ai";
import type { SelectItem } from "@octocodeai/octocode-tui";
import { theme } from "../../../../theme/theme.ts";
import { SteppedSubmenu, type SteppedSubmenuStep } from "../settings-submenu.ts";
import type { SettingsCallbacks, SettingsConfig } from "./types.ts";

const MODEL_PICKER_LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 46 };

const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Extra-high reasoning (~32k tokens)",
	max: "Maximum reasoning",
};

const CLEAR_OVERRIDE_VALUE = "__clear__";

export function modelSettingKey(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function modelDisplayLabel(model: Model<any>): string {
	return `${model.id} [${model.provider}]`;
}

export function modelThinkingOverridesSummary(overrides: Record<string, ThinkingLevel>): string {
	const count = Object.keys(overrides).length;
	if (count === 0) return "none";
	return `${count} configured`;
}

function modelItemLabel(model: Model<any>): string {
	return `${model.id} ${theme.fg("muted", `[${model.provider}]`)}`;
}

/** State the per-model thinking submenu reads and updates while the settings selector is open. */
interface ModelThinkingContext {
	config: SettingsConfig;
	callbacks: SettingsCallbacks;
	currentModelThinkingLevels: Record<string, ThinkingLevel>;
	defaultModelByValue: Map<string, Model<any>>;
	currentModelKey: string | undefined;
	currentDefaultModelKey: string | undefined;
}

export function createModelThinkingSubmenu(
	{
		config,
		callbacks,
		currentModelThinkingLevels,
		defaultModelByValue,
		currentModelKey,
		currentDefaultModelKey,
	}: ModelThinkingContext,
	done: (selectedValue?: string) => void,
): SteppedSubmenu {
	const steps: SteppedSubmenuStep[] = [
		{
			key: "model",
			title: "Per-Model Thinking Level",
			description: "Select a model to configure",
			options: () => {
				const sorted = [...config.availableDefaultModels].sort((a, b) => {
					const aKey = modelSettingKey(a);
					const bKey = modelSettingKey(b);
					if (aKey === currentModelKey) return -1;
					if (bKey === currentModelKey) return 1;
					if (aKey === currentDefaultModelKey) return -1;
					if (bKey === currentDefaultModelKey) return 1;
					return a.provider.localeCompare(b.provider);
				});
				const items: SelectItem[] = sorted.map((model) => {
					const key = modelSettingKey(model);
					const override = currentModelThinkingLevels[key];
					return {
						value: key,
						label: modelItemLabel(model),
						description: override ?? undefined,
					};
				});
				if (items.length === 0) {
					items.push({
						value: "__none__",
						label: "No models available",
						description: "Log in to a provider or configure an API key first",
					});
				}
				return items;
			},
			preselect: () => currentModelKey ?? currentDefaultModelKey,
			searchable: true,
			layout: MODEL_PICKER_LAYOUT,
		},
		{
			key: "level",
			title: (ctx) => {
				const m = defaultModelByValue.get(ctx.model);
				return `Thinking Level for ${m ? modelDisplayLabel(m) : ctx.model}`;
			},
			description: "Select default thinking level for this model",
			options: (ctx) => {
				const model = defaultModelByValue.get(ctx.model);
				if (!model) return [];
				const levels: ThinkingLevel[] = model.reasoning ? getSupportedThinkingLevels(model) : ["off"];
				const activeLevel = currentModelThinkingLevels[ctx.model];
				const items: SelectItem[] = levels.map((level) => ({
					value: level,
					label: `${level === activeLevel ? "✓ " : "  "}${level}`,
					description: THINKING_DESCRIPTIONS[level],
				}));
				if (currentModelThinkingLevels[ctx.model] !== undefined) {
					items.push({
						value: CLEAR_OVERRIDE_VALUE,
						label: "  (clear override)",
						description: `Revert to global default (${config.thinkingLevel})`,
					});
				}
				return items;
			},
			preselect: (ctx) => currentModelThinkingLevels[ctx.model],
		},
	];

	const summary = () => modelThinkingOverridesSummary(currentModelThinkingLevels);

	return new SteppedSubmenu(
		steps,
		(selections) => {
			const model = defaultModelByValue.get(selections.model);
			if (!model) return;
			if (selections.level === CLEAR_OVERRIDE_VALUE) {
				callbacks.onModelThinkingLevelRemove(model.provider, model.id);
				delete currentModelThinkingLevels[selections.model];
			} else {
				callbacks.onModelThinkingLevelChange(model.provider, model.id, selections.level as ThinkingLevel);
				currentModelThinkingLevels[selections.model] = selections.level as ThinkingLevel;
			}
		},
		() => {
			done(summary());
		},
		{ loop: true },
	);
}
