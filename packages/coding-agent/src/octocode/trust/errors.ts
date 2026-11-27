import type { RefusedRoot } from "./identity.ts";

/** A grant was asked for a folder that never gets one: home, a filesystem root or (subtree) a folder above home. Nothing was written. */
export class FolderGrantRefusedError extends Error {
	readonly reason: RefusedRoot;
	readonly path: string;

	constructor(reason: RefusedRoot, folder: string) {
		super(
			reason === "home"
				? `Trust is not granted on the home folder (${folder}): it would cover every project in it.`
				: reason === "contains-home"
					? `Trust is not granted on everything under ${folder}: that includes your home folder and every project in it. Trust the project folder itself instead.`
					: `Trust is not granted on a filesystem root (${folder}): it would cover the whole disk.`,
		);
		this.name = "FolderGrantRefusedError";
		this.reason = reason;
		this.path = folder;
	}
}
