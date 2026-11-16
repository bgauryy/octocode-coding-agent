import type { Member } from "@octocodeai/octocode-contracts/team";
import { redactSecrets, visibleControls } from "../../../../common/src/sanitize.ts";

const MAX_SIBLINGS = 6;
const MAX_GOAL = 80;
const MAX_PATHS = 4;

const clean = (text: string): string => visibleControls(redactSecrets(text)).replace(/\s+/g, " ").trim();

/**
 * The running agents that share `parentId` with the child `selfId`, as one bounded line each for its identity:
 * id, role, goal and reserved paths. Empty when there are none or the team cannot be read (a roster never fails a launch).
 */
export function siblingRoster(team: { members(): Member[] }, selfId: string, parentId: string | undefined): string {
	if (!parentId) return "";
	let members: Member[];
	try {
		members = team.members();
	} catch {
		return "";
	}
	const siblings = members.filter(
		(member) => member.parentId === parentId && member.id !== selfId && member.status !== "settled",
	);
	const lines = siblings.slice(0, MAX_SIBLINGS).map((member) => {
		const goal = clean(member.goal ?? "");
		const shown = goal.length > MAX_GOAL ? `${goal.slice(0, MAX_GOAL - 1)}…` : goal;
		const locks = member.locks ?? [];
		const paths = locks.slice(0, MAX_PATHS).map((entry) => clean(entry));
		if (locks.length > MAX_PATHS) paths.push(`+${locks.length - MAX_PATHS} more`);
		const parts = [`\`${clean(member.id)}\` (${clean(member.role)})`];
		if (shown) parts.push(shown);
		if (paths.length > 0) parts.push(`holds ${paths.join(", ")}`);
		return parts.join(": ");
	});
	if (siblings.length > MAX_SIBLINGS) lines.push(`${siblings.length - MAX_SIBLINGS} more`);
	return lines.join("; ");
}
