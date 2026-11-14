import type { BashCommand, BashSyntax } from "./bash-types.ts";
import { rememberedSyntax } from "./bash-syntax-memo.ts";
import { RELATIVE_AFTER_CD, directoriesAt, directoryCommand, directoryStates } from "./bash-cwd.ts";
import { bashCandidates } from "./bash-wrappers.ts";
import { herestringError, misreadHerestring, onlyMisreadHerestrings } from "./bash-herestring.ts";
import { literalVariables, resolvedWord } from "./bash-variables.ts";
import { ansiC, wrappedCommand } from "./shell/words.ts";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { Language, Parser, type Node } from "web-tree-sitter";
import { getPackageDir, isBunBinary } from "../../config.ts";

let language: Language | undefined;
let loading: Promise<void> | undefined;
const MAX_BYTES = 128 * 1024;
const MAX_NODES = 16_384;
const MAX_DEPTH = 128;

function asset(name: string): string {
	const root = getPackageDir();
	if (isBunBinary) return path.join(root, "bash-parser", name);
	if (!import.meta.url.endsWith(".ts")) return path.join(root, "dist", "bash-parser", name);
	if (name === "tree-sitter.wasm") return createRequire(import.meta.url).resolve("web-tree-sitter/tree-sitter.wasm");
	return path.join(root, "src", "octocode", "permission", "bash-parser", name);
}

export function initializeBashSyntax(): Promise<void> {
	return (loading ??= (async () => {
		await Parser.init({
			wasmBinary: fs.readFileSync(asset("tree-sitter.wasm")),
		});
		const loaded = await Language.load(fs.readFileSync(asset("tree-sitter-bash.wasm")));
		// The first parse compiles WASM paths and can exceed the 50ms budget in `bashSyntax` on a busy machine, which
		// would mark the first real command incomplete. Pay that cost here, without a budget.
		const parser = new Parser();
		try {
			parser.setLanguage(loaded);
			parser.parse('A="b c" timeout 1 printf "x; y" | cat > /dev/null')?.delete();
		} finally {
			parser.delete();
		}
		language = loaded;
	})().catch((error) => {
		loading = undefined;
		throw error;
	}));
}

const known = new Set([
	"program",
	"command",
	"command_name",
	"word",
	"raw_string",
	"ansi_c_string",
	"string",
	"string_content",
	"concatenation",
	"escape_sequence",
	"simple_expansion",
	"expansion",
	"variable_name",
	"variable_assignment",
	"special_variable_name",
	"number",
	"comment",
	"list",
	"pipeline",
	"subshell",
	"command_substitution",
	"process_substitution",
	"redirected_statement",
	"file_redirect",
	"file_descriptor",
	"herestring_redirect",
]);

