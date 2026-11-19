const RUNNERS = new Set(["yarn", "npx", "pnpm", "bunx", "npm"]);
const SCRIPT_RUNS = new Set(["format", "fmt"]);
const READ_ONLY_FLAGS = new Set(["--check", "--list-different", "-l", "--help", "-h", "--version", "-V"]);
const WHOLE_TREE = new Set([".", "./", "*", "**", "packages", "packages/", "scripts", "scripts/"]);

/**
 * Whether one command line formats the whole repository: `oxfmt` (also through `yarn`, `npx`, `pnpm exec`) with no
 * file operand or only a directory-wide one, or the `format` package script, which carries its own repo-wide globs. A
 * line is split on separators, not parsed. A check-only run (`--check`, `--list-different`) writes nothing and is not one.
 */
export function repoWideFormat(command: string): boolean {
	return command.split(/[;&|\n()]+/).some((segment) => {
		const words = segment
			.split(/\s+/)
			.map((word) => word.replace(/^["']|["']$/g, ""))
			.filter((word) => word && !/^\w+=/.test(word));
		const start = words[0] !== undefined && (words[0].split("/").pop() === "oxfmt" || RUNNERS.has(words[0])) ? 0 : -1;
		if (start < 0) return false;
		const rest = words.slice(start);
		if (rest.some((word) => READ_ONLY_FLAGS.has(word))) return false;
		const first = rest[0] ?? "";
		const operands = rest.slice(1).filter((word) => !word.startsWith("-"));
		if (RUNNERS.has(first)) {
			const [verb, ...after] = operands[0] === "run" ? operands.slice(1) : operands;
			if (SCRIPT_RUNS.has(verb ?? "")) return true;
			const tool = verb === "exec" || verb === "dlx" ? after[0] : verb;
			if (tool?.split("/").pop() !== "oxfmt") return false;
			const files = (verb === "exec" || verb === "dlx" ? after.slice(1) : after).filter((word) => word !== "--");
			return files.every((word) => WHOLE_TREE.has(word));
		}
		return operands.every((word) => WHOLE_TREE.has(word));
	});
}
