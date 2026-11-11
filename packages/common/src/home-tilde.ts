import { homedir } from "node:os";

/**
 * `file` with the home folder written `~`, the way a user types it: the home folder itself is `~`, a path inside it is
 * `~` followed by the rest as written; any other path is returned unchanged. A sibling that only shares the home folder's
 * name (`/home/al` and `/home/alice`) is not inside it. On Windows `\` and `/` both separate, and letter case is ignored,
 * as the file system does.
 */
export function homeTilde(
	file: string,
	home: string = homedir(),
	platform: NodeJS.Platform = process.platform,
): string {
	const root = home.replace(platform === "win32" ? /[\\/]+$/ : /\/+$/, "");
	if (!root) return file;
	const windows = platform === "win32";
	const head = file.slice(0, root.length);
	if (windows ? head.toLowerCase() !== root.toLowerCase() : head !== root) return file;
	const rest = file.slice(root.length);
	if (!rest) return "~";
	return rest[0] === "/" || (windows && rest[0] === "\\") ? `~${rest}` : file;
}
