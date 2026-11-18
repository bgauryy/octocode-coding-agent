import path from "node:path";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { visibleControls } from "@octocodeai/octocode-common/sanitize";
import { cutText } from "@octocodeai/octocode-common/text";
import { formatAgo, formatClock, memberStats } from "../shared/format.ts";
import { homeTilde } from "@octocodeai/octocode-common/home-tilde";
import { plural } from "../shared/text.ts";
import { firstLine } from "../shared/util.ts";
import { type Ask, asksLabel } from "./asks.ts";
import type { BudgetStanding, OpenQuestion } from "./model.ts";
import { memberWorktree, worktreeLabel } from "../worktree-paths/member-worktree.ts";
import type { MemberDetails } from "./store/details.ts";
import { STALLED_LISTED_MS } from "./store/limits.ts";

/**
 * A working child with no model progress for this long is marked stalled in `coordinate list`. Its process stamps the
 * progress (`subagents/liveness.ts` `heartbeatDue`) while it works inside a declared long call or job, so quiet that long is not that.
 */
export const STALL_MS = 10 * 60_000;

/** Columns a detail line of `coordinate list` takes at most, its indent included: one terminal row. */
const DETAIL_COLUMNS = 100;

/** `  label value`, cut to one row: text keeps its start, a path its end (the folder name). */
function detailLine(label: string, raw: string, isPath = false): string {
	// Escaped first: an escape is longer than the control it shows, and the row must hold the escaped text.
	const value = visibleControls(raw);
	const head = `  ${label} `;
	const room = DETAIL_COLUMNS - head.length;
	if (value.length <= room) return `${head}${value}`;
	return isPath
		? `${head}…${cutText(value, room - 1, { chars: true, tail: true })}`
		: `${head}${cutText(value, room - 1, { chars: true })}…`;
}

/** A folder as the lister reads it: relative to its own checkout `here` when inside it, else from `~`. */
function shownFolder(folder: string, here: string | undefined): string {
	const relative = here ? path.relative(here, folder) : "";
	return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : homeTilde(folder);
}

/** The item, why, transcript and shell-log lines of one member; a line with no data is left out. */
function detailLines(
	details: MemberDetails | undefined,
	here: string | undefined,
	logged: Set<string> = new Set(),
): string[] {
	if (!details) return [];
	const { item, transcripts, shellLogs, jobs } = details;
	// Agents of one checkout share a transcript folder: the first block names it, the rest would repeat it.
	const newFolder = transcripts !== undefined && !logged.has(transcripts);
	if (transcripts !== undefined) logged.add(transcripts);
	const more = item?.more ? ` (+${item.more} more)` : "";
	const why = item ? firstLine(item.why).trim() : "";
	return [
		...(item ? [detailLine("item", `B${item.seq} ${firstLine(item.title)}${more}`)] : []),
		...(jobs?.length ? [detailLine("work:", jobs.map((job) => `${job.id} on ${job.item}`).join(", "))] : []),
		...(why ? [detailLine("why:", why)] : []),
		...(transcripts && newFolder ? [detailLine("log:", shownFolder(transcripts, here), true)] : []),
		...(shellLogs ? [detailLine("shell logs:", shownFolder(shellLogs, here), true)] : []),
	];
}

/**
 * The `coordinate list` text: one block per agent with join and last-seen times, unanswered messages and reserved paths.
 * `asks` (by agent id; `/agents` passes it) adds each subagent's questions to its parent. `questions` (`Team.openQuestions`)
 * names each unanswered message by id and sender; without it only their count is shown. `standing` adds the requests of a
 * child this agent started against its limit. `details` (`RunAudit.details`) adds its backlog item and why, transcript
 * folder and shell-log folder.
 */
