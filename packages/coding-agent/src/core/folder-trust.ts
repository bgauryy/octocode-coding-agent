/**
 * The port through which core learns whether the user trusts a folder. Core never reads trust records and never imports
 * `octocode/`: the host installs a resolver (`octocode/trust/port.ts`) and core receives its answer, or only the boolean
 * `projectTrusted` derived from it. Core must not ask the user or record anything through this port.
 */

type FolderTrustState =
	/** A grant covers the folder; project configuration may load. */
	| "trusted"
	/** The user recorded "Do not trust" for the folder. */
	| "refused"
	/** Nobody has decided yet. */
	| "undecided"
	/** Not decidable: the home folder, a filesystem root, a missing folder or unreadable trust records. */
	| "untrusted";

interface FolderTrustView {
	state: FolderTrustState;
	/** For `trusted`: the folder the covering grant is on; project instructions load from it down to the working folder. */
	root?: string;
}

/** Looks up the stored decision for a working folder. Synchronous and free of prompts. */
export type FolderTrustResolver = (cwd: string) => FolderTrustView;

/**
 * Settles a folder the resolver does not trust, for a running session that is about to move into it: it may ask the user
 * and record the answer, or only explain. `ok: false` carries the sentence to show; the session stays where it is.
 */
export type FolderTrustAsker = (cwd: string) => Promise<{ ok: true } | { ok: false; message: string }>;

/** A session switch into a folder that is not trusted was refused before the current session was touched. */
export class FolderNotTrustedError extends Error {
	readonly cwd: string;

	constructor(cwd: string, message?: string) {
		super(
			message ??
				`${cwd.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")} is not trusted, so Octocode did not switch to it. The current session is unchanged. To trust it, run in your own terminal: octocode trust add <folder>`,
		);
		this.name = "FolderNotTrustedError";
		this.cwd = cwd;
	}
}

/**
 * The check a runtime makes before it tears the current session down for one in `cwd`. Both parts are installed by the
 * host; with no resolver nothing is checked (tests, embedded runtimes). A trusted folder passes at once. Otherwise the
 * asker may ask the user and record the answer; the folder passes only if it then resolves as trusted.
 */
export class FolderAdmission {
	resolve: FolderTrustResolver | undefined;
	ask: FolderTrustAsker | undefined;

	/** Throws `FolderNotTrustedError`, leaving the caller's session untouched, when `cwd` may not be opened. */
	async check(cwd: string): Promise<void> {
		const resolve = this.resolve;
		if (!resolve || resolve(cwd).state === "trusted") return;
		const answer = await this.ask?.(cwd);
		if (answer?.ok && resolve(cwd).state === "trusted") return;
		throw new FolderNotTrustedError(cwd, answer && !answer.ok ? answer.message : undefined);
	}
}
