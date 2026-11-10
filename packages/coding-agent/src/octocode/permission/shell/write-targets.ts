import os from "node:os";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { RELATIVE_AFTER_CD } from "../bash-cwd.ts";
import type { BashFileTarget } from "../bash-types.ts";
import { DYNAMIC_TARGET, homeSpelling, shellPath, shellTargetPath, stateFolderRefusal } from "../file-access.ts";
import { getOctocodeHome } from "../../../config.ts";
import { canonicalPath } from "../../../../../common/src/canonical-path.ts";
import { isWithin } from "../../../../../common/src/paths.ts";
import { shellMutation } from "./mutation.ts";

type ShellTarget = BashFileTarget & { allowed: boolean };

/**
 * The first word of `command` (an operand, or the value a variable is set to) in Octocode's state folder, for a write the
 * parse could not place: `H=~/.octocode; echo x > $H/a` is unresolved, but what it is reaching for is on the line.
 */
function stateFolderWord(command: string, cwd: string): string | undefined {
	// By its text, not the parse: a variable set on its own (`H=…; …`) belongs to no command.
	const words = command.split(/[\s;&|()<>=`'"]+/).map((word) => homeSpelling(word) ?? word);
	const state = canonicalPath(getOctocodeHome());
	const home = canonicalPath(os.homedir());
	for (const word of words) {
		if (!/[\\/]/.test(word)) continue;
		const place = canonicalPath(shellPath(cwd, word));
		if (stateFolderRefusal(place, word, "Bash", cwd)) return word;
		// A folder on the way to it (`~/.octocode`), though not the home folder, which holds everything.
		if (place !== home && isWithin(place, home) && isWithin(state, place)) return state;
	}
	return undefined;
}

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
	// `sqlite3` holds a database open for writing with nothing else to show for it: `trusted_folders` lives in the agent's own.
	const databases = effect.databases.filter(
		(file) => stateFolderRefusal(canonicalPath(shellPath(cwd, file)), file, "Bash", cwd) !== undefined,
	);
	const named = effect.uncertain ? stateFolderWord(input.command, cwd) : undefined;
	for (const file of [...effect.writes, ...effect.areas, ...databases, ...(named === undefined ? [] : [named])]) {
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