export function staticWord(node: Node): string | undefined {
	if (translatedString(node)) return undefined;
	if (node.type === "command_name") return node.namedChildCount === 1 ? staticWord(node.namedChild(0)!) : undefined;
	if (node.type === "raw_string") return node.text.slice(1, -1);
	if (node.type === "ansi_c_string") return ansiC(node.text.slice(2, -1));
	if (node.type === "word" || node.type === "number") {
		if (/(?<!\\)[$`*?[]/.test(node.text)) return undefined;
		// Brace expansion (`{a,/abs}`, `{1..3}`) makes several words; a tilde before a name or after `=` (`~root/x`,
		// `of=~user/x`) expands to that user's home: neither spells the path its text shows.
		if (/(?<!\\)\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(node.text) || /(?:^|=)~(?![/:]|$)/.test(node.text)) return undefined;
		return node.text.replace(/\\(?:\r?\n|(.))/gs, (_match, escaped: string | undefined) => escaped ?? "");
	}
	if (node.type === "string") {
		if (node.namedChildren.some((child) => child?.type !== "string_content" && child?.type !== "escape_sequence"))
			return undefined;
		return node.text
			.slice(1, -1)
			.replace(/\\([$`"\\]|\r?\n)/g, (_match, escaped: string) => (escaped.endsWith("\n") ? "" : escaped));
	}
	if (node.type === "concatenation") {
		// tree-sitter splits `{a,b}` into a concatenation of words: the brace check reads the whole text.
		if (/(?<!\\)\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(node.text)) return undefined;
		const parts = node.namedChildren.map((child) => (child ? staticWord(child) : undefined));
		return parts.every((part) => part !== undefined) ? parts.join("") : undefined;
	}
	return undefined;
}

/**
 * Whether `node` is the string of a `$"…"`, which bash translates through the locale's message catalog at run time, so its
 * text is not its value. The grammar puts the `$` in an anonymous token right before the string (`\$"x"` is a word instead).
 */
export function translatedString(node: Node): boolean {
	const before = node.type === "string" ? node.previousSibling : null;
	return before !== null && !before.isNamed && before.type === "$" && before.endIndex === node.startIndex;
}

/**
 * Wall-clock budgets for one parse. A guard that gets no parse sees no writes, so a busy machine must not read as a
 * harmless command: a stall past the first budget gets the second, which only a truly pathological input exhausts.
 */
const PARSE_BUDGETS_MS = [50, 1000];

function parseInTime(parser: Parser, source: string): ReturnType<Parser["parse"]> {
	for (const budget of PARSE_BUDGETS_MS) {
		const deadline = performance.now() + budget;
		const tree = parser.parse(source, undefined, { progressCallback: () => performance.now() > deadline });
		if (tree) return tree;
		// A cancelled parse otherwise resumes where it stopped.
		parser.reset();
	}
	return null;
}

/**
 * Parses `source` and hands the root to `read`; undefined when the grammar is not loaded, the source is over the size
 * limit, parsing exceeds its time budget or the tree has an error or a missing node. The tree is freed afterwards.
 */
export function parseBash<T>(source: string, read: (root: Node) => T): T | undefined {
	if (!language || Buffer.byteLength(source) > MAX_BYTES) return undefined;
	const parser = new Parser();
	let tree: ReturnType<Parser["parse"]> = null;
	try {
		parser.setLanguage(language);
		tree = parseInTime(parser, source);
		return !tree || !onlyMisreadHerestrings(tree.rootNode) ? undefined : read(tree.rootNode);
	} catch {
		return undefined;
	} finally {
		tree?.delete();
		parser.delete();
	}
}

/** Parse syntax only, shared by the checks of one line (`bash-syntax-memo.ts`); raw command spelling is retained for source permission matching. */
export const bashSyntax = (source: string): BashSyntax => rememberedSyntax(source, parseSyntax);

function parseSyntax(source: string): BashSyntax {
	const result: BashSyntax = { wholeAllow: true, commands: [], incomplete: false, targets: [] };
	const unresolved = (reason: string): BashSyntax => ({
		...result,
		incomplete: true,
		unsupported: result.unsupported ?? reason,
		targets: [
			...result.targets,
			{
				kind: "read",
				raw: "unresolved Bash file effects",
				position: 0,
				uncertain: "Bash parse unavailable",
			},
			{
				kind: "write",
				raw: "unresolved Bash file effects",
				position: 0,
				uncertain: "Bash parse unavailable",
			},
		],
	});
	if (!language) return unresolved("Bash parser not loaded");
	if (Buffer.byteLength(source) > MAX_BYTES) return unresolved(`command over ${MAX_BYTES} bytes`);
	const incomplete = (reason: string) => {
		result.incomplete = true;
		result.unsupported ??= reason;
	};
	const parser = new Parser();
	let tree: ReturnType<Parser["parse"]> = null;
	try {
		parser.setLanguage(language);
		tree = parseInTime(parser, source);
		if (!tree || !onlyMisreadHerestrings(tree.rootNode)) return unresolved("parse unavailable");
		const deadline = performance.now() + PARSE_BUDGETS_MS.at(-1)!;
		const pending: Array<{ node: Node; depth: number }> = [{ node: tree.rootNode, depth: 0 }];
		let count = 0;
		const directoryChanges: number[] = [];
		// Arguments and targets read a variable the line gave a plain literal (`D=/x; echo > $D/a`); a program name does not.
		const variables = literalVariables(tree.rootNode, staticWord);
		const word = (node: Node): string | undefined => resolvedWord(node, variables, staticWord);
		const states = directoryStates(tree.rootNode, word);
		while (pending.length) {
			const { node, depth } = pending.pop()!;
			if (++count > MAX_NODES || depth > MAX_DEPTH || performance.now() > deadline)
				return unresolved("parse size, depth or time limit");
			if (["pipeline", "subshell", "command_substitution", "process_substitution"].includes(node.type))
				result.wholeAllow = false;
			if (node.isMissing) incomplete(`missing ${node.type}`);
			else if (node.isError && !herestringError(node)) incomplete("syntax error");
			else if (!node.isError && !known.has(node.type)) incomplete(node.type);
			if (node.type === "command") {
				const name = node.childForFieldName("name");
				if (!name || staticWord(name) === undefined) incomplete("computed program name");
				const movesDirectory = directoryCommand(node, staticWord) !== undefined;
				if (movesDirectory) {
					let scope = node.parent;
					let isolated = false;
					while (scope) {
						if (["subshell", "pipeline", "command_substitution", "process_substitution"].includes(scope.type))
							isolated = true;
						scope = scope.parent;
					}
					if (!isolated)
						directoryChanges.push(node.parent?.type === "redirected_statement" ? node.parent.endIndex : node.endIndex);
				}
				const parent = node.parent;
				const rawNode =
					parent?.type === "redirected_statement" && parent.childForFieldName("body")?.id === node.id ? parent : node;
				const tokenNodes = [name, ...node.childrenForFieldName("argument")].filter(
					(value): value is Node => value !== null,
				);
				const redirects = [
					...node.childrenForFieldName("redirect"),
					...(rawNode === parent ? parent.childrenForFieldName("redirect") : []),
				].filter((value): value is Node => value !== null);
				const dirs = directoriesAt(states, node);
				const command: BashCommand = {
					...(movesDirectory ? { movesDirectory } : {}),
					...(dirs ? { dirs } : {}),
					raw: rawNode.text,
					tokens: tokenNodes.map((token) => ({
						raw: token.text,
						literal: token.id === name?.id ? staticWord(token) : word(token),
						start: token.startIndex - rawNode.startIndex,
						end: token.endIndex - rawNode.startIndex,
					})),
					assignments: node.namedChildren
						.filter((child): child is Node => child?.type === "variable_assignment")
						.map((assignment) => ({
							name: assignment.childForFieldName("name")?.text ?? "",
							raw: assignment.text,
						})),
					ambiguousRedirect: redirects.some(
						(redirect) =>
							redirect.childrenForFieldName("destination").length > 1 ||
							tokenNodes.some((token) => token.startIndex > redirect.startIndex),
					),
				};
				result.commands.push(command);
				// `sudo tee f` and `env cat f` run the program after their options: the same targets.
				const literals = command.tokens.map((token) => token.literal);
				const readerIndex = bashCandidates(command, "deny")
					.executables.flatMap((index) => [index, wrappedCommand(literals, index) ?? index])
					.find((index) => /^(?:tee|cat|head|tail|wc)$/.test(command.tokens[index]?.literal ?? ""));
				if (readerIndex !== undefined) {
					const reader = command.tokens[readerIndex].literal!;
					const kind = reader === "tee" ? "write" : "read";
					let countValue = false;
					let options = true;
					let redirectedBody = node;
					while (
						redirectedBody.parent?.type === "pipeline" &&
						redirectedBody.parent.namedChildren.at(-1)?.id === redirectedBody.id
					)
						redirectedBody = redirectedBody.parent;
					const redirects = [
						...node.childrenForFieldName("redirect"),
						...(redirectedBody.parent?.type === "redirected_statement"
							? redirectedBody.parent.childrenForFieldName("redirect")
							: []),
					];
					const argumentsInOrder = [
						...node.childrenForFieldName("argument"),
						...redirects.flatMap((redirect) => redirect?.childrenForFieldName("destination").slice(1) ?? []),
					]
						.filter((argument): argument is Node => argument !== null)
						.sort((a, b) => a.startIndex - b.startIndex);
					for (const argument of argumentsInOrder) {
						if (argument.startIndex < rawNode.startIndex + command.tokens[readerIndex].end) continue;
						const value = word(argument);
						if (countValue) {
							countValue = false;
							result.targets.push({
								kind: "read",
								raw: argument.text,
								path: value,
								position: argument.startIndex,
								policyOnly: true,
								...(!value || !/^[+-]?\d+[bBkKmMgGtTpPeEzZyY]?$/.test(value)
									? { uncertain: "unknown read count" }
									: {}),
							});
							continue;
						}
						if (options && value === "--") {
							options = false;
							continue;
						}
						if (reader !== "tee" && value === "-") {
							options = false;
							if (reader === "cat") continue;
						}
						if (options && value && reader !== "tee") {
							if ((reader === "head" || reader === "tail") && /^(?:-[nc]|--lines|--bytes)$/.test(value)) {
								countValue = true;
								continue;
							}
							const known =
								reader === "cat"
									? /^(?:-[AbeEnstTuv]+|--(?:show-all|number-nonblank|show-ends|number|squeeze-blank|show-tabs|show-nonprinting))$/
									: reader === "wc"
										? /^(?:-[clmwL]+|--(?:bytes|chars|lines|words|max-line-length))$/
										: /^(?:-[qv]+|-[nc][+-]?\d+[bBkKmMgGtTpPeEzZyY]?|-\d+|--(?:quiet|silent|verbose)|--(?:lines|bytes)=[+-]?\d+[bBkKmMgGtTpPeEzZyY]?)$/;
							if (reader === "tail" && /^\+\d+$/.test(value)) {
								result.targets.push({
									kind: "read",
									raw: argument.text,
									path: value,
									position: argument.startIndex,
									policyOnly: true,
								});
								continue;
							}
							if (known.test(value)) continue;
						}
						if (
							options &&
							value &&
							reader === "tee" &&
							/^(?:-[ai]+|--append|--ignore-interrupts|--output-error(?:=.*)?)$/.test(value)
						)
							continue;
						if (options && value?.startsWith("-")) {
							result.targets.push({
								kind,
								raw: argument.text,
								uncertain: `unknown ${reader} option`,
								position: argument.startIndex,
							});
							continue;
						}
						if (reader !== "tee") options = false;
						if (value !== "/dev/null")
							result.targets.push({
								kind,
								raw: argument.text,
								path: value,
								position: argument.startIndex,
								...(!value || value.startsWith("~") ? { uncertain: "dynamic file target" } : {}),
							});
					}
				}
			}
			// A here-string the grammar misread as `< word` (`cat > f <<< hi`) is input, not a file.
			if (node.type === "file_redirect" && !misreadHerestring(node)) {
				const destination = node.childForFieldName("destination");
				const operator = node.children.find((child) => child && !child.isNamed)?.text;
				if (destination) {
					const value = word(destination);
					if (/^(?:>&|<&)$/.test(operator ?? "") && value !== undefined && /^(?:\d+|-)$/.test(value)) continue;
					if (value !== "/dev/null")
						result.targets.push({
							kind: operator?.startsWith("<") ? "read" : "write",
							raw: destination.text,
							path: value,
							position: node.startIndex,
							...(!value || value.startsWith("~") ? { uncertain: "dynamic file target" } : {}),
						});
				}
			}
			for (let i = node.namedChildCount - 1; i >= 0; i--) pending.push({ node: node.namedChild(i)!, depth: depth + 1 });
		}
		for (const target of result.targets) {
			const dirs = directoriesAt(states, tree.rootNode.descendantForIndex(target.position));
			if (dirs) target.dirs = dirs;
			if (
				target.path &&
				!path.isAbsolute(target.path) &&
				directoryChanges.some((position) => position < target.position)
			)
				target.uncertain = RELATIVE_AFTER_CD;
		}
		if (!result.commands.length) incomplete("no command");
		return result;
	} catch {
		return unresolved("parse unavailable");
	} finally {
		tree?.delete();
		parser.delete();
	}
}
