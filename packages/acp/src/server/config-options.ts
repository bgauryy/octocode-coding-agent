import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AcpModels } from "../host.ts";

/** The id of the config option that selects the session's model. */
export const MODEL_CONFIG_ID = "model";

/** Beside a model whose vendor allows interactive use only: an ACP client's session is not that, but it may choose it. */
const INTERACTIVE_ONLY_NOTICE = "The vendor's plan allows interactive use only.";

/**
 * The session's model as a `select` config option, or none when the worker reports no models. A model whose plan allows
 * interactive use only carries `INTERACTIVE_ONLY_NOTICE` as its description: a notice, so it stays selectable.
 */
export function modelConfigOptions(models: AcpModels): SessionConfigOption[] {
	const current = models.current ?? models.available[0];
	if (!current) return [];
	const values = models.available.includes(current) ? models.available : [current, ...models.available];
	const interactiveOnly = new Set(models.interactiveOnly);
	return [
		{
			id: MODEL_CONFIG_ID,
			name: "Model",
			category: "model",
			type: "select",
			currentValue: current,
			options: values.map((value) =>
				interactiveOnly.has(value)
					? { value, name: value, description: INTERACTIVE_ONLY_NOTICE }
					: { value, name: value },
			),
		},
	];
}
