import fs from "node:fs";
import path from "node:path";
import { findGitPaths } from "../../core/footer-data-provider/git.ts";
import { gitMarkerDir } from "../../utils/git-marker.ts";

/** A small file's text, or undefined when it is absent. */
function readSmall(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * What git's branch and HEAD commit for `cwd` (`gitState`) follow from, read from the git folder without running git:
 * its location, `HEAD`, and the branch ref `HEAD` names (its loose file, else the packed refs' size and time). Equal
 * stamps mean git would answer the same. Undefined when that cannot be told from these files (a reftable repository,
 * a ref that points at another ref, `GIT_DIR` in the environment, a file that cannot be read): the caller asks git.
 */
export function gitHeadStamp(cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (env.GIT_DIR !== undefined || env.GIT_WORK_TREE !== undefined) return undefined;
	try {
		if (gitMarkerDir(cwd) === undefined) return `none\0${path.resolve(cwd)}`;
		const paths = findGitPaths(cwd);
		if (!paths || fs.existsSync(path.join(paths.commonGitDir, "reftable"))) return undefined;
		const head = readSmall(paths.headPath)?.trim();
		if (head === undefined) return undefined;
		const ref = /^ref:\s*(refs\/\S+)$/.exec(head)?.[1];
		let target = "";
		if (ref) {
			const loose = readSmall(path.join(paths.commonGitDir, ref))?.trim();
			if (loose?.startsWith("ref:")) return undefined;
			if (loose !== undefined) target = loose;
			else {
				const packed = fs.statSync(path.join(paths.commonGitDir, "packed-refs"), { throwIfNoEntry: false });
				target = packed ? `packed:${packed.size}:${packed.mtimeMs}` : "unborn";
			}
		}
		return [paths.repoDir, paths.commonGitDir, head, target].join("\0");
	} catch (error) {
		// An unreadable git folder (permissions, a folder where a file belongs): git itself decides what to report.
		if (typeof (error as NodeJS.ErrnoException).code === "string") return undefined;
		throw error;
	}
}
