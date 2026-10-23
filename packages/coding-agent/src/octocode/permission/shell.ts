import { base, BODY, hide, mask, REMOVERS, SEPARATOR, SHELLS, shellScript, unhide, words } from "./shell/words.ts";

export { catastrophicCommand, expandHome } from "./shell/destructive.ts";
export { readOnlyCommand } from "./shell/read-only.ts";

/**
 * The base program name of every simple command `command` runs (past wrappers and `VAR=value`), including the scripts
 * of `sh -c`, `eval` and `$(…)`, each once in order of appearance.
 */
export function commandNames(command: string): string[] {
	const bodies: string[] = [];
	const parts = mask(command, bodies).split(SEPARATOR);
	const names: string[] = [];
	for (let at = 0; at < parts.length; at += 2) {
		const tokens = words(parts[at]);
		const name = base(unhide(tokens[0] ?? ""));
		if (!name || BODY.test(name)) continue;
		names.push(name);
		if (name === "eval") names.push(...commandNames(tokens.slice(1).map(unhide).join(" ")));
		const script = SHELLS.has(name) ? shellScript(tokens).script : undefined;
		if (script !== undefined) names.push(...commandNames(unhide(script)));
	}
	return [...new Set(names)];
}

/** The paths `rm`, `rmdir`, `unlink` and `shred` name in `command` (past wrappers and `sh -c` scripts), as written, each once. */
export function removalTargets(command: string): string[] {
	const bodies: string[] = [];
	const found: string[] = [];
	for (const [at, part] of mask(command, bodies).split(SEPARATOR).entries()) {
		if (at % 2 === 1) continue;
		const tokens = words(part).map(unhide);
		const name = base(tokens[0] ?? "");
		if (REMOVERS.has(name)) {
			const rest = tokens.slice(1);
			const end = rest.indexOf("--");
			found.push(...rest.filter((token, index) => (end >= 0 ? index > end : !token.startsWith("-"))));
		}
		const script = SHELLS.has(name) ? shellScript(tokens.map(hide)).script : undefined;
		if (script !== undefined) found.push(...removalTargets(unhide(script)));
	}
	return [...new Set(found)];
}

/** `command` trimmed when it is one simple command (no `;`, `&&`, pipes, substitutions or heredocs), else undefined. */
export function simpleCommand(command: string): string | undefined {
	const trimmed = command.trim();
	const bodies: string[] = [];
	const parts = mask(trimmed, bodies).split(SEPARATOR);
	return trimmed !== "" && parts.length === 1 && bodies.length === 0 ? trimmed : undefined;
}

/** The tools that run a shell command: Octocode's `bash` and `powershell`. */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell"]);
