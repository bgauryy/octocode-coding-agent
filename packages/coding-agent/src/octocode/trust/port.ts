import type { FolderTrustResolver } from "../../core/folder-trust.ts";
import { resolveFolderTrust, type TrustOptions } from "./resolve.ts";

/**
 * The resolver core receives (`core/folder-trust.ts`): the stored decision for a folder, nothing else. `FolderTrust` is
 * assignable to the port's view, so the answer is passed through unchanged and core keeps no copy of the types.
 */
export function folderTrustResolver(options: TrustOptions = {}): FolderTrustResolver {
	return (cwd) => resolveFolderTrust(cwd, options);
}
