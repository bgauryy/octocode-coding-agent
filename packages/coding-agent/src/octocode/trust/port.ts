import type { FolderTrustResolver } from "../../core/folder-trust.ts";
import { resolveFolderTrust, type TrustOptions } from "./resolve.ts";

/** Whether the user trusted this folder: the check that gates project configuration, also gating repository documents in the web Docs tab. */
export function isFolderTrusted(root: string): boolean {
	return resolveFolderTrust(root).state === "trusted";
}

/**
 * The resolver core receives (`core/folder-trust.ts`): the stored decision for a folder, nothing else. `FolderTrust` is
 * assignable to the port's view, so the answer is passed through unchanged and core keeps no copy of the types.
 */
export function folderTrustResolver(options: TrustOptions = {}): FolderTrustResolver {
	return (cwd) => resolveFolderTrust(cwd, options);
}