export function describeMembers(
	members: Member[],
	selfId: string | undefined,
	now = Date.now(),
	asks?: ReadonlyMap<string, readonly Ask[]>,
	questions?: readonly OpenQuestion[],
	standing?: (id: string) => BudgetStanding | undefined,
	stalled: readonly Member[] = [],
	details?: ReadonlyMap<string, MemberDetails>,
): string {
	const gone = stalled.filter((member) => now - member.updatedAt > STALLED_LISTED_MS);
	if (members.length === 0 && gone.length === 0) return "No agents have joined in this repository.";
	const self = members.find((member) => member.id === selfId);
	const here = self?.checkout;
	const logged = new Set<string>();
	// Goals, activity, items and paths come from other processes' rows: untrusted text the model reads.
	const silent = gone.map(
		(member) =>
			`${member.id} · ${member.role} · stalled${member.parentId ? ` · parent ${member.parentId}` : ""}\n  pid ${member.pid} runs, but it has not been seen for ${formatAgo(now - member.updatedAt)} (last status ${member.status}): suspended or hung. It keeps its mail and its name still reaches it; it is not stopped.`,
	);
	return visibleControls(
		[
			...members.map((member) => {
				const you = member.id === selfId ? " (you)" : "";
				const parent = member.parentId ? ` · parent ${member.parentId}` : "";
				const model = member.model ? ` · ${member.model}` : "";
				// A parent that ended its turn while its children work is waiting, not idle.
				const children = members.filter((child) => child.parentId === member.id && child.status === "working").length;
				const doing =
					member.status === "working"
						? (member.activity ?? "working")
						: children > 0
							? `waiting on ${plural(children, "agent")}`
							: "idle";
				// The header shows the same fact as the detail line; the stored status stays `idle`.
				const shown = member.status === "idle" && children > 0 ? "waiting" : member.status;
				const asked = asksLabel(asks?.get(member.id));
				const waiting = (asks?.get(member.id) ?? []).filter((ask) => !ask.answer);
				// `lastOutputAt` is the child's last model or tool event (or a heartbeat inside a declared long call), never a stdout byte.
				const quiet = member.lastOutputAt === undefined ? undefined : now - member.lastOutputAt;
				const output = quiet === undefined ? "" : ` · last progress ${formatAgo(quiet)}`;
				const stalled = member.status === "working" && quiet !== undefined && quiet >= STALL_MS;
				// Another worktree of the repository: its folder name says where, and its locks are paths in that checkout.
				const elsewhere = here && member.checkout && member.checkout !== here;
				const folder = memberWorktree(member, here);
				const worktree = folder ? ` · ${worktreeLabel(folder)}` : "";
				const budget = standing?.(member.id);
				const requests = budget ? ` · ${budget.used} of ${budget.soft} requests, stops at ${budget.hard}` : "";
				return [
					`${member.id}${you} · ${member.role} · ${shown}${stalled ? " · stalled" : ""}${model}${parent}${worktree}`,
					...(member.goal ? [`  goal: ${firstLine(member.goal)}`] : []),
					`  pid ${member.pid}${member.processTitle ? ` (${member.processTitle})` : ""}${member.tmuxPane ? ` · tmux pane ${member.tmuxPane}` : ""} · joined ${formatClock(member.joinedAt)} (${formatAgo(now - member.joinedAt)}) · seen ${formatAgo(now - member.updatedAt)} · ${memberStats(member)}${requests}`,
					// The viewer's own checkout is the common case and the Worktrees section names it: only a different place is worth a line.
					...(member.cwd && !(self && member.cwd === self.cwd && member.branch === self.branch)
						? [`  in ${member.cwd}${member.branch ? ` @ ${member.branch}` : ""}`]
						: []),
					...detailLines(details?.get(member.id), here, logged),
					`  ${firstLine(doing)}${output}`,
					...(stalled
						? [
								`  stalled: no model request or tool event for ${formatAgo(quiet)}, outside any declared long call or job; stop or message it`,
							]
						: []),
					...awaiting(member, now, questions),
					...(asked ? [`  ${asked} to its coordinator`] : []),
					...waiting.map(
						(ask) =>
							`    #${ask.id} waiting on its coordinator (${formatAgo(now - ask.askedAt)}): ${cutText(firstLine(ask.text), 80, { chars: true })}`,
					),
					...(member.locks?.length
						? [
								`  holds ${member.locks.join(", ")}${elsewhere ? ` (in worktree ${path.basename(member.checkout!)})` : ""}`,
							]
						: []),
				].join("\n");
			}),
			...silent,
		].join("\n"),
	);
}

/** Questions shown per member in `coordinate list`; the rest are counted. */
const QUESTIONS_SHOWN = 5;

/** `member`'s unanswered questions: a count line, then `#id from sender (age): first line` for the oldest few. */
function awaiting(member: Member, now: number, questions: readonly OpenQuestion[] | undefined): string[] {
	if (!member.pending) return [];
	const head = `  ${member.pending} message${member.pending === 1 ? "" : "s"} awaiting its reply`;
	const mine = questions?.filter((question) => question.recipient === member.id) ?? [];
	if (mine.length === 0) return [head];
	const shown = mine
		.slice(0, QUESTIONS_SHOWN)
		.map(
			(question) =>
				`    #${question.id} from ${question.from} (${formatAgo(now - question.at)}): ${cutText(firstLine(question.text), 80, { chars: true })}`,
		);
	const more = mine.length > QUESTIONS_SHOWN ? [`    (${mine.length - QUESTIONS_SHOWN} more)`] : [];
	return [`${head}:`, ...shown, ...more];
}
