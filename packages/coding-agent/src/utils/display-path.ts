/** Short display form of a file path for status lines and notes. */
import os from "node:os";
import path from "node:path";
import { homeTilde } from "@octocodeai/octocode-common/home-tilde";

/** `file` relative to `cwd` when inside it, else with the home directory as `~`; otherwise unchanged. */
export function shortPath(file: string, cwd = process.cwd(), home = os.homedir()): string {
	const inside = (root: string) => {
		const relative = path.relative(root, file);
		return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : undefined;
	};
	const local = inside(cwd);
	if (local) return local;
	return homeTilde(file, home);
}
