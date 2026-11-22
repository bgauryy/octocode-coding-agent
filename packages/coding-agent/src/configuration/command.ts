import { parseMcpAddArgs } from "../../../mcp/src/api.ts";
import type { ConfigCatalog } from "./catalog.ts";
import type { AppliesWhen, ConfigEntry, ConfigOp, ConfigResult, ConfigScope } from "./types.ts";

/**
 * The text form of the configuration verbs, shared by `/settings <verb>` and `octocode configuration <verb>`: it
 * parses the words, runs them on the catalog and returns what to print. Front-ends only print `lines` and use `ok` for the
 * exit code (or the warning level).
 */

export interface ConfigCommandOutcome {
	/** False when a verb was refused or the words were wrong. */
	ok: boolean;
	lines: string[];
	/** What `--json` prints: entries for a read, results for a write. */
	json: unknown;
}

export interface ParsedConfigWords {
	/** The words that belong to the command, flags removed. */
	words: string[];
	local: boolean;
	json: boolean;
	trust: boolean;
	/** `--force`: switch off what is kept on (a gate hook). */
	force: boolean;
}

/** Words of a typed line; quotes group inside a word too (`KEY="a b"`) and are removed. */
export function splitConfigWords(text: string): string[] {
	const pattern = /(?:"[^"]*"|'[^']*'|[^\s"']|["'])+/g;
	return (text.match(pattern) ?? []).map((word) =>
		word.replace(/"([^"]*)"|'([^']*)'/g, (_, double, single) => double ?? single),
	);
}

/** Takes `--local`/`-l`, `--json` and `--trust` out of the words before `--`; after `--` the words are a server's own. */
export function parseConfigWords(tokens: readonly string[]): ParsedConfigWords {
	const end = tokens.indexOf("--");
	const own = end === -1 ? tokens : tokens.slice(0, end);
	const rest = end === -1 ? [] : tokens.slice(end);
	const words = own.filter((word) => !["-l", "--local", "--json", "--trust", "--force"].includes(word));
	return {
		words: [...words, ...rest],
		local: own.includes("-l") || own.includes("--local"),
		json: own.includes("--json"),
		trust: own.includes("--trust"),
		force: own.includes("--force"),
	};
}

/** One line per verb; `name` is the front-end's way to start the command (`/settings`, `octocode configuration`). */
function configurationUsage(name: string): string[] {
	return [
		`Usage: ${name} [list [kind|text] | get <id> | enable <id>... | disable <id>... [--force] | set <key> <value> | unset <key> | add mcp <name> ... | remove <id>] [--local]`,
		"An id is kind:name (tool:backlog, mcp:octocode, harness:claude, skill:name, provider:id) or a settings key (theme, bash.spillMaxBytes).",
		"--local (-l) writes this project's files; without it the change is global. Project scope needs a trusted folder.",
	];
}

const APPLIES: Record<AppliesWhen, string> = {
	now: "applies now",
	reload: "applies after /reload, or in the next session",
	"next-session": "applies in the next session",
};

export const appliesText = (when: AppliesWhen): string => APPLIES[when];

const stateText = (entry: ConfigEntry): string => {
	if (entry.valueType.type === "toggle") return entry.value === false ? "off" : "on";
	if (entry.value === undefined) return "(unset)";
	return typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value);
};

/** The entries grouped by kind: id, state, the scope that set it, when a change applies. */
function formatEntries(all: readonly ConfigEntry[], limit: number, filtered: boolean): string[] {
	if (all.length === 0) return ["Nothing matches."];
	const hidden = Math.max(all.length - limit, 0);
	const entries = all.slice(0, all.length - hidden);
	const lines: string[] = [];
	let kind = "";
	const width = Math.min(48, Math.max(...entries.map((entry) => entry.id.length)));
	for (const entry of entries) {
		if (entry.kind !== kind) {
			kind = entry.kind;
			lines.push("", `${kind}:`);
		}
		const locked = entry.locked ? `  locked: ${entry.locked}` : "";
		lines.push(
			`  ${entry.id.padEnd(width)}  ${stateText(entry).padEnd(8)}  ${entry.setBy.padEnd(8)}  ${entry.appliesWhen}${locked}`,
		);
	}
	if (hidden)
		lines.push(
			"",
			`… ${hidden} more entries. ${filtered ? "Narrow it: /settings list <kind> <text>" : "Filter: /settings list <kind>|<text>"} (--json lists all)`,
		);
	return lines.slice(1);
}

function formatEntry(entry: ConfigEntry): string[] {
	const lines = [`${entry.id}${entry.label !== entry.id ? ` (${entry.label})` : ""}`];
	if (entry.description) lines.push(entry.description);
	lines.push(`value: ${stateText(entry)} (set by ${entry.setBy}; ${APPLIES[entry.appliesWhen]})`);
	for (const scope of ["global", "project", "run"] as const)
		if (entry.scopes[scope] !== undefined) lines.push(`  ${scope}: ${JSON.stringify(entry.scopes[scope])}`);
	if (entry.default !== undefined) lines.push(`default: ${JSON.stringify(entry.default)}`);
	if (entry.detail) lines.push(`detail: ${entry.detail}`);
	if (entry.locked) lines.push(`locked: ${entry.locked}`);
	return lines;
}

