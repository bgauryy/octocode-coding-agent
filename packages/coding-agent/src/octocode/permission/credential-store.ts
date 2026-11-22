import os from "node:os";
import path from "node:path";
import { getAgentDir, getLegacyConfigDirs, getOctocodeHome } from "../../config.ts";
import { shellPath, homeSpelling } from "./file-access.ts";
import { canonicalPath } from "@octocodeai/octocode-common/canonical-path";
import { canonicalPaths } from "@octocodeai/octocode-common/canonical-path-set";
import { OCTOCODE_DIR, resolveToolPath } from "../shared/home.ts";
import { readerLocations } from "../shared/local-reads.ts";
import { isMcpToolName } from "@octocodeai/octocode-common/mcp-names";
import { SHELL_TOOLS } from "./shell.ts";
import { optionalString } from "../shared/util.ts";
import { projectModelsPaths } from "../../core/model-config/project.ts";
import { modelsFileHoldsLiteralKey } from "../../core/models-json-keys.ts";
import type { AskReason } from "./mode.ts";
import type { SourceGrant } from "./request.ts";
import {
	expandVendorVariable,
	vendorGrant,
	vendorPrint,
	vendorStores,
	type VendorStore,
} from "./vendor-credentials.ts";

/**
 * Reads of Octocode's credential store: the `auth.json` files a session loads keys from (the agent directory's, the
 * Octocode home's, and Pi's when Pi's roots are a read-only fallback), a `models.json` that holds a literal `apiKey`, the
 * MCP OAuth tokens in `mcp-auth.json`, the credential files of other command-line tools under the home (`~/.aws/credentials`,
 * `~/.netrc`, …), the OS keychain commands that read an entry back (`security find-generic-password … -w`, `secret-tool lookup`, a PowerShell run with `-EncodedCommand`: the Windows Credential Manager read),
 * and `octocode auth print-api-key` / `print-bearer-token`. What they print enters the model context, so a
 * read is a `credential.read` reason: it asks in `manual` and `workspace`, and `full` runs it and records it. A read of
 * another coding agent's store (`vendor-credentials.ts`) also carries `credential.vendor`, which asks in `full` too. Writes are
 * not decided here: `stateFolderRefusal` refuses those in every mode. Best effort, not a sandbox: a path the call does
 * not spell (`cat $X`, a glob, a program that computes it) is not seen.
 */

/** The folder names whose child folder may hold a store: a read of the Octocode or Pi root folder under the home can list or search the store under it. */
const CREDENTIAL_ROOTS = new Set([OCTOCODE_DIR.toLowerCase(), ".pi"]);
/** Provider keys (`auth.json`) and MCP OAuth tokens (`mcp-auth.json`, beside it in the agent directory). */
const STORE_FILES = ["auth.json", "mcp-auth.json"];
/** The model list: a credential file only when it holds a literal `apiKey` (a `$NAME` or `!command` reference holds no secret). */
const MODELS_FILE = "models.json";
/** Credential files of common command-line tools, relative to the home folder. */
const CLI_CREDENTIAL_FILES = [
	".aws/credentials",
	".config/gh/hosts.yml",
	".config/gcloud/application_default_credentials.json",
	".config/gcloud/credentials.db",
	".azure/accessTokens.json",
	".docker/config.json",
	".kube/config",
	".netrc",
	".npmrc",
	".pypirc",
	".git-credentials",
];
/** Words checked per shell command, so a very long command costs a bounded number of file-system lookups. */
const WORD_LIMIT = 400;

/** `file` lower-cased and canonical: a case-insensitive file system names one file several ways, and the extra match only asks. */
const key = (file: string): string => canonicalPath(file).toLowerCase();

/** The `auth.json` paths a session reads, and the folders whose read can reach one: each store's folder, and its parent when that is an Octocode or Pi root folder. */
function credentialPaths(cwd: string): { files: Set<string>; models: Set<string>; folders: Set<string> } {
	const homes = new Set([getAgentDir(), getOctocodeHome(), ...getLegacyConfigDirs()]);
	const spelled: Array<["files" | "models" | "folders", string]> = [];
	for (const home of homes) {
		for (const name of STORE_FILES) spelled.push(["files", path.join(home, name)]);
		spelled.push(["models", path.join(home, MODELS_FILE)], ["folders", home]);
		const parent = path.dirname(home);
		if (CREDENTIAL_ROOTS.has(path.basename(parent).toLowerCase()) && parent !== os.homedir())
			spelled.push(["folders", parent]);
	}
	// A project models.json (read once its folder is trusted) holds literal keys like the global one.
	for (const file of projectModelsPaths(cwd, true)) spelled.push(["models", file]);
	for (const name of CLI_CREDENTIAL_FILES) spelled.push(["files", path.join(os.homedir(), name)]);
	// Canonicalized together, and reused while none of the folders they resolve through changes.
	const canonical = canonicalPaths(spelled.map(([, file]) => file));
	const found = { files: new Set<string>(), models: new Set<string>(), folders: new Set<string>() };
	spelled.forEach(([kind], index) => found[kind].add(canonical[index].toLowerCase()));
	return found;
}

/** What a read of a credential store found: the path or command that reads it, and the vendor store when it is another tool's. */
export interface CredentialHit {
	found: string;
	store?: VendorStore;
}

/** Whether reading a file (an absolute path) can read a credential store: it is one, or a folder that holds one. Paths are resolved once per check. */
function storeLookup(cwd: string): (file: string) => { store?: VendorStore } | undefined {
	const { files, models, folders } = credentialPaths(cwd);
	const vendor = vendorStores();
	return (file) => {
		const at = key(file);
		const store = vendor(file, at);
		if (store) return { store };
		return files.has(at) || folders.has(at) || (models.has(at) && modelsFileHoldsLiteralKey(canonicalPath(file)))
			? {}
			: undefined;
	};
}

