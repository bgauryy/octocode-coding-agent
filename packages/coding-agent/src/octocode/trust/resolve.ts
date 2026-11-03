import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { type AgentDb, type FolderDecision, type FolderGrantRow, trust } from "../../../../db/src/api.ts";
import { sharedAgentDb } from "../../config/database.ts";
import { agentDbPath } from "../shared/home.ts";
import {
	folderChain,
	folderEntry,
	homeFolder,
	realFolder,
	refusedRoot,
	type FolderEntry,
	type RefusedRoot,
} from "./identity.ts";

/**
 * The one answer to "may Octocode open this folder?": a stored decision of the user, looked up by folder identity. No
 * prompt, no project file read, no content comparison; deciding what to do with the answer (prompt, refuse, exit) is the
 * gate's job. A trusting grant covers its folder (`scope` folder) or the folder and everything under it (`subtree`); the
 * nearest decision wins, so a refusal inside a trusted subtree stands.
 */

export type GrantScope = "folder" | "subtree";
export type GrantSource = "prompt" | "command" | "flag" | "worktree" | "import";

/** Where, how and by whom a decision was made. */
interface GrantInfo {
	id: number;
	scope: GrantScope;
	source: GrantSource;
	/** Where the folder holding the decision was last seen. */
	path: string;
	decidedBy: string;
	decidedAt: number;
}

/** A stored decision on the home folder or a filesystem root: never applied, reported so the caller can say so. */
interface IgnoredGrant {
	id: number;
	path: string;
	decision: FolderDecision;
	reason: RefusedRoot;
}

interface Common {
	/** The real path of the folder that was asked about. */
	path: string;
	ignoredGrants: IgnoredGrant[];
}

export type FolderTrust =
	/** The user trusted this folder or an ancestor. `root` is the folder the grant is on. */
	| (Common & { state: "trusted"; root: string; grant: GrantInfo })
	/** The user recorded "Do not trust" for this folder or an ancestor. `root` is the folder the refusal is on. */
	| (Common & { state: "refused"; root: string; grant: GrantInfo })
	/** Eligible and not decided: ask the user (or refuse headless). */
	| (Common & { state: "undecided" })
	/** Cannot be granted or cannot be read: not asked about. */
	| (Common & {
			state: "untrusted";
			reason: RefusedRoot | "store-unavailable" | "missing-folder";
			detail?: string;
	  });

/** Where the trust records are read from; the defaults are the process environment, the user's home and its shared connection. */
export interface TrustOptions {
	/** The user's home folder, which no grant may cover. */
	home?: string;
	/** Environment that names the agent database (`OCTOCODE_AGENT_DB`). */
	env?: NodeJS.ProcessEnv;
	/** An already open agent database (tests; the default is `sharedAgentDb(env)`). */
	db?: AgentDb;
}

export function trustDb(options: TrustOptions): AgentDb {
	return options.db ?? sharedAgentDb(options.env);
}

function unavailable(error: unknown, options: TrustOptions): string {
	let file = "the agent database";
	try {
		file = agentDbPath(options.env);
	} catch {
		// The message below still names the cause.
	}
	return `Cannot read Octocode's trust records at ${file}: ${errorMessage(error)}`;
}

export function resolveFolderTrust(cwd: string, options: TrustOptions = {}): FolderTrust {
	const canonical = realFolder(cwd);
	if (canonical === undefined)
		return {
			state: "untrusted",
			path: cwd,
			reason: "missing-folder",
			ignoredGrants: [],
			detail: "The folder does not exist.",
		};
	const home = homeFolder(options.home);
	// Opening the folder itself needs no subtree grant, so only the home folder and a filesystem root are refused here.
	const refused = refusedRoot(canonical, home, "folder");
	if (refused) return { state: "untrusted", path: canonical, reason: refused, ignoredGrants: [] };

	let chain: FolderEntry[];
	try {
		chain = folderChain(canonical).map(folderEntry);
	} catch (error) {
		return {
			state: "untrusted",
			path: canonical,
			reason: "missing-folder",
			ignoredGrants: [],
			detail: errorMessage(error),
		};
	}

	let db: AgentDb;
	let rows: FolderGrantRow[];
	try {
		db = trustDb(options);
		rows = trust.liveFoldersFor(db.db, chain);
	} catch (error) {
		return {
			state: "untrusted",
			path: canonical,
			reason: "store-unavailable",
			ignoredGrants: [],
			detail: unavailable(error, options),
		};
	}

	// Chain position of each live row, matched by identity: an exact match first, else the folder seen on a remounted volume.
	const ignoredGrants: IgnoredGrant[] = [];
	let nearest: { depth: number; row: FolderGrantRow } | undefined;
	for (const [depth, entry] of chain.entries()) {
		const row =
			rows.find((candidate) => trust.sameFolder(candidate, entry) === "exact") ??
			rows.find((candidate) => trust.sameFolder(candidate, entry) === "remounted");
		if (!row) continue;
		const reason = refusedRoot(entry.path, home, row.scope);
		if (reason) {
			ignoredGrants.push({ id: row.id, path: entry.path, decision: row.decision, reason });
			continue;
		}
		// A folder's own row covers it whatever its scope; an ancestor's row only when it covers the subtree.
		if (depth > 0 && row.scope !== "subtree") continue;
		nearest ??= { depth, row };
	}
	if (!nearest) return { state: "undecided", path: canonical, ignoredGrants };

	const { row, depth } = nearest;
	const { path: root, dev } = chain[depth];
	if (row.path !== root || row.dev !== dev) {
		try {
			trust.refreshSeen(db.db, row.id, root, dev);
		} catch {
			// A read-only or busy database keeps the old path and device; this decision is unaffected, and a remounted row
			// still matches by inode, birth time and path next time.
		}
	}
	const grant: GrantInfo = {
		id: row.id,
		scope: row.scope,
		source: row.source as GrantSource,
		path: root,
		decidedBy: row.decidedBy,
		decidedAt: row.decidedAt,
	};
	return { state: row.decision === "refused" ? "refused" : "trusted", path: canonical, root, grant, ignoredGrants };
}
