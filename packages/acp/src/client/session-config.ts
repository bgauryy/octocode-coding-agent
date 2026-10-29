import type {
	SessionConfigOption,
	SessionConfigSelectGroup,
	SessionConfigSelectOption,
} from "@agentclientprotocol/sdk";
import type { ExternalModels } from "../../../coding-agent/src/octocode/external/protocol.ts";
import { isRecord } from "../../../coding-agent/src/utils/guards.ts";

/** The models an ACP agent reports, and the config option that selects one when the agent offers it. */
export interface AcpModels extends ExternalModels {
	/** Absent when the agent reports models only through the unstable `models` field, which this client cannot set. */
	configId?: string;
}

type SessionState = { configOptions?: SessionConfigOption[] | null; models?: unknown };
type SelectOption = Extract<SessionConfigOption, { type: "select" }>;

/** The select option whose category is `model`; an option with the id `model` when no category says so. */
function modelOption(options: SessionConfigOption[] | null | undefined): SelectOption | undefined {
	const selects = (options ?? []).filter((option): option is SelectOption => option.type === "select");
	return selects.find((option) => option.category === "model") ?? selects.find((option) => option.id === "model");
}

const values = (option: SelectOption): string[] =>
	(option.options as Array<SessionConfigSelectOption | SessionConfigSelectGroup>).flatMap((entry) =>
		"options" in entry ? entry.options.map((value) => value.value) : [entry.value],
	);

/**
 * The model state in a `session/new`, `session/load` or `session/set_config_option` response or a `config_option_update`:
 * the stable model config option first, then the unstable `models` field that older adapters still send.
 */
export function acpModels(state: SessionState): AcpModels | undefined {
	const option = modelOption(state.configOptions);
	if (option) return { current: option.currentValue, available: values(option), configId: option.id };
	const legacy = isRecord(state.models) ? state.models : undefined;
	if (!legacy) return undefined;
	const available = Array.isArray(legacy.availableModels)
		? legacy.availableModels.flatMap((model) =>
				isRecord(model) && typeof model.modelId === "string" ? [model.modelId] : [],
			)
		: [];
	const current = typeof legacy.currentModelId === "string" ? legacy.currentModelId : undefined;
	return current || available.length ? { ...(current ? { current } : {}), available } : undefined;
}

/** Why a requested model cannot be set, naming what the agent offers; undefined when it can. */
export function modelRefusal(models: AcpModels | undefined, model: string): string | undefined {
	if (!models?.configId)
		return models?.available.length
			? `ACP agent reports models (${models.available.slice(0, 20).join(", ")}) but no model config option to set; connect without model.`
			: "ACP agent offers no model option; connect without model.";
	if (models.available.includes(model)) return undefined;
	const shown = models.available.slice(0, 20).join(", ");
	const more = models.available.length > 20 ? `, and ${models.available.length - 20} more` : "";
	return `ACP agent has no model "${model}"; it offers ${shown}${more}.`;
}
