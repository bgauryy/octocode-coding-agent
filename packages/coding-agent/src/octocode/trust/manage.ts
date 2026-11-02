import path from "node:path";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { FolderGrantRefusedError } from "./errors.ts";
import {
	grantFolder,
	listFolderGrants,
	revokeFolder,
	type FolderGrantView,
	type GrantResult,
	type GrantTarget,
} from "./grants.ts";
import { folderEntry, homeFolder, realFolder, refusedRoot } from "./identity.ts";
import { homeFolderMessage, shown } from "./messages.ts";
import { type FolderTrust, resolveFolderTrust, type TrustOptions } from "./resolve.ts";

/**
 * What `/trust` and `octocode trust` do, once, so the two cannot drift: describe the stored decisions, add one, remove one.
 * Nothing here asks the user or draws a screen; the callers confirm and print. Every failure is a `TrustCommandError`
 * whose message is ready to show.
 */

export class TrustCommandError extends Error {}

export type TrustSurface = "tui" | "cli" | "rpc" | "print" | "json" | "web" | "acp";

/** The live decisions (grants, refusals and ignored root grants), newest first. */
export function liveGrants(options: TrustOptions = {}): FolderGrantView[] {
	try {
		return listFolderGrants(options).filter((row) => row.revokedAt === undefined);
	} catch (error) {
		throw new TrustCommandError(errorMessage(error));
	}
}

const IGNORED_WHY = {
	home: "home folder",
	"filesystem-root": "filesystem root",
	"contains-home": "above your home folder",
} as const;
const day = (at: number): string => new Date(at).toISOString().slice(0, 10);
const scopeText = (row: FolderGrantView): string =>
	row.source === "worktree" ? "worktree" : row.scope === "subtree" ? "subtree" : "this folder";

/** One entry as one row of text: `#4 trusted ~/code/app  this folder · prompt · you · 2026-10-02`. */
export function describeGrant(row: FolderGrantView, home?: string): string {
	const where = shown(row.path, home);
	if (row.ignored)
		return `#${row.id} ignored  ${where}  ${IGNORED_WHY[row.ignoredReason ?? "home"]}: a grant here would cover every project on this computer, so it is not applied`;
	const by = [scopeText(row), row.source, row.decidedBy, day(row.decidedAt)].join(" \u00b7 ");
	const from = row.fromPath ? ` (from ${shown(row.fromPath, home)})` : "";
	return `#${row.id} ${row.decision === "refused" ? "refused" : "trusted"}  ${where}  ${by}${from}`;
}

/** Where the opened folder stands: one sentence. */
export function describeFolder(cwd: string, state: FolderTrust, home?: string): string {
	const name = shown(state.path || cwd, home);
	switch (state.state) {
		case "trusted":
		case "refused": {
			const verb = state.state === "trusted" ? "trusted" : "marked do not trust";
			const here = state.root === state.path;
			const reach = here
				? state.grant.scope === "subtree"
					? " and everything under it"
					: ""
				: ` by ${shown(state.root, home)} and everything under it`;
			return `${name} is ${verb}${reach} (${state.grant.source}, ${day(state.grant.decidedAt)}).`;
		}
		case "undecided":
			return `${name} has no trust decision yet.`;
		case "untrusted":
			return state.reason === "home" || state.reason === "filesystem-root"
				? homeFolderMessage(state.path, state.reason)
				: `${name} cannot be checked: ${state.detail ?? state.reason}`;
	}
}

/** The whole listing: where the opened folder stands, then every live decision. */
export function describeAll(cwd: string, options: TrustOptions = {}): string {
	const rows = liveGrants(options);
	const home = options.home ? homeFolder(options.home) : undefined;
	const lines = [describeFolder(cwd, resolveFolderTrust(cwd, options), home)];
	lines.push(
		rows.length === 0
			? "No trust decisions are stored."
			: `Trust decisions (newest first):\n${rows.map((row) => `  ${describeGrant(row, home)}`).join("\n")}`,
	);
	return lines.join("\n");
}

export const GRANT_TARGETS: readonly GrantTarget[] = ["folder", "parent", "grandparent"];

/** The folder a grant on `which` would cover (without writing anything), or why it cannot be granted. */
export function grantPath(cwd: string, which: GrantTarget, options: TrustOptions = {}): string {
	const real = realFolder(cwd);
	if (real === undefined) throw new TrustCommandError(`${shown(cwd)} does not exist.`);
	let folder = real;
	for (let step = 0; step < GRANT_TARGETS.indexOf(which); step += 1) folder = path.dirname(folder);
	const reason = refusedRoot(folder, homeFolder(options.home), which === "folder" ? "folder" : "subtree");
	if (reason) throw new TrustCommandError(homeFolderMessage(folder, reason));
	return folder;
}

/** Records a trusting decision by the user's command (`command`) or `--trust`-like scripted use. */
export function addTrust(
	cwd: string,
	which: GrantTarget,
	surface: TrustSurface,
	options: TrustOptions = {},
): GrantResult {
	try {
		return grantFolder(cwd, which, { source: "command", surface }, options);
	} catch (error) {
		if (error instanceof FolderGrantRefusedError)
			throw new TrustCommandError(homeFolderMessage(error.path, error.reason));
		throw new TrustCommandError(errorMessage(error));
	}
}

/** The live entry named by `selector`: an id (`4` or `#4`) or a folder (its current path, or where it was last seen). */
export function findEntry(selector: string, options: TrustOptions = {}): FolderGrantView {
	const wanted = selector.trim();
	if (!wanted) throw new TrustCommandError("Name the entry to remove: its number (#4) or its folder.");
	const rows = liveGrants(options);
	const id = /^#?(\d+)$/.exec(wanted);
	if (id) {
		const row = rows.find((entry) => entry.id === Number(id[1]));
		if (row) return row;
	}
	const resolved = path.resolve(wanted);
	const real = realFolder(wanted);
	let identity: { dev: string; ino: string } | undefined;
	try {
		identity = real === undefined ? undefined : folderEntry(real);
	} catch {
		// Matched by path below.
	}
	const match = rows.find(
		(row) =>
			row.path === resolved ||
			row.path === real ||
			(identity !== undefined && row.dev === identity.dev && row.ino === identity.ino),
	);
	if (!match)
		throw new TrustCommandError(`No trust decision is stored for ${shown(wanted)}. Run /trust list to see them.`);
	return match;
}

/** Revokes the entry (it stays in the history). */
export function removeTrust(row: FolderGrantView, options: TrustOptions = {}): void {
	let revoked: boolean;
	try {
		revoked = revokeFolder(row.id, undefined, options);
	} catch (error) {
		throw new TrustCommandError(errorMessage(error));
	}
	if (!revoked) throw new TrustCommandError(`#${row.id} was already removed.`);
}

/** Whether `row` is the decision that applies to `cwd` now: removing it ends trust for the session open there. */
export function appliesTo(row: FolderGrantView, cwd: string, options: TrustOptions = {}): boolean {
	const state = resolveFolderTrust(cwd, options);
	return state.state === "trusted" && state.grant.id === row.id;
}
