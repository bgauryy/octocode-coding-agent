import type { FlagSpec } from "./types.ts";

/** `--api-key` and `--api-key-env`: one key for this run, either inline or read from an environment variable. */
export const API_KEY_FLAGS: readonly FlagSpec[] = [
	{
		name: "--api-key",
		kind: "value",
		arg: "<key>",
		completion: "text",
		help: ["API key (prefer --api-key-env: a key on the command line shows up in ps and shell history)"],
		apply: (a, v) => {
			if (a.apiKeyEnv !== undefined) return `conflicts with --api-key-env ${a.apiKeyEnv}`;
			a.apiKey = v;
			return undefined;
		},
	},
	{
		name: "--api-key-env",
		kind: "value",
		arg: "<name>",
		completion: "text",
		help: [
			"Read the API key for this run from the environment variable <name>, so it stays out of ps and shell history",
		],
		apply: (a, v) => {
			if (a.apiKeyEnv !== undefined) return "was given twice";
			if (a.apiKey !== undefined) return "conflicts with --api-key given earlier";
			const key = process.env[v!];
			if (!key?.trim()) return `environment variable ${v} is not set or is empty`;
			a.apiKeyEnv = v;
			a.apiKey = key;
			return undefined;
		},
	},
];
