import { runSetError } from "../../configuration/run-flags.ts";
import type { FlagSpec } from "./types.ts";

const push = (list: string[] | undefined, value: string) => [...(list ?? []), value];

/** `--enable`, `--disable` and `--set`: configuration for this run only (`configuration/run-flags.ts` applies them). */
export const CONFIGURATION_FLAGS: readonly FlagSpec[] = [
	{
		name: "--enable",
		kind: "list",
		arg: "<id>",
		completion: "text",
		help: [
			"Enable a tool, MCP server, skill, harness or boolean setting for this run only (repeatable)",
			"An id is kind:name, e.g. tool:backlog; `octocode configuration list` shows them",
		],
		apply: (a, v) => void (a.enable = push(a.enable, v!)),
	},
	{
		name: "--disable",
		kind: "list",
		arg: "<id>",
		completion: "text",
		help: ["Disable a tool, skill, harness or boolean setting for this run only (repeatable)"],
		apply: (a, v) => void (a.disable = push(a.disable, v!)),
	},
	{
		name: "--set",
		kind: "list",
		arg: "<key>=<value>",
		completion: "text",
		help: ["Set a settings key for this run only, e.g. --set retry.maxRetries=5 (repeatable)"],
		apply: (a, v) => {
			const error = runSetError(v!);
			if (error) return error;
			a.set = push(a.set, v!);
			return undefined;
		},
	},
] satisfies readonly FlagSpec[];
