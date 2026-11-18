import type { Endpoint, Member, Traffic } from "@octocodeai/octocode-contracts/team";
import { type PaneLabel, tmuxMark } from "../shared/tmux-mark.ts";
import { EXTERNAL_SENDER, USER_SENDER } from "../shared/messages.ts";
import { memberWorktree, worktreeLabel } from "../worktree-paths/member-worktree.ts";

/** The team's own sender id for notices (`mail.notice`, `idle.ts`). */
export const TEAM_SENDER = "team";

/** What the team database kept of an agent that left: the last row its `delete` event recorded (`agent-events.ts` `endData`). */
export interface DepartedAgent {
	role?: string;
	parentId?: string;
	sessionId?: string;
	checkout?: string;
	cwd?: string;
	branch?: string;
	tmuxPane?: string;
}

/**
 * Where endpoints are resolved from: the live members, then `departed` (an agent that left the team), then the id alone.
 * `root` is the viewer's checkout: its own folder is `main`, any other folder a `worktree <name>`; without it no worktree is named.
 */
export interface EndpointDirectory {
	members: readonly Member[];
	departed?: (id: string) => DepartedAgent | undefined;
	root?: string;
}

const NOT_AGENTS: ReadonlyMap<string, string> = new Map([
	[USER_SENDER, USER_SENDER],
	[TEAM_SENDER, TEAM_SENDER],
	[EXTERNAL_SENDER, EXTERNAL_SENDER],
]);

const put = <K extends keyof Endpoint>(key: K, value: Endpoint[K] | undefined): Partial<Endpoint> =>
	value === undefined || value === "" ? {} : { [key]: value };

function located(facts: DepartedAgent, root: string | undefined): string | undefined {
	if (!root || (!facts.checkout && !facts.cwd)) return undefined;
	const folder = memberWorktree(facts, root);
	return folder ? worktreeLabel(folder) : "main";
}

function fromFacts(id: string, facts: DepartedAgent, root: string | undefined, departed: boolean): Endpoint {
	return {
		id,
		...put("role", facts.role),
		...put("sessionId", facts.sessionId),
		...put("parentId", facts.parentId),
		...put("worktree", located(facts, root)),
		...put("branch", facts.branch),
		...put("tmuxPane", facts.tmuxPane),
		...(departed ? { departed: true as const } : {}),
	};
}

/** The endpoint of `id`: its live team row, else the row it left behind, else (`user`, `team`, `external`) its sender role, else the bare id. */
export function endpointOf(id: string, directory: EndpointDirectory): Endpoint {
	const member = directory.members.find((candidate) => candidate.id === id);
	if (member) return fromFacts(id, member, directory.root, false);
	const left = directory.departed?.(id);
	if (left) return fromFacts(id, left, directory.root, true);
	const role = NOT_AGENTS.get(id);
	return role ? { id, role } : { id };
}

/** `traffic` with both ends resolved (`fromEndpoint`, `toEndpoints`); a message that already has them keeps them. */
export function withEndpoints(traffic: Traffic, directory: EndpointDirectory): Traffic {
	if (traffic.fromEndpoint && traffic.toEndpoints) return traffic;
	return {
		...traffic,
		fromEndpoint: traffic.fromEndpoint ?? endpointOf(traffic.from, directory),
		toEndpoints: traffic.toEndpoints ?? traffic.to.map((id) => endpointOf(id, directory)),
	};
}

/** The facts after the name: `worktree fix`, the branch and `tmux work:2.0` (`panes` names a pane tmux lists). Empty when none is known. */
export function endpointMarks(endpoint: Endpoint, panes: readonly PaneLabel[] = []): string[] {
	return [
		...(endpoint.worktree ? [endpoint.worktree] : []),
		...(endpoint.branch ? [endpoint.branch] : []),
		...(endpoint.tmuxPane ? [tmuxMark(endpoint.tmuxPane, panes)] : []),
	];
}

/** `inky-kraken(implementer)`, `inky-kraken(implementer, left)` for an agent that left the team, the bare id when no role is known. */
export function endpointName(endpoint: Endpoint): string {
	const role = [endpoint.role, endpoint.departed ? "left" : ""].filter(Boolean).join(", ");
	return role ? `${endpoint.id}(${role})` : endpoint.id;
}

/** `inky-kraken (implementer) · worktree fix · feat/x · tmux work:2.0`; `(left)` after the role for an agent that left the team. */
export function endpointLabel(endpoint: Endpoint, panes: readonly PaneLabel[] = []): string {
	const role = endpoint.role
		? ` (${endpoint.role}${endpoint.departed ? ", left" : ""})`
		: endpoint.departed
			? " (left)"
			: "";
	return [`${endpoint.id}${role}`, ...endpointMarks(endpoint, panes)].join(" · ");
}
