import type { AutocompleteItem } from "@octocodeai/octocode-tui";
import { getShellEnv } from "../../utils/shell.ts";
import { spawnProcessSync } from "../../../../common/src/child-process.ts";
import { clipText } from "../../../../common/src/clip.ts";
import { cliRuntime, resolveOctocodeCli } from "./resolve.ts";

/** What `octocode <path> --help` lists: its commands and its options, each with a short description. */
export interface CliHelp {
	commands: Array<[string, string]>;
	options: Array<[string, string]>;
}

/** The indented lines of the `<heading>:` section of a help text, up to the next unindented line. */
function section(help: string, heading: string): string[] {
	const body = help.split(new RegExp(`^${heading}:$`, "m"))[1]?.split(/^\S/m)[0] ?? "";
	return body.split("\n");
}

/**
 * Reads the command and option lists from a help text in the common `Commands:` / `Options:` layout: a name, two or more
 * spaces and its description, or the description on the next, deeper-indented line. Anything else is ignored, so a
 * changed layout yields fewer completions, never an error.
 */
export function parseCliHelp(help: string): CliHelp {
	const commands = [
		...section(help, "Commands")
			.join("\n")
			.matchAll(/^ {2}(\S+)\s{2,}(.+)$/gm),
	].map(([, name, text]): [string, string] => [name, clipText(text.trim(), 60)]);
	const lines = section(help, "Options");
	const options: Array<[string, string]> = [];
	lines.forEach((line, index) => {
		const match = /^\s+(?:-\w,\s+)?(--[\w-]+)(?:[ =]<[^>]+>)?(?:\s{2,}(.+))?$/.exec(line);
		if (!match) return;
		const next = lines[index + 1]?.trim();
		const text = match[2] ?? (next && !next.startsWith("-") ? next : "");
		options.push([match[1], clipText(text, 60)]);
	});
	return { commands, options };
}

const helps = new Map<string, CliHelp>();

/**
 * The help of `octocode <path>`, read once per path and cached for the process; empty when the CLI does not resolve or
 * its help cannot be read. Run synchronously with a short timeout: completion is synchronous.
 */
function cliHelp(path: readonly string[]): CliHelp {
	const key = path.join(" ");
	const cached = helps.get(key);
	if (cached) return cached;
	const cli = resolveOctocodeCli();
	const help = cli
		? (spawnProcessSync(cliRuntime(), [cli.bin, ...path, "--help"], {
				encoding: "utf8",
				timeout: 5000,
				env: getShellEnv(),
				windowsHide: true,
			}).stdout ?? "")
		: "";
	const parsed = parseCliHelp(help);
	helps.set(key, parsed);
	return parsed;
}

/**
 * Completions for the `/octocode` arguments typed so far: the commands of the command path before the last word, or its
 * options when that word starts with `-`. A path is followed only through words the CLI's help lists as commands, so
 * free arguments (a JSON envelope) never run as a help lookup. Each value is the whole argument text, as the editor
 * replaces it.
 */
export function completeCliArgs(prefix: string): AutocompleteItem[] | null {
	const words = prefix.split(/\s+/);
	const partial = words.pop() ?? "";
	const path: string[] = [];
	for (const word of words) {
		if (!cliHelp(path).commands.some(([name]) => name === word)) return null;
		path.push(word);
	}
	const help = cliHelp(path);
	const head = path.length > 0 ? `${path.join(" ")} ` : "";
	const items = (partial.startsWith("-") ? help.options : help.commands)
		.filter(([name]) => name.startsWith(partial))
		.map(([name, description]) => ({ value: `${head}${name}`, label: name, ...(description ? { description } : {}) }));
	return items.length > 0 ? items : null;
}
