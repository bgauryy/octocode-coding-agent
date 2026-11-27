/** Synthetic contracts and equivalent requests for all declaration states and wire adapters. */
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
	type: "object" as const,
	properties,
	required,
	additionalProperties: false,
});

export const replayCases = [
	{
		name: "batch",
		prompt: "Inspect the north sample using a batch query.",
		inputSchema: object(
			{
				queries: {
					type: "array",
					items: object({ sample: { type: "string", description: "Sample label" } }, ["sample"]),
				},
			},
			["queries"],
		),
		valid: { queries: [{ sample: "north" }] },
		malformed: { queries: [{ sampleLabel: "north" }] },
	},
	{
		name: "depth",
		prompt: "Inspect to a maximum depth of three.",
		inputSchema: object({ depth: { type: "integer", minimum: 1, description: "Maximum depth to inspect" } }),
		valid: { depth: 3 },
		malformed: { depthValue: 3 },
	},
	{
		name: "order",
		prompt: "Request descending order.",
		inputSchema: object(
			{ order: { type: "string", enum: ["ascending", "descending"], description: "Sort direction" } },
			["order"],
		),
		valid: { order: "descending" },
		malformed: { order: "reverse" },
	},
];
