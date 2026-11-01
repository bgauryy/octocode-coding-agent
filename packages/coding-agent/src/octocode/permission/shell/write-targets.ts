import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { RELATIVE_AFTER_CD } from "../bash-cwd.ts";
import type { BashFileTarget } from "../bash-types.ts";
import { DYNAMIC_TARGET, shellPath, shellTargetPath } from "../file-access.ts";
import { canonicalPath } from "../../shared/home/repo.ts";
import { shellMutation } from "./mutation.ts";

type ShellTarget = BashFileTarget & { allowed: boolean };

/**
 * Every place a `bash` call writes by its parse (`shellMutation`: redirects, `tee`, `cp`/`mv`/`touch` operands,
 * destinations options name, `git -C`, scripts run by `sh -c`, `eval` and `find -exec`), as targets for the permission
 * check, minus the ones `known` already reports (the source policy's redirect and `tee` targets, which carry its Claude
 * rule verdicts). A write the parse cannot place (an expansion, a script it cannot read, a relative path after a `cd` it
 * cannot follow) is one uncertain target. A call that is not bash yields none. Synchronous: the caller awaits
 * `shellParserReady` first (the gate does); without the parser every command is one uncertain target, which asks.
 */
export function commandWriteTargets(
	invocation: { toolName: string; input: unknown },
	cwd: string,
	known: readonly BashFileTarget[] = [],
): ShellTarget[] {
	const input = isRecord(invocation.input) ? invocation.input : {};
	if (invocation.toolName !== "bash" || input.type === "powershell" || typeof input.command !== "string") return [];
	const effect = shellMutation(input.command);
	const key = (file: string) => canonicalPath(shellPath(cwd, file));
	const seen = new Set(
		known.flatMap((target) => {
			const file = target.kind === "write" ? shellTargetPath(target) : undefined;
			return file === undefined ? [] : [key(file)];
		}),
	);
	const targets: ShellTarget[] = [];
	for (const file of [...effect.writes, ...effect.areas]) {
		if (seen.has(key(file))) continue;
		seen.add(key(file));
		targets.push({ kind: "write", raw: file, path: file, position: 0, allowed: false });
	}
	if (effect.uncertain && !known.some((target) => target.kind === "write" && !shellTargetPath(target)))
		targets.push({
			kind: "write",
			raw: effect.uncertainBecause ?? "a relative path after a `cd` the check cannot follow",
			uncertain: !effect.uncertainBecause && effect.afterDirectoryChange ? RELATIVE_AFTER_CD : DYNAMIC_TARGET,
			position: 0,
			allowed: false,
		});
	return targets;
}
