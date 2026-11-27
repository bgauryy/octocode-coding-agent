import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";

/** The most image paths a report is checked for, and the largest file hashed: a report is a summary, not a gallery. */
const MAX_PATHS = 10;
const MAX_HASH_BYTES = 20 * 1024 * 1024;

/** An image path in a report: absolute, or relative to the folder the child worked in. */
const IMAGE_PATH = /(?:^|[\s`'"(])((?:\/|\.\/|\.octocode\/)[^\s`'")]+\.(?:png|jpe?g))/gi;

/**
 * What the harness finds when it opens the screenshots a desktop child's report cites, as one line for the report's
 * footer, or none when every file checks out. A child that says it saved proof may not have: the file can be missing,
 * older than the run (a stale one proves nothing about this run) or byte for byte another file it cites (the same image
 * twice proves one state). The check reports and never blocks: the parent decides what an unverified path means.
 */
export function evidenceNotes(report: string, startedAt: number, cwd: string = process.cwd()): string[] {
	const cited = [...new Set([...report.matchAll(IMAGE_PATH)].map((match) => match[1]))].slice(0, MAX_PATHS);
	const problems: string[] = [];
	const seen = new Map<string, string>();
	for (const cite of cited) {
		const file = path.resolve(cwd, cite);
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(file);
		} catch {
			problems.push(`${cite} does not exist`);
			continue;
		}
		if (!stat.isFile() || stat.size === 0) {
			problems.push(`${cite} is not a non-empty file`);
			continue;
		}
		if (stat.mtimeMs < startedAt) problems.push(`${cite} is older than this run`);
		if (stat.size > MAX_HASH_BYTES) continue;
		const digest = sha256(readFileSync(file));
		const same = seen.get(digest);
		if (same) problems.push(`${cite} is identical to ${same}`);
		else seen.set(digest, cite);
	}
	return problems.length === 0 ? [] : [`Evidence not verified (the harness opened the files): ${problems.join("; ")}.`];
}
