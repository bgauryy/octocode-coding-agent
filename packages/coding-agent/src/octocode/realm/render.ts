import path from "node:path";
import { plural } from "@octocodeai/octocode-common/clip";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { activityBadge, type BadgeState, badge, legend } from "../../theme/page-kit.ts";
import { shortDuration } from "../sessions/brief.ts";
import { shownLine } from "../sessions/store.ts";
import { formatCost, formatTokens } from "../shared/format.ts";
import { MAIN_CHECKOUT } from "../worktrees/switch.ts";
import type { Place, PlaceFolder, PlaceKind, PlaceSession, PlaceView } from "./model.ts";

const KIND: Record<PlaceKind, string> = {
	checkout: "this repository's main checkout",
	worktree: "worktree",
	isolated: "isolated agent worktree",
	linked: "linked worktree",
};

/** The state a place's badge shows: a missing folder is broken, one git cannot read needs a look, the rest are ready. */
function placeState(folder: PlaceFolder): BadgeState {
	return folder.gone ? "broken" : folder.error ? "attention" : "ready";
}

/** Why `/realm <name> switch` cannot move this session into the place, or undefined when it can. */
export function switchProblem(place: Place): string | undefined {
	if (place.folder.gone)
		return `Its folder is gone: git worktree prune, then /worktree new ${place.name} to make it again.`;
	if (place.current) return "This session is already here.";
	if (place.folder.kind === "isolated")
		return "It is an isolated agent's private worktree: its agent works there, and the coordinator merges it.";
	if (place.folder.kind === "linked")
		return "It was not made by /worktree new: open it in a terminal there, or make one with /worktree new <name>.";
	return undefined;
}

/** The name `switchToWorktree` takes for the place: `main` for the checkout, else the worktree folder's name. */
export const switchTarget = (place: Place): string =>
	place.folder.kind === "checkout" ? MAIN_CHECKOUT : path.basename(place.folder.path);

const where = (folder: PlaceFolder, main: string): string => {
	const relative = path.relative(main, folder.path) || ".";
	return relative.startsWith("..") ? folder.path : relative;
};

const liveCount = (sessions: readonly PlaceSession[]): number => sessions.filter((session) => session.live).length;
const working = (agents: readonly Member[]): number => agents.filter((agent) => agent.status === "working").length;

/** `3 changed, 1 untracked`-style facts of one folder's git state. */
function gitFacts(folder: PlaceFolder): string[] {
	if (folder.gone) return [];
	if (folder.error) return [`unreadable: ${shownLine(folder.error, 80)}`];
	return [
		folder.changed ? `${folder.changed} changed` : "clean",
		...(folder.unmerged ? [`${plural(folder.unmerged, "commit")} not on another branch`] : []),
	];
}

/** One place as a list row: badge, name, then facts, then what to do when something is wrong. */
function placeRow(place: Place, view: PlaceView, now: number): string {
	const { folder } = place;
	const kind = `${KIND[folder.kind]}${folder.gone ? " (gone)" : ""}`;
	const parts = [
		`${place.name} · ${kind}`,
		folder.branch ? `branch ${shownLine(folder.branch, 40)}` : folder.gone ? "" : "detached",
		...gitFacts(folder),
		place.agents.length > 0
			? `${plural(place.agents.length, "agent")}${working(place.agents) > 0 ? ` (${working(place.agents)} working)` : ""}`
			: "",
		place.sessions.length > 0 ? plural(liveCount(place.sessions), "live session") : "",
		place.lastActive ? `active ${shortDuration(now - place.lastActive)} ago` : "",
		folder.gone ? "git worktree prune" : "",
		place.current ? "current" : "",
	].filter(Boolean);
	return `${badge(placeState(folder)).text}  ${parts.join(" · ")}  (${where(folder, view.main)})`;
}

/** `calm-prawn · implementer · working · opus-5-5 · 12m · 34k tokens · ≈$0.40 · pid 4242`. */
function agentLine(agent: Member, now: number): string {
	const usage = [formatTokens(agent.input + agent.output) + " tokens", formatCost(agent)].filter(Boolean).join(" · ");
	return [
		agent.id,
		agent.parentId ? `${agent.role} under ${agent.parentId}` : agent.role,
		agent.status,
		agent.model ?? "model unknown",
		`${shortDuration(now - agent.joinedAt)} here`,
		usage,
		`pid ${agent.pid}`,
	].join(" · ");
}

