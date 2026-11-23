import { CHOOSABLE_MODES, type PermissionMode } from "../../octocode/permission/mode-names.ts";
import type { Args, FlagSpec } from "./types.ts";

/** `--permission-mode` and `--dangerously-skip-permissions` name one start mode; two different ones are an error. */
const startIn = (args: Args, mode: PermissionMode) => {
	if (args.permissionMode && args.permissionMode !== mode)
		return `conflicts with the start mode ${args.permissionMode} given earlier`;
	args.permissionMode = mode;
	return undefined;
};

/** The start permission mode of this process; `main/run-session.ts` exports it for every session and subagent. */
export const PERMISSION_FLAGS: readonly FlagSpec[] = [
	{
		name: "--permission-mode",
		kind: "value",
		arg: "<mode>",
		values: CHOOSABLE_MODES,
		label: "permission mode",
		help: ["Start in this permission mode: manual, workspace or full (default); subagents inherit it"],
		apply: (a, v) => startIn(a, v as PermissionMode),
	},
	{
		name: "--dangerously-skip-permissions",
		kind: "boolean",
		help: [
			"Start in bypass mode: nothing asks, not even what full asks about, and subagents inherit it",
			"Every call is still recorded (/permissions log); invariants and hook denies still refuse",
		],
		apply: (a) => startIn(a, "bypass"),
	},
];
