import type { SessionConfigOption } from "@agentclientprotocol/sdk";

/** The id of the config option that selects the session's model. */
export const MODEL_CONFIG_ID = "model";

/** The session's model as a `select` config option, or none when the worker reports no models. */
export function modelConfigOptions(models: { current?: string; available: string[] }): SessionConfigOption[] {
	const current = models.current ?? models.available[0];
	if (!current) return [];
	const values = models.available.includes(current) ? models.available : [current, ...models.available];
	return [
		{
			id: MODEL_CONFIG_ID,
			name: "Model",
			category: "model",
			type: "select",
			currentValue: current,
			options: values.map((value) => ({ value, name: value })),
		},
	];
}
