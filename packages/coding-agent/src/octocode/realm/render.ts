import path from "node:path";
import { plural } from "@octocodeai/octocode-common/clip";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { type BadgeState, badge, legend } from "../../theme/page-kit.ts";
import { shortDuration } from "../sessions/brief.ts";
import { shownLine } from "../sessions/store.ts";
import { formatCost, formatTokens } from "../shared/format.ts";
import { MAIN_CHECKOUT } from "../worktrees/switch.ts";
import type { Realm, RealmFolder, RealmKind, RealmSession, RealmView } from "./model.ts";

const KIND: Record<RealmKind, string> = {
	checkout: "this repository's main checkout",
	worktree: "worktree",
	isolated: "isolated agent worktree",
	linked: "linked worktree",
};

/** The state a realm's badge shows: a missing folder is broken, one git cannot read needs a look, the rest are ready. */
function realmState(folder: RealmFolder): BadgeState {
	return folder.gone ? "broken" : folder.error ? "attention" : "ready";
}

/** Why `/realm <name> switch` cannot move this session into the realm, or undefined when it can. */
export function switchProblem(realm: Realm): string | undefined {
	if (realm.folder.gone)
		return `Its folder is gone: git worktree prune, then /worktree new ${realm.name} to make it again.`;
	if (realm.current) return "This session is already here.";
	if (realm.folder.kind === "isolated")
		return "It is an isolated agent's private worktree: its agent works there, and the coordinator merges it.";
	if (realm.folder.kind === "linked")
		return "It was not made by /worktree new: open it in a terminal there, or make one with /worktree new <name>.";
	return undefined;
}

/** The name `switchToWorktree` takes for the realm: `main` for the checkout, else the worktree folder's name. */
export const switchTarget = (realm: Realm): string =>
	realm.folder.kind === "checkout" ? MAIN_CHECKOUT : path.basename(realm.folder.path);

const where = (folder: RealmFolder, main: string): string => {
	const relative = path.relative(main, folder.path) || ".";
	return relative.startsWith("..") ? folder.path : relative;
};

const liveCount = (sessions: readonly RealmSession[]): number => sessions.filter((session) => session.live).length;
const working = (agents: readonly Member[]): number => agents.filter((agent) => agent.status === "working").length;

/** `3 changed, 1 untracked`-style facts of one folder's git state. */
function gitFacts(folder: RealmFolder): string[] {
	if (folder.gone) return [];
	if (folder.error) return [`unreadable: ${shownLine(folder.error, 80)}`];
	return [
		folder.changed ? `${folder.changed} changed` : "clean",
		...(folder.unmerged ? [`${plural(folder.unmerged, "commit")} not on another branch`] : []),
	];
}

/** One realm as a list row: badge, name, then facts, then what to do when something is wrong. */
function realmRow(realm: Realm, view: RealmView, now: number): string {
	const { folder } = realm;
	const kind = `${KIND[folder.kind]}${folder.gone ? " (gone)" : ""}`;
	const parts = [
		`${realm.name} · ${kind}`,
		folder.branch ? `branch ${shownLine(folder.branch, 40)}` : folder.gone ? "" : "detached",
		...gitFacts(folder),
		realm.agents.length > 0
			? `${plural(realm.agents.length, "agent")}${working(realm.agents) > 0 ? ` (${working(realm.agents)} working)` : ""}`
			: "",
		realm.sessions.length > 0 ? plural(liveCount(realm.sessions), "live session") : "",
		realm.lastActive ? `active ${shortDuration(now - realm.lastActive)} ago` : "",
		folder.gone ? "git worktree prune" : "",
		realm.current ? "current" : "",
	].filter(Boolean);
	return `${badge(realmState(folder)).text}  ${parts.join(" · ")}  (${where(folder, view.main)})`;
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

/** `● name or id · 5m ago · 3f9a2c` (`(current)` for this session). */
function sessionLine(session: RealmSession, now: number): string {
	const shortId = session.id.replace(/[^\w]/g, "").slice(-6);
	const title = shownLine(session.name || "(unnamed)", 60);
	return `${session.live ? "live" : "saved"} ${title} · ${shortDuration(now - session.modified)} ago · ${shortId}${session.current ? " (current)" : ""}`;
}

/** The page behind a realm row: facts, its agents and sessions, and the actions that apply. */
export function realmDetail(realm: Realm, view: RealmView, now: number): string[] {
	const { folder } = realm;
	const state = badge(realmState(folder));
	const lines = [
		`Realm ${realm.name} — ${state.text}${folder.gone ? " (gone)" : ""}`,
		`  ${KIND[folder.kind]} · ${where(folder, view.main)}${realm.current ? " · this session works here" : ""}`,
		`  branch: ${folder.branch ? shownLine(folder.branch, 60) : folder.gone ? "unknown" : "detached"}${gitFacts(folder).length > 0 ? ` · ${gitFacts(folder).join(", ")}` : ""}`,
		`  last activity: ${realm.lastActive ? `${shortDuration(now - realm.lastActive)} ago` : "nothing ran here yet"}`,
	];
	if (folder.gone)
		lines.push("  Folder missing: git worktree prune drops the entry; /worktree new <name> makes it again.");
	lines.push(
		realm.agents.length > 0 ? `  agents (${realm.agents.length}):` : "  agents: none here",
		...realm.agents.map((agent) => `    ${agentLine(agent, now)}`),
		realm.sessions.length > 0
			? `  sessions (${realm.sessions.length}, ${liveCount(realm.sessions)} live):`
			: "  sessions: none saved here",
		...realm.sessions.slice(0, 8).map((session) => `    ${sessionLine(session, now)}`),
	);
	if (realm.sessions.length > 8) lines.push(`    … ${realm.sessions.length - 8} older: /realm ${realm.name} resume`);
	const problem = switchProblem(realm);
	lines.push(
		`  switch: ${problem ?? `/realm ${realm.name} switch moves this session here (the old one stays saved)`}`,
		...(realm.sessions.length > 0 ? [`  resume: /realm ${realm.name} resume picks a saved session from here`] : []),
	);
	return lines;
}

/** The listing in three parts, so a picker can show `header` and `footer` around `rows` it selects from. */
export function realmListParts(
	view: RealmView,
	now: number,
	sessionsProblem?: string,
): { header: string[]; rows: string[]; footer: string[] } {
	const states = view.realms.map((realm) => realmState(realm.folder));
	const footer: string[] = [];
	if (view.otherAgents.length > 0 || view.otherSessions.length > 0) {
		footer.push("Other live agents and sessions in this repository (in no listed realm):");
		for (const agent of view.otherAgents) footer.push(`  ${agentLine(agent, now)}`);
		for (const session of view.otherSessions)
			footer.push(`  ${sessionLine(session, now)} · ${shownLine(session.cwd, 80)}`);
	}
	if (sessionsProblem)
		footer.push(`Sessions are not shown: ${shownLine(sessionsProblem, 200)}. /resume all lists them without it.`);
	return {
		header: [`Realms of ${shownLine(path.basename(view.main) || view.main, 60)}:`, legend(states)],
		rows: view.realms.map((realm) => realmRow(realm, view, now)),
		footer,
	};
}

/** The whole listing as text: the page without a UI. */
export function realmList(view: RealmView, now: number, sessionsProblem?: string): string[] {
	const { header, rows, footer } = realmListParts(view, now, sessionsProblem);
	return [
		...header,
		...rows.map((row) => `  ${row}`),
		...footer,
		"/realm <name> shows one realm; /realm <name> switch or resume acts on it.",
	];
}