/** The programs and subcommands that print a keychain entry (or the keychain's contents), anywhere in a command line. */
const KEYCHAIN_READ =
	/(?:^|[\s;|&(`'"])(?:\/usr\/bin\/)?security\s+(?:-\S+\s+)*(?:find-generic-password|find-internet-password|dump-keychain)\b|(?:^|[\s;|&(`'"])(?:\/usr\/bin\/)?security\s+-i\b|(?:^|[\s;|&(`'"])secret-tool\s+(?:lookup|search)\b/;

/**
 * A PowerShell host run with an encoded script (`-EncodedCommand`, `-enc`, `-e`: PowerShell accepts any prefix of the
 * name from `-e`). The script is opaque and is how the Windows Credential Manager backend reads a secret, so it may print one.
 */
const POWERSHELL_HOST = /(?:^|[\s;|&(`'"\\/])(?:powershell|pwsh)(?:\.exe)?(?=[\s'"])/i;
const POWERSHELL_FLAG = /(?:^|\s)-(e[a-z]*)(?=[\s:'"]|$)/gi;

function powershellEncoded(command: string): boolean {
	const host = POWERSHELL_HOST.exec(command);
	if (!host) return false;
	for (const [, name] of command.slice(host.index).matchAll(POWERSHELL_FLAG))
		if ("encodedcommand".startsWith(name.toLowerCase())) return true;
	return false;
}

/** A word a command line spells that cannot be resolved before it runs, and still names the store file. */
const UNRESOLVED_STORE = /[$*?[`]/;

/** `octocode auth print-api-key` and `print-bearer-token`, which print a stored key or token, anywhere in a command line. */
const OCTOCODE_PRINT = /(?:^|[\s;|&(`'"])(?:\S*\/)?octocode\s+auth\s+print-(?:api-key|bearer-token)\b/;

/** What a shell command reads of a store: a command that prints one, else the first word naming one; undefined when it names none. */
function shellCredentialRead(command: string, cwd: string): CredentialHit | undefined {
	const printed = vendorPrint(command);
	if (printed) return printed;
	if (OCTOCODE_PRINT.test(command)) return { found: "octocode auth print-*" };
	if (KEYCHAIN_READ.test(command) || powershellEncoded(command)) return { found: "the keychain read command" };
	// Quotes only group words (`"$HOME"/x`, `bash -c "cat ~/x"`): dropped, the words of an inner script are read like the rest.
	const words = command
		.replace(/["'`]/g, "")
		.split(/[\s;|&()<>=,]+/)
		.filter(Boolean)
		.slice(0, WORD_LIMIT);
	// Built on the first word that may name a store: most commands name none.
	let built: ReturnType<typeof storeLookup> | undefined;
	const lookup = (file: string) => (built ??= storeLookup(cwd))(file);
	for (const word of words) {
		const base = path.basename(word).toLowerCase();
		const storeName = STORE_FILES.find((name) => base === name);
		if (!storeName && base !== MODELS_FILE && !/[/\\~$.]/.test(word[0] ?? "") && !word.includes("/")) continue;
		const vendorPath = expandVendorVariable(word);
		const vendor = vendorPath === undefined ? undefined : lookup(vendorPath)?.store;
		if (vendor) return { found: word, store: vendor };
		if (storeName && UNRESOLVED_STORE.test(word)) return { found: storeName };
		const hit = lookup(shellPath(cwd, homeSpelling(word) ?? word));
		if (hit) return { found: word, ...hit };
	}
	return undefined;
}

/**
 * What `toolName` called with `input` reads of a credential store (Octocode's, another tool's, or another coding
 * agent's: `store`), for the `credential.read` reason: the path or command that does, or undefined. Covers `bash` and `powershell` commands and the locations an MCP
 * tool's input names (`path`, `workspaceRoot`, … : the research tools' queries).
 */
export function credentialHit(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): CredentialHit | undefined {
	if (SHELL_TOOLS.has(toolName)) return shellCredentialRead(optionalString(input.command) ?? "", cwd);
	if (!isMcpToolName(toolName)) return undefined;
	const { files } = readerLocations(input);
	if (files.length === 0) return undefined;
	const lookup = storeLookup(cwd);
	for (const file of files) {
		const hit = lookup(resolveToolPath(cwd, file));
		if (hit) return { found: file, ...hit };
	}
	return undefined;
}

/** `credentialHit`'s path or command alone. */
export const credentialRead = (toolName: string, input: Record<string, unknown>, cwd: string): string | undefined =>
	credentialHit(toolName, input, cwd)?.found;

/** The system line a `credential.read` request carries, from what `credentialRead` found. */
const credentialReason = (found: string): string =>
	`reads a credential file or store (${found}): API keys and tokens in it would enter the model context`;

/**
 * The reasons, reason line and session answer a credential read adds to its request. A vendor store read adds
 * `credential.vendor` (asks in every mode) until the user allows that store for the session (`granted`); after that it
 * is an ordinary `credential.read`.
 */
export function credentialAsk(
	hit: CredentialHit | undefined,
	granted: (grant: SourceGrant) => boolean,
): { reasons: AskReason[]; reason: string; grant?: SourceGrant } | undefined {
	if (!hit) return undefined;
	const { store } = hit;
	const grant = store && vendorGrant(store);
	if (!store || !grant || granted(grant)) return { reasons: ["credential.read"], reason: credentialReason(hit.found) };
	return {
		reasons: ["credential.read", "credential.vendor"],
		reason: `reads ${store.name} (${hit.found}): another program's sign-in tokens would enter the model context, so this asks in every mode`,
		grant,
	};
}
