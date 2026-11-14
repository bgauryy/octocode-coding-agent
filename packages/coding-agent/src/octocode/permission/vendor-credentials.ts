import os from "node:os";
import path from "node:path";
import { canonicalPath } from "../../../../common/src/canonical-path.ts";
import { canonicalPaths } from "../../../../common/src/canonical-path-set.ts";
import { claudeConfigDir } from "../../utils/host-config.ts";
import type { SourceGrant } from "./request.ts";

/**
 * The credential stores of other coding-agent command-line tools: Claude Code, Codex, OpenCode, the Copilot CLI and the Gemini CLI. A
 * read of one is a `credential.read` like a read of Octocode's own store, and also a `credential.vendor` reason, which
 * asks in `full` too: the tokens belong to another program's sign-in, which Octocode never needs to read. The user's
 * "Allow reads of <store> for this session" answers it for that store (`vendorGrant`), so it asks once per store.
 */
export interface VendorStore {
	id: "claude-code" | "codex" | "opencode" | "copilot" | "gemini";
	/** As the dialog names it: "Claude Code's credential store". */
	name: string;
}

const STORES: Record<VendorStore["id"], VendorStore> = {
	"claude-code": { id: "claude-code", name: "Claude Code's credential store" },
	codex: { id: "codex", name: "Codex's credential store" },
	opencode: { id: "opencode", name: "OpenCode's credential store" },
	copilot: { id: "copilot", name: "the Copilot CLI's credential store" },
	gemini: { id: "gemini", name: "the Gemini CLI's credential store" },
};

/** `file` lower-cased and canonical, as `credential-store.ts` keys its paths. */
const key = (file: string): string => canonicalPath(file).toLowerCase();

/** A variable a vendor store's path is spelled from, and the folder it stands for when it is not set. */
const VARIABLES: Record<string, (home: string) => string> = {
	CLAUDE_CONFIG_DIR: (home) => path.join(home, ".claude"),
	CODEX_HOME: (home) => path.join(home, ".codex"),
	XDG_DATA_HOME: (home) => path.join(home, ".local", "share"),
};

/** The folder `name` names now: its value, else its default under the home. */
const variableDir = (name: string, home: string): string => {
	const value = process.env[name];
	return value ? path.resolve(value) : (VARIABLES[name]?.(home) ?? home);
};

/** Each store's files and the folders that hold them; a variable's folder and its default both count. */
function storeLocations(): Array<[VendorStore, string[], string[]]> {
	const home = os.homedir();
	const claude = [...new Set([claudeConfigDir(home), path.join(home, ".claude")])];
	const codex = [...new Set([variableDir("CODEX_HOME", home), path.join(home, ".codex")])];
	const opencode = [
		...new Set(
			[variableDir("XDG_DATA_HOME", home), path.join(home, ".local", "share")].map((dir) => path.join(dir, "opencode")),
		),
	];
	const copilot = path.join(home, ".copilot");
	const gemini = path.join(home, ".gemini");
	return [
		[STORES["claude-code"], claude.map((dir) => path.join(dir, ".credentials.json")), claude],
		[STORES.codex, codex.map((dir) => path.join(dir, "auth.json")), codex],
		[STORES.opencode, opencode.map((dir) => path.join(dir, "auth.json")), opencode],
		[STORES.copilot, [path.join(copilot, "config.json")], [copilot]],
		[STORES.gemini, [path.join(gemini, "oauth_creds.json")], [gemini]],
	];
}

/** A lookup of the vendor store a file (an absolute path; `canonical`, its `key` when the caller has it) is, or a folder of; built once per check, its fixed paths canonicalized together and reused while the folders they resolve through stay unchanged. */
export function vendorStores(): (file: string, canonical?: string) => VendorStore | undefined {
	const spelled = storeLocations().flatMap(([store, files, folders]) =>
		[...files, ...folders].map((each): [VendorStore, string] => [store, each]),
	);
	const canonical = canonicalPaths(spelled.map(([, each]) => each));
	const at = new Map<string, VendorStore>();
	spelled.forEach(([store], index) => at.set(canonical[index].toLowerCase(), store));
	return (file, canonical = key(file)) => at.get(canonical);
}

/** `$CODEX_HOME/auth.json`, `${XDG_DATA_HOME}/opencode/auth.json`: the word with its leading vendor variable expanded, as the shell would. */
export function expandVendorVariable(word: string): string | undefined {
	const match = /^\$(?:\{(\w+)\}|(\w+))(\/.*)?$/.exec(word);
	const name = match?.[1] ?? match?.[2];
	if (!name || !Object.hasOwn(VARIABLES, name)) return undefined;
	return path.join(variableDir(name, os.homedir()), match?.[3] ?? "");
}

/** Commands that print a vendor tool's stored secrets, anywhere in a command line. */
const PRINTS: Array<[RegExp, VendorStore]> = [
	[/(?:^|[\s;|&(`'"])(?:\S*\/)?opencode\s+auth\s+export\b/, STORES.opencode],
];

/** The vendor store a command prints, and how the command spells it; undefined when it prints none. */
export function vendorPrint(command: string): { found: string; store: VendorStore } | undefined {
	for (const [pattern, store] of PRINTS) {
		const match = pattern.exec(command);
		if (match) return { found: match[0].trim().replace(/^[;|&(`'"]+/, ""), store };
	}
	return undefined;
}

/** The session answer of a vendor store read: "Allow reads of Claude Code's credential store for this session". */
export const vendorGrant = (store: VendorStore): SourceGrant => ({
	key: store.id,
	label: `reads of ${store.name}`,
	reason: "credential.vendor",
});