/** `live`, `live (needs you)` with the light another live session's process wrote, or `saved`. */
export const sessionState = (session: PlaceSession): string =>
	session.live ? (session.activity ? `live (${activityBadge(session.activity).word})` : "live") : "saved";

/** `live (needs you) name or id · 5m ago · 3f9a2c` (`(current)` for this session). */
function sessionLine(session: PlaceSession, now: number): string {
	const shortId = session.id.replace(/[^\w]/g, "").slice(-6);
	const title = shownLine(session.name || "(unnamed)", 60);
	return `${sessionState(session)} ${title} · ${shortDuration(now - session.modified)} ago · ${shortId}${session.current ? " (current)" : ""}`;
}

/** The page behind a place row: facts, its agents and sessions, and the actions that apply. */
export function placeDetail(place: Place, view: PlaceView, now: number): string[] {
	const { folder } = place;
	const state = badge(placeState(folder));
	const lines = [
		`Place ${place.name} — ${state.text}${folder.gone ? " (gone)" : ""}`,
		`  ${KIND[folder.kind]} · ${where(folder, view.main)}${place.current ? " · this session works here" : ""}`,
		`  branch: ${folder.branch ? shownLine(folder.branch, 60) : folder.gone ? "unknown" : "detached"}${gitFacts(folder).length > 0 ? ` · ${gitFacts(folder).join(", ")}` : ""}`,
		`  last activity: ${place.lastActive ? `${shortDuration(now - place.lastActive)} ago` : "nothing ran here yet"}`,
	];
	if (folder.gone)
		lines.push("  Folder missing: git worktree prune drops the entry; /worktree new <name> makes it again.");
	lines.push(
		place.agents.length > 0 ? `  agents (${place.agents.length}):` : "  agents: none here",
		...place.agents.map((agent) => `    ${agentLine(agent, now)}`),
		place.sessions.length > 0
			? `  sessions (${place.sessions.length}, ${liveCount(place.sessions)} live):`
			: "  sessions: none saved here",
		...place.sessions.slice(0, 8).map((session) => `    ${sessionLine(session, now)}`),
	);
	if (place.sessions.length > 8) lines.push(`    … ${place.sessions.length - 8} older: /realm ${place.name} resume`);
	const problem = switchProblem(place);
	lines.push(
		`  switch: ${problem ?? `/realm ${place.name} switch moves this session here (the old one stays saved)`}`,
		...(place.sessions.length > 0 ? [`  resume: /realm ${place.name} resume picks a saved session from here`] : []),
	);
	return lines;
}

/** The listing in three parts, so a picker can show `header` and `footer` around `rows` it selects from. */
export function placeListParts(
	view: PlaceView,
	now: number,
	sessionsProblem?: string,
): { header: string[]; rows: string[]; footer: string[] } {
	const states = view.places.map((place) => placeState(place.folder));
	const footer: string[] = [];
	if (view.otherAgents.length > 0 || view.otherSessions.length > 0) {
		footer.push("Other live agents and sessions in this repository (in no listed place):");
		for (const agent of view.otherAgents) footer.push(`  ${agentLine(agent, now)}`);
		for (const session of view.otherSessions)
			footer.push(`  ${sessionLine(session, now)} · ${shownLine(session.cwd, 80)}`);
	}
	if (sessionsProblem)
		footer.push(`Sessions are not shown: ${shownLine(sessionsProblem, 200)}. /resume all lists them without it.`);
	return {
		header: [`Places of ${shownLine(path.basename(view.main) || view.main, 60)}:`, legend(states)],
		rows: view.places.map((place) => placeRow(place, view, now)),
		footer,
	};
}

/** The whole listing as text: the page without a UI. */
export function placeList(view: PlaceView, now: number, sessionsProblem?: string): string[] {
	const { header, rows, footer } = placeListParts(view, now, sessionsProblem);
	return [
		...header,
		...rows.map((row) => `  ${row}`),
		...footer,
		"/realm <name> shows one place; /realm <name> switch or resume acts on it.",
	];
}
