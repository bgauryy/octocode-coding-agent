import fs from "node:fs";
import path from "node:path";

/** More held paths than this, or paths in more than one package, earns the advisory. */
const MANY_PATHS = 20;

/** The package a workspace-relative path belongs to: the nearest folder with a `package.json`, `.` for the root. */
function packageOf(workspace: string, relative: string): string {
	let dir = path.dirname(path.resolve(workspace, relative.replace(/\/+$/, "")));
	if (relative.endsWith("/")) dir = path.resolve(workspace, relative);
	while (dir.startsWith(workspace) && dir !== workspace) {
		if (fs.existsSync(path.join(dir, "package.json"))) return path.relative(workspace, dir).split(path.sep).join("/");
		dir = path.dirname(dir);
	}
	return ".";
}

/**
 * The advisory a `coordinate lock` result adds when this agent now holds more than 20 paths or paths in more than one
 * package (`held`: its reservations, workspace-relative, a tree with a trailing `/`): broad reservations block other
 * agents' work. Empty otherwise. Nothing is refused.
 */
export function lockAdvice(workspace: string, held: readonly string[]): string {
	const packages = [...new Set(held.map((entry) => packageOf(workspace, entry)))].sort();
	const reasons = [
		held.length > MANY_PATHS ? `${held.length} paths` : "",
		packages.length > 1 ? `paths in ${packages.length} packages (${packages.join(", ")})` : "",
	].filter(Boolean);
	return reasons.length > 0
		? ` You hold ${reasons.join(" and ")}: reserve only the files you are editing now and unlock the rest, so other agents are not blocked.`
		: "";
}
