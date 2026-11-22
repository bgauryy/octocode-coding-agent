import type { FlagSpec } from "./types.ts";

export const MODEL_LIST_FLAGS: readonly FlagSpec[] = [
	{
		name: "--list-models",
		kind: "optional",
		arg: "[search]",
		completion: "text",
		help: [
			"List configured models by estimated size, context and output limit. Filter with --provider or --model-size.",
		],
		apply: (a, v) => void (a.listModels = v ?? true),
	},
	{
		name: "--model-size",
		kind: "value",
		arg: "<small|medium|large>",
		completion: "text",
		help: ["List models in this estimated size class. Combine with --list-models [search] to narrow the list."],
		apply: (a, v) => {
			if (v !== "small" && v !== "medium" && v !== "large") return "expects small, medium or large";
			a.modelSize = v;
			a.listModels ??= true;
		},
	},
	{
		name: "--check-model-access",
		kind: "boolean",
		help: [
			"Check listed Bedrock model entitlements in your AWS region without invoking a model (AWS CLI for profiles or IAM).",
		],
		apply: (a) => {
			a.checkModelAccess = true;
			a.listModels ??= true;
		},
	},
];
