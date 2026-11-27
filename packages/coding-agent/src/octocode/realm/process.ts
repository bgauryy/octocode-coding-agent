import path from "node:path";
import { plural } from "@octocodeai/octocode-common/clip";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { repoKey } from "../../utils/git-repository.ts";
import { shortDuration } from "../sessions/brief.ts";
import { formatCost, formatTokens } from "../shared/format.ts";
import { pendingRefs } from "../subagents/worktree.ts";
import { memberWorktree } from "../worktree-paths/member-worktree.ts";
import { worktreesDir } from "../worktree-paths/own-worktree.ts";
import { orchestratorOf } from "../worktrees/proxy.ts";
import { canonical } from "../worktrees/repo.ts";

/** What this process's realm reads: its team row, the team's live agents, and which backlog item each child serves. */
export interface RealmSource {
	/** This session's agent id; undefined until it joins the team. */
	id: () => string | undefined;
	/** Live agents of this repository's team. */
	members: () => Member[];
	/** Each running child with the backlog item it works on. */
	serving: () => Iterable<readonly [string, string]>;
}

/** This session's folder: the main checkout or a linked worktree, whose orchestrator it answers to. */
interface RealmPlace {
	folder: string;
	/** Absent outside a git repository. */
	kind?: "main checkout" | "linked worktree";
	/** For a linked worktree: who created it, in words. */
	orchestrator?: string;
}

interface RealmChild {
	member: Member;
	item?: string;
	/** `in-tree`, or the worktree it works in (`isolated worktree <name>` for its private one). */
	place: string;
}

export interface Realm {
	self?: Member;
	place: RealmPlace;
	children: RealmChild[];
	/** Ids of isolated results saved on a ref and not merged yet. */
	pending: string[];
}

function placeOf(cwd: string): RealmPlace {
	const { key, root } = repoKey(cwd);
	// Without a repository the key is the folder itself.
	if (key === root) return { folder: cwd };
	const orchestrator = orchestratorOf(cwd);
	return orchestrator
		? { folder: root, kind: "linked worktree", orchestrator }
		: { folder: root, kind: "main checkout" };
}

/** The agents under `self`, children first then theirs, each once. */
function descendants(members: readonly Member[], self: string): Member[] {
	const found: Member[] = [];
	const seen = new Set([self]);
	for (let queue = [self]; queue.length > 0;) {
		const next: string[] = [];
		for (const member of members) {
			if (!member.parentId || !queue.includes(member.parentId) || seen.has(member.id)) continue;
			seen.add(member.id);
			if (member.status !== "settled") found.push(member);
			next.push(member.id);
		}
		queue = next;
	}
	return found;
}

function childPlace(member: Member, root: string, isolatedDir: string): string {
	// An isolated child's private worktree lies inside the checkout, where `memberWorktree` sees no other worktree.
	const below = member.cwd ? path.relative(isolatedDir, canonical(member.cwd)) : "..";
	if (!below.startsWith("..") && !path.isAbsolute(below)) return `isolated worktree ${below.split(path.sep)[0]}`;
	const folder = memberWorktree(member, root);
	return folder ? `worktree ${path.basename(folder)}` : "in-tree";
}

/** This process's realm: its session, where it runs, its live children and the isolated results waiting to merge. */
export async function collectRealm(cwd: string, source: RealmSource): Promise<Realm> {
	const id = source.id();
	const members = source.members();
	const place = placeOf(cwd);
	const root = place.kind ? place.folder : cwd;
	const isolatedDir = canonical(worktreesDir(cwd));
	const items = new Map(source.serving());
	const self = id ? members.find((member) => member.id === id) : undefined;
	const children = (id ? descendants(members, id) : []).map((member): RealmChild => ({
		member,
		...(items.has(member.id) ? { item: items.get(member.id) } : {}),
		place: childPlace(member, root, isolatedDir),
	}));
	return { ...(self ? { self } : {}), place, children, pending: place.kind ? await pendingRefs(cwd) : [] };
}

function childLine({ member, item, place }: RealmChild, now: number): string {
	const usage = [`${formatTokens(member.input + member.output)} tokens`, formatCost(member)]
		.filter(Boolean)
		.join(" · ");
	return [
		`  ${member.id}`,
		member.role,
		member.status,
		item ? `item ${item}` : "",
		place,
		member.parentId ? `under ${member.parentId}` : "",
		shortDuration(now - member.joinedAt),
		usage,
	]
		.filter(Boolean)
		.join(" · ");
}

/** The realm as lines: session, place, children, pending refs. */
export function realmLines(realm: Realm, now: number, selfId: string | undefined): string[] {
	const { self, place, children, pending } = realm;
	const session = self
		? [self.id, self.role, self.status, self.model ?? "", self.branch ? `branch ${self.branch}` : ""]
				.filter(Boolean)
				.join(" · ")
		: `${selfId ?? "not in the team yet"} (a session joins the team when it reserves files, messages or starts a subagent)`;
	const where = place.kind ? `${place.kind} ${place.folder}` : `${place.folder} (not a git repository)`;
	const lines = [
		"This Octocode process and its children:",
		`Session: ${session}`,
		`Place: ${where}`,
		...(place.orchestrator
			? [`Orchestrator: ${place.orchestrator}; this session is its proxy and does not merge or create worktrees`]
			: []),
		children.length > 0 ? `Children (${children.length}):` : "Children: none running.",
		...children.map((child) => childLine(child, now)),
	];
	if (pending.length > 0)
		lines.push(
			`Isolated results to merge (${plural(pending.length, "ref")}): ${pending.join(", ")}${place.orchestrator ? " — the orchestrator merges them" : " — /agents merge <id> or /agents discard <id>"}`,
		);
	return lines;
}
