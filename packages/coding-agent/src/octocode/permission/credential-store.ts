import os from "node:os";
import path from "node:path";
import { getAgentDir, getLegacyConfigDirs, getOctocodeHome } from "../../config.ts";
import { shellPath, homeSpelling } from "./file-access.ts";
import { canonicalPath } from "../shared/home/repo.ts";
import { OCTOCODE_DIR, resolveToolPath } from "../shared/home.ts";
import { readerLocations } from "../shared/local-reads.ts";
import { isMcpToolName } from "../../../../mcp/src/servers.ts";
import { SHELL_TOOLS } from "./shell.ts";
import { optionalString } from "../shared/util.ts";

/**
 * Reads of Octocode's credential store: the `auth.json` files a session loads keys from (the agent directory's, the
 * Octocode home's, and Pi's when Pi's roots are a read-only fallback), the MCP OAuth tokens in `mcp-auth.json`, and the OS keychain commands that read an entry
 * back (`security find-generic-password … -w`, `secret-tool lookup`). What they print enters the model context, so a
 * read is a `credential.read` reason: it asks in `manual` and `workspace`, and `full` runs it and records it. Writes are
 * not decided here: `stateFolderRefusal` refuses those in every mode. Best effort, not a sandbox: a path the call does
 * not spell (`cat $X`, a glob, a program that computes it) is not seen.
 */

/** The folder names whose child folder may hold a store: a read of the Octocode or Pi root folder under the home can list or search the store under it. */
const CREDENTIAL_ROOTS = new Set([OCTOCODE_DIR.toLowerCase(), ".pi"]);
/** Provider keys (`auth.json`) and MCP OAuth tokens (`mcp-auth.json`, beside it in the agent directory). */
const STORE_FILES = ["auth.json", "mcp-auth.json"];
/** Words checked per shell command, so a very long command costs a bounded number of file-system lookups. */
const WORD_LIMIT = 400;

/** `file` lower-cased and canonical: a case-insensitive file system names one file several ways, and the extra match only asks. */
const key = (file: string): string => canonicalPath(file).toLowerCase();

/** The `auth.json` paths a session reads, and the folders whose read can reach one: each store's folder, and its parent when that is an Octocode or Pi root folder. */
function credentialPaths(): { files: Set<string>; folders: Set<string> } {
	const homes = new Set([getAgentDir(), getOctocodeHome(), ...getLegacyConfigDirs()]);
	const files = new Set<string>();
	const folders = new Set<string>();
	for (const home of homes) {
		for (const name of STORE_FILES) files.add(key(path.join(home, name)));
		folders.add(key(home));
		const parent = path.dirname(home);
		if (CREDENTIAL_ROOTS.has(path.basename(parent).toLowerCase()) && parent !== os.homedir()) folders.add(key(parent));
	}
	return { files, folders };
}

/** Whether reading `file` (an absolute path) can read a credential store: it is one, or a folder that holds one. */
function touchesCredentialStore(file: string): boolean {
	const { files, folders } = credentialPaths();
	const at = key(file);
	return files.has(at) || folders.has(at);
}

/** The programs and subcommands that print a keychain entry (or the keychain's contents), anywhere in a command line. */
const KEYCHAIN_READ =
	/(?:^|[\s;|&(`'"])(?:\/usr\/bin\/)?security\s+(?:-\S+\s+)*(?:find-generic-password|find-internet-password|dump-keychain)\b|(?:^|[\s;|&(`'"])(?:\/usr\/bin\/)?security\s+-i\b|(?:^|[\s;|&(`'"])secret-tool\s+(?:lookup|search)\b/;

/** A word a command line spells that cannot be resolved before it runs, and still names the store file. */
const UNRESOLVED_STORE = /[$*?[`]/;

/** What a shell command reads of the store: the first word naming it, or the keychain read; undefined when it names none. */
function shellCredentialRead(command: string, cwd: string): string | undefined {
	if (KEYCHAIN_READ.test(command)) return "the keychain read command";
	// Quotes only group words (`"$HOME"/x`, `bash -c "cat ~/x"`): dropped, the words of an inner script are read like the rest.
	const words = command
		.replace(/["'`]/g, "")
		.split(/[\s;|&()<>=,]+/)
		.filter(Boolean)
		.slice(0, WORD_LIMIT);
	for (const word of words) {
		const storeName = STORE_FILES.find((name) => path.basename(word).toLowerCase() === name);
		if (!storeName && !/[/\\~$.]/.test(word[0] ?? "") && !word.includes("/")) continue;
		if (storeName && UNRESOLVED_STORE.test(word)) return storeName;
		const spelled = homeSpelling(word) ?? word;
		if (touchesCredentialStore(shellPath(cwd, spelled))) return word;
	}
	return undefined;
}

/**
 * What `toolName` called with `input` reads of Octocode's credential store, for the `credential.read` reason: the path or
 * command that does, or undefined. Covers `bash` and `powershell` commands and the locations an MCP
 * tool's input names (`path`, `workspaceRoot`, … : the research tools' queries).
 */
export function credentialRead(toolName: string, input: Record<string, unknown>, cwd: string): string | undefined {
	if (SHELL_TOOLS.has(toolName)) return shellCredentialRead(optionalString(input.command) ?? "", cwd);
	if (!isMcpToolName(toolName)) return undefined;
	const { files } = readerLocations(input);
	return files.find((file) => touchesCredentialStore(resolveToolPath(cwd, file)));
}

/** The system line a `credential.read` request carries, from what `credentialRead` found. */
export const credentialReason = (found: string): string =>
	`reads Octocode's credential store (${found}): API keys and tokens in it would enter the model context`;
