import fs from "node:fs";
import path from "node:path";
import { isWithin } from "@octocodeai/octocode-common/paths";
import { EXCLUDE_WORKSPACE_STATE, git } from "../../utils/git-run.ts";
import { OCTOCODE_DIR } from "../shared/home.ts";
import type { Worktree, WorktreeOutputs } from "./worktree-base.ts";

/** Git-ignored files a child wrote under `.octocode/` are copied to the checkout when its worktree is removed; these bound the copy. */
export const OUTPUT_LIMITS = { fileBytes: 1024 * 1024, totalBytes: 8 * 1024 * 1024, files: 100 } as const;

const FOLDER = OCTOCODE_DIR;
/** Listed from the worktree's root: the folder, less the harness's private state (`.octocode/code`), its `tmp` caches and any `node_modules`. */
const PATHSPEC = [
	`:(top)${FOLDER}`,
	EXCLUDE_WORKSPACE_STATE,
	`:(top,exclude)${FOLDER}/tmp`,
	":(top,glob,exclude)**/node_modules/**",
];

type Rescued = Pick<Worktree, "agentId" | "repo" | "path">;

/** Where a child's version goes when the checkout holds a newer file at the path: beside it, so nothing is lost. */
const besidePath = (file: string, agentId: string): string => `${file}.${agentId}`;

function isRegular(file: string): fs.Stats | undefined {
	const stat = fs.lstatSync(file, { throwIfNoEntry: false });
	return stat?.isFile() ? stat : undefined;
}

/**
 * Copies the child's new or changed ignored files under `.octocode/` to the same paths in the checkout (one `git
 * ls-files` walk, then one stat per file; links and special files are skipped). A file the checkout already holds
 * identically is left; one it holds differently and at least as new is not overwritten: the child's version is written
 * beside it (`besidePath`) and the path is returned in `conflicts`. Files past `OUTPUT_LIMITS` are not copied, and the
 * call throws naming them (after copying what fit), so the caller keeps the worktree instead of losing them.
 */
export async function copyIgnoredOutputs(worktree: Rescued): Promise<WorktreeOutputs> {
	const listing = await git(
		worktree.path,
		["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...PATHSPEC],
		{ raw: true },
	);
	const outputs: WorktreeOutputs = { copied: [], conflicts: [] };
	const left: string[] = [];
	const realRepo = fs.realpathSync(worktree.repo);
	const checkedDirs = new Set<string>();
	let total = 0;
	let seen = 0;
	for (const file of listing.split("\0")) {
		if (!file) continue;
		const source = path.join(worktree.path, file);
		const stat = isRegular(source);
		if (!stat) continue;
		if (
			stat.size > OUTPUT_LIMITS.fileBytes ||
			total + stat.size > OUTPUT_LIMITS.totalBytes ||
			seen >= OUTPUT_LIMITS.files
		) {
			left.push(file);
			continue;
		}
		total += stat.size;
		seen += 1;
		const target = path.join(worktree.repo, file);
		await fs.promises.mkdir(path.dirname(target), { recursive: true });
		if (!checkedDirs.has(path.dirname(target))) {
			if (!isWithin(await fs.promises.realpath(path.dirname(target)), realRepo))
				throw new Error(`${path.dirname(file)} in the checkout leads outside it`);
			checkedDirs.add(path.dirname(target));
		}
		const kind = await place(source, stat, target, besidePath(target, worktree.agentId));
		if (kind !== "same") (kind === "conflict" ? outputs.conflicts : outputs.copied).push(file);
	}
	if (left.length > 0)
		throw new Error(
			`Ignored files under ${FOLDER}/ were not copied to the checkout (over ${OUTPUT_LIMITS.fileBytes / 1024} KiB each, ${OUTPUT_LIMITS.totalBytes / (1024 * 1024)} MiB or ${OUTPUT_LIMITS.files} files in all): ${left.join(", ")}`,
		);
	return outputs;
}

async function place(
	source: string,
	stat: fs.Stats,
	target: string,
	beside: string,
): Promise<"copied" | "same" | "conflict"> {
	try {
		await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
		return "copied";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const existing = isRegular(target);
	if (existing && existing.size === stat.size && (await sameContent(source, target))) return "same";
	if (existing && existing.mtimeMs < stat.mtimeMs) {
		await fs.promises.copyFile(source, target);
		return "copied";
	}
	await fs.promises.copyFile(source, beside);
	return "conflict";
}

async function sameContent(a: string, b: string): Promise<boolean> {
	const [first, second] = await Promise.all([fs.promises.readFile(a), fs.promises.readFile(b)]);
	return first.equals(second);
}

/** The lines for the report: what was copied, and what the checkout already held newer. */
export function outputsReport(agentId: string, outputs: WorktreeOutputs | undefined): string {
	if (!outputs) return "";
	const copied = outputs.copied.length
		? `\nCopied ${outputs.copied.length} git-ignored output file(s) to this checkout: ${outputs.copied.join(", ")}.`
		: "";
	const conflicts = outputs.conflicts.length
		? `\nNot overwritten, because this checkout holds a newer version (the child's is saved beside it as <file>.${agentId}): ${outputs.conflicts.join(", ")}.`
		: "";
	return copied + conflicts;
}
