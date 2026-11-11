import os from "node:os";
import { homeTilde } from "../../../../common/src/home-tilde.ts";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import type { RefusedRoot } from "./identity.ts";

/**
 * The words of folder trust that more than one surface shows: the startup gate (part of `main/`), the trust prompt, `/trust`
 * and `octocode trust`. Pure text; nothing here reads a folder or the database. Paths come from the file system and can
 * hold terminal controls, so every one goes through `shown`.
 */

/** A path as one safe row, with the home folder written `~`. */
export function shown(folder: string, home: string = os.homedir()): string {
	return homeTilde(sanitizeTerminalText(folder).replace(/[\n\t]/g, " "), home);
}

/** Opening a folder the user recorded "Do not trust" for: one line, then the caller exits. */
export function refusedFolderMessage(folder: string): string {
	const name = shown(folder);
	return `${name} is marked "do not trust", so Octocode did not open it. To trust it, run: octocode trust add ${name}`;
}

/** The home folder or a filesystem root (no session, no grant), or a folder above home (no subtree grant). */
export function homeFolderMessage(folder: string, reason: RefusedRoot): string {
	if (reason === "contains-home")
		return `Octocode does not trust everything under ${shown(folder)}: that includes your home folder and every project in it. Trust a project folder instead: cd into it and run octocode.`;
	const what = reason === "home" ? `your home folder (${shown(folder)})` : "the filesystem root";
	return `Octocode does not open ${what}: trusting it would cover every project on this computer. Open a project folder instead: cd into it and run octocode.`;
}

/** The one line printed when the user leaves the trust prompt without trusting. */
export function notTrustedExitLine(folder: string, choice: "not-now" | "refuse"): string {
	const name = shown(folder);
	return choice === "refuse"
		? `Not trusted. Nothing was read or run in ${name}. Octocode will not ask again; to change this, run: octocode trust add ${name}`
		: `Not trusted. Nothing was read or run in ${name}. Octocode will ask again the next time you open it.`;
}