export function formatResult(result: ConfigResult): string[] {
	if (result.status === "applied") return [`${result.message} (${APPLIES[result.appliesWhen]})`];
	const lines = [`Refused ${result.verb} ${result.id}: ${result.reason}`];
	if (result.suggestions?.length) lines.push(`Did you mean: ${result.suggestions.join(", ")}?`);
	return lines;
}

const outcomeOf = (results: readonly ConfigResult[]): ConfigCommandOutcome => ({
	ok: results.every((result) => result.status === "applied"),
	lines: results.flatMap(formatResult),
	json: results,
});

const bad = (...lines: string[]): ConfigCommandOutcome => ({ ok: false, lines, json: { error: lines.join("\n") } });

/** Runs one verb with its words on the catalog. `usageName` heads the usage text in an error. */
export async function runConfigWords(
	catalog: ConfigCatalog,
	tokens: readonly string[],
	usageName: string,
	limits: { listRows: number } = { listRows: Number.POSITIVE_INFINITY },
): Promise<ConfigCommandOutcome> {
	const { words, local, force } = parseConfigWords(tokens);
	const scope: ConfigScope = local ? "project" : "global";
	const [verb = "list", ...args] = words;
	const usage = configurationUsage(usageName);
	// One op after the other: each reads the saved state the previous one wrote (two tools in `defaultTools`, for one).
	const write = async (ops: ConfigOp[]) => {
		const results: ConfigResult[] = [];
		for (const op of ops) results.push(await catalog.apply(op));
		const outcome = outcomeOf(results);
		outcome.lines.push(...(await catalog.settle(results)));
		return outcome;
	};
	switch (verb) {
		case "help":
			return { ok: true, lines: usage, json: { usage } };
		case "list": {
			const kinds = catalog.kinds();
			const [first, ...more] = args;
			const asKind = first === "setting" || (first !== undefined && kinds.includes(first));
			const entries = await catalog.list(
				asKind
					? { kinds: [first], ...(more.length ? { text: more.join(" ") } : {}) }
					: args.length
						? { text: args.join(" ") }
						: {},
			);
			return { ok: true, lines: formatEntries(entries, limits.listRows, args.length > 0), json: entries };
		}
		case "get": {
			if (args.length !== 1) return bad(...usage);
			const entry = await catalog.get(args[0]);
			if (entry) return { ok: true, lines: formatEntry(entry), json: entry };
			const near = (await catalog.list({ text: args[0] })).slice(0, 5).map((found) => found.id);
			return bad(`No configuration entry "${args[0]}".${near.length ? ` Did you mean: ${near.join(", ")}?` : ""}`);
		}
		case "enable":
		case "disable":
			return args.length ? write(args.map((id) => ({ verb, id, scope, ...(force ? { force } : {}) }))) : bad(...usage);
		case "unset":
		case "remove":
			return args.length ? write(args.map((id) => ({ verb, id, scope }))) : bad(...usage);
		case "set": {
			const [first, ...rest] = args;
			const equals = first?.indexOf("=") ?? -1;
			if (first && rest.length === 0 && equals > 0)
				return write([{ verb, id: first.slice(0, equals), value: first.slice(equals + 1), scope }]);
			return first && rest.length ? write([{ verb, id: first, value: rest.join(" "), scope }]) : bad(...usage);
		}
		case "add": {
			const end = tokens.indexOf("--");
			const head = (end === -1 ? tokens : tokens.slice(0, end)).filter(
				(word) => word !== "--json" && word !== "--trust",
			);
			const own = end === -1 ? head : [...head, ...tokens.slice(end)];
			return addWords(catalog, own.slice(own.indexOf("add") + 1), scope, usage);
		}
		default:
			return bad(`Unknown verb "${verb}".`, ...usage);
	}
}

/** `add mcp <server> [options] (--url <url> | -- <command> [args...])`: the arguments of `octocode mcp add`. */
async function addWords(
	catalog: ConfigCatalog,
	tokens: string[],
	scope: ConfigScope,
	usage: string[],
): Promise<ConfigCommandOutcome> {
	const [kind, ...rest] = tokens;
	if (kind !== "mcp")
		return bad(
			"add takes a kind, and only mcp has one: add mcp <name> (--url <url> | -- <command> [args...]).",
			...usage,
		);
	const errors: string[] = [];
	// `-l` and `--local` are already the scope; the MCP parser reads them too, so hand it the original words.
	const parsed = parseMcpAddArgs(
		rest,
		(line) => errors.push(line),
		"Usage: add mcp <name> [options] (--url <url> | -- <command> [args...])",
	);
	if (!parsed) return bad(...errors);
	return outcomeOf([
		await catalog.apply({
			verb: "add",
			id: `mcp:${parsed.name}`,
			value: parsed.config,
			scope: parsed.project ? "project" : scope,
		}),
	]);
}
