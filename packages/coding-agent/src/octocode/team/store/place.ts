import fs from "node:fs";
import path from "node:path";
import type { agents } from "../../../../../db/src/api.ts";
import { APP_NAME } from "../../../config.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";

/** The branch is read again at most this often: it changes by a person's command, not a second at a time. */
const BRANCH_MS = 5_000;
const ABSENT = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);

const readText = (file: string): string | undefined => {
	try {
		return fs.readFileSync(file, "utf8");
	} catch (error) {
		if (ABSENT.has(String((error as { code?: unknown }).code))) return undefined;
		throw error;
	}
};

/** The checked-out branch of the repository `cwd` is in (read from `HEAD`, a linked worktree's `.git` file included); undefined outside git or on a detached head. */
function currentBranch(cwd: string): string | undefined {
	for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
		const dot = path.join(dir, ".git");
		const link = readText(dot); // a linked worktree's `.git` is a file; a checkout's is a directory (reads as absent)
		const gitDir = link === undefined ? dot : path.resolve(dir, /^gitdir:\s*(.+)$/m.exec(link)?.[1]?.trim() ?? "");
		const head = readText(path.join(gitDir, "HEAD"));
		if (head !== undefined) return /^ref: refs\/heads\/(.+?)\s*$/.exec(head)?.[1];
		if (path.dirname(dir) === dir) return undefined;
	}
}

/** Where this process works, as `agents` rows keep it: the directory, the branch (cached) and the process name when it is an Octocode title. */
export class Place {
	private readonly cwd: string;
	private branch: string | undefined;
	private readAt = Number.NEGATIVE_INFINITY;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	read(now = Date.now()): agents.MemberPlace {
		if (now - this.readAt >= BRANCH_MS) {
			this.branch = currentBranch(this.cwd);
			this.readAt = now;
		}
		return {
			cwd: this.cwd,
			branch: this.branch,
			processTitle: process.title.startsWith(APP_NAME) ? process.title : undefined,
		};
	}
}

/** The team's address of a process: its workspace (and the checkout its reservations protect, when another), with a `place` that reads fresh each time. */
export function memberWorkspace(
	id: string,
	leaseWorkspaceId: string | undefined,
	place: Place,
): agents.MemberWorkspace {
	return {
		id,
		...(leaseWorkspaceId && leaseWorkspaceId !== id ? { leaseWorkspaceId } : {}),
		get place() {
			return place.read();
		},
	};
}

/** A hosted pull mailbox works in its runner's directory while the parent owns its process lifetime. */
export function memberPlacement(workspace: agents.MemberWorkspace, member: Member): agents.MemberWorkspace {
	return member.mailbox === "pull"
		? {
				...workspace,
				place: { ...workspace.place, cwd: member.cwd, branch: member.branch },
			}
		: workspace;
}
