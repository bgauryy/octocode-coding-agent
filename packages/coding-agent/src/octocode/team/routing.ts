import { renderInstruction } from "../../core/prompt-template.ts";
import path from "node:path";
import { mutatedPaths } from "../shared/file-input.ts";
import { apiClientLabel, fenceUntrusted, headerText, messageHeader, PARENT_FENCE_NOTE } from "../shared/fence.ts";
import { formatAgo, formatClock, formatDuration, memberStats } from "../shared/format.ts";
import { resolveToolPath } from "../shared/home.ts";
import { EXTERNAL_SENDER, USER_SENDER } from "../shared/messages.ts";
import { visibleControls } from "../../../../common/src/sanitize.ts";
import { firstLine } from "../shared/util.ts";
import { type Ask, asksLabel } from "./asks.ts";
import type { Change } from "./edits.ts";
import { keysOverlap } from "./lease-key.ts";
import type { BudgetStanding, DeadLetter, Lease, LeaseConflict, Message, OpenQuestion } from "./model.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { cutText } from "../../../../common/src/text.ts";

/** Pure text and routing helpers for the team: recipients, what `coordinate list` prints, which paths a call edits. */

/** A message body stays bounded when sent and when projected from another process into context. */
export const MESSAGE_MAX_CHARS = 8_000;
/** Senders that are not agents: they cannot be replied to, and their messages wake the recipient. */
export const outside = (from: string) => from === USER_SENDER || from === EXTERNAL_SENDER;

/** The notice a sender gets when its message's recipients left the team before reading it, or before answering its question. */
export function deadLetterText(letter: DeadLetter): string {
	const read = letter.read ?? [];
	const unread = letter.recipients.filter((recipient) => !read.includes(recipient));
	const began = renderInstruction("notices/mail/dead-letter-began.md", {
		text: cutText(letter.text.split("\n")[0], 120, { chars: true }),
	});
	if (letter.relay) {
		const reason =
			letter.relay.reason ??
			renderInstruction("notices/mail/dead-letter-parent-left.md", {
				parents: letter.recipients.join(", "),
				to: letter.relay.to,
			});
		return visibleControls(
			renderInstruction("notices/mail/dead-letter-relay.md", { id: letter.id, to: letter.relay.to, reason, began }),
		);
	}
	const notice = (who: string[], wasRead: boolean) =>
		renderInstruction("notices/mail/dead-letter.md", {
			id: letter.id,
			who: who.join(", "),
			read: wasRead,
			one: who.length === 1,
		});
	const parts = [unread.length > 0 ? notice(unread, false) : "", read.length > 0 ? notice(read, true) : ""].filter(
		Boolean,
	);
	return visibleControls(`${parts.join(" ")} ${began}`);
}

/** `reviewer: audit auth token refresh`: what the sender is and works on, as written. Each reader escapes it for its own channel. */
const senderLabel = (sender: NonNullable<Message["sender"]>): string =>
	sender.goal ? `${sender.role}: ${sender.goal}` : sender.role;

/** ` (reviewer: audit auth token refresh)`, so the reader knows who it hears from; empty without a sender. */
const senderTag = (sender: Message["sender"]): string => (sender ? ` (${headerText(senderLabel(sender))})` : "");

/**
 * A delivered message as the recipient reads it: the text of anyone but the user sits in a fence (see `fenceUntrusted`)
 * under a header built here. `fromUser`: the message is verified as the user's (this process created it for the user, or
 * it carries the signature of the parent's secret, see `Mail`); the sender column of the database is shared with other
 * processes and never decides that. `parentUnverified`: the same for the parent, read from a row with no valid signature
 * of it (`Mail`); such a message is the plain untrusted fence, whatever `from` says. `stopped`: an interrupt in
 * this message stopped the recipient's step (it says so).
 */
export function messageText(
	message: Message,
	options: { parentId?: string | undefined; stopped?: boolean; fromUser?: boolean; parentUnverified?: boolean } = {},
): string {
	const { parentId, stopped = false, fromUser = false, parentUnverified = false } = options;
	const claimsUser = message.from === USER_SENDER;
	// The parent steers only through mail it sent or itself passed on: a peer that forwards the parent's message to this
	// agent chose what to replay, so it reads as that peer's untrusted data, with the parent still named as its author.
	const claimsParent = parentId !== undefined && message.from === parentId;
	const writtenByParent = claimsParent && !parentUnverified;
	const fromParent = writtenByParent && (message.forwardedBy === undefined || message.forwardedBy === parentId);
	const label = claimsUser
		? fromUser
			? "the user"
			: renderInstruction("notices/mail/unverified-user.md")
		: message.from === EXTERNAL_SENDER
			? apiClientLabel()
			: `${fromParent ? "your parent agent" : writtenByParent ? "agent (your parent)" : claimsParent ? "agent (recorded as your parent, unverified)" : "agent"} ${headerText(message.from, 64)}${senderTag(message.sender)}`;
	const footer = outside(message.from)
		? ""
		: message.replyRequired
			? renderInstruction("notices/mail/reply-needed.md", { to: headerText(message.from, 64), id: message.id })
			: renderInstruction("notices/mail/no-reply-needed.md");
	// sendMessage saves a longer body to a file and sends its start with the path, so a body over the limit comes from a
	// writer that bypassed it: withheld whole, since a cut instruction can lose the line that changes its meaning.
	const body =
		message.text.length > MESSAGE_MAX_CHARS
			? renderInstruction("notices/mail/body-withheld.md", { max: MESSAGE_MAX_CHARS })
			: message.text;
	// Only the user's own interrupt asks to be acted on first; any other is a request from a sender that is not verified as the user.
	const interrupt = stopped && message.interrupt ? renderInstruction("notices/mail/interrupt.md", { fromUser }) : "";
	// The header says which message this one answers, so a reply reads as one without relying on its content.
	const answers = message.replyTo === undefined ? "" : ` (in reply to #${message.replyTo})`;
	// A forward keeps the original sender, id and fence; the forwarder is named, and its note sits in a fence of its own.
	const forwarded = message.forwardedBy ? ` (forwarded by ${headerText(message.forwardedBy, 64)})` : "";
	const header = `${messageHeader(label, message.at, message.id)}${answers}${forwarded}${interrupt}`;
	const note =
		message.forwardedBy && message.note
			? `${fenceUntrusted(`Note from ${headerText(message.forwardedBy, 64)}, who forwarded message #${message.id}`, message.note, message.forwardedBy === parentId && !parentUnverified ? { note: PARENT_FENCE_NOTE } : {})}\n`
			: "";
	if (fromUser) return `${note}${visibleControls(header)}:\n${visibleControls(body)}`;
	// The parent started this agent and steers its task; peers, API clients and unverified senders stay untrusted data.
	return `${note}${fenceUntrusted(header, body, {
		...(footer ? { footer } : {}),
		...(fromParent ? { note: PARENT_FENCE_NOTE } : {}),
	})}`;
}

/**
 * Why `from` may not interrupt `targets` (undefined when it may): an interrupt cancels running work, so it reaches one
 * subagent, and only from the agent that started it or from the user of its session (`scope`, in `members`).
 */
export function interruptRefusal(
	members: Member[],
	targets: Member[],
	from: string,
	to: string,
	scope: string | undefined,
): string | undefined {
	const [target] = targets;
	if (to === "all" || targets.length !== 1 || !target)
		return "An interrupt reaches one subagent: name its id. Nothing was sent.";
	if (from !== USER_SENDER) {
		return target.parentId === from
			? undefined
			: `An interrupt stops only a subagent you started; ${target.id} is not one. Send it without interrupt. Nothing was sent.`;
	}
	const ours = target.parentId !== undefined && scope !== undefined && sessionTree(members, scope).has(target.id);
	return ours
		? undefined
		: `An interrupt stops only a subagent of this session; ${target.id} is not one. Nothing was sent.`;
}

/** A path to lock as the file tools resolve it: relative from the session's cwd (not the repository root), `~` from home. */
export function resolveLockPath(cwd: string | undefined, entry: string): string {
	return resolveToolPath(cwd ?? process.cwd(), entry);
}

/**
 * The ids of `id`'s session tree: its topmost live ancestor and every live descendant of that ancestor. A broadcast
 * stays inside it, so it never reaches another user's session working in the same repository.
 */
export function sessionTree(members: Member[], id: string): Set<string> {
	const byId = new Map(members.map((member) => [member.id, member]));
	let root = id;
	for (
		let parent = byId.get(root)?.parentId, hops = 0;
		parent && byId.has(parent) && hops < members.length;
		parent = byId.get(root)?.parentId, hops++
	)
		root = parent;
	const tree = new Set([root]);
	for (let grew = true; grew;) {
		grew = false;
		for (const member of members) {
			if (member.parentId && tree.has(member.parentId) && !tree.has(member.id)) {
				tree.add(member.id);
				grew = true;
			}
		}
	}
	return tree;
}

/**
 * Who a message goes to: an id, a role held by one agent, `parent`, or `all` (every other agent in the session tree of
 * `scope`, the sender by default). Returns the recipients or an error text. `stalled` (`TeamStore.list` with `stalled`:
 * process running, not seen for `STALE_MS`) are reached by id or as `parent`, never by role or `all`.
 */
export function resolveTarget(
	members: Member[],
	from: string,
	to: string,
	parentId?: string,
	scope = from,
	stalled: readonly Member[] = [],
): Member[] | string {
	const wanted = to === "parent" ? parentId : to;
	const named = [...members, ...stalled].find((member) => member.id !== from && member.id === wanted);
	if (named && to !== "all") return [named];
	const others = members.filter((member) => member.id !== from);
	if (to === "all") {
		const tree = sessionTree(members, scope);
		const reached = others.filter((member) => tree.has(member.id));
		return reached.length > 0
			? reached
			: "No other agents are in your session tree (the top session and every subagent under it).";
	}
	const byRole = others.filter((member) => member.role === wanted);
	if (byRole.length === 1) return byRole;
	const known = others.map((member) => member.id).join(", ") || "none";
	return byRole.length > 1
		? `"${to}" matches several agents (${known}); use one id.`
		: `No live agent "${to}". Live agents: ${known}.`;
}

/**
 * The `coordinate list` text: one block per agent with join and last-seen times, unanswered messages and reserved paths.
 * `asks` (by agent id; `/agents` passes it) adds each subagent's questions to its parent. `questions` (`Team.openQuestions`)
 * names each unanswered message by id and sender; without it only their count is shown. `standing` adds the requests of a
 * child this agent started against its limit.
 */
export function describeMembers(
	members: Member[],
	selfId: string | undefined,
	now = Date.now(),
	asks?: ReadonlyMap<string, readonly Ask[]>,
	questions?: readonly OpenQuestion[],
	standing?: (id: string) => BudgetStanding | undefined,
): string {
	if (members.length === 0) return "No agents have joined in this repository.";
	const here = members.find((member) => member.id === selfId)?.checkout;
	// Goals, activity and paths come from other processes' rows: untrusted text the model reads.
	return visibleControls(
		members
			.map((member) => {
				const you = member.id === selfId ? " (you)" : "";
				const parent = member.parentId ? ` · parent ${member.parentId}` : "";
				const model = member.model ? ` · ${member.model}` : "";
				const doing = member.status === "working" ? (member.activity ?? "working") : "idle";
				const asked = asksLabel(asks?.get(member.id));
				const waiting = (asks?.get(member.id) ?? []).filter((ask) => !ask.answer);
				const output =
					member.lastOutputAt === undefined ? "" : ` · last output ${formatAgo(now - member.lastOutputAt)}`;
				// Another worktree of the repository: its folder name says where, and its locks are paths in that checkout.
				const elsewhere = here && member.checkout && member.checkout !== here;
				const worktree = elsewhere ? ` · worktree ${path.basename(member.checkout!)}` : "";
				const budget = standing?.(member.id);
				const requests = budget ? ` · ${budget.used} of ${budget.soft} requests, stops at ${budget.hard}` : "";
				return [
					`${member.id}${you} · ${member.role} · ${member.status}${model}${parent}${worktree}`,
					...(member.goal ? [`  goal: ${firstLine(member.goal)}`] : []),
					`  pid ${member.pid}${member.tmuxPane ? ` · tmux pane ${member.tmuxPane}` : ""} · joined ${formatClock(member.joinedAt)} (${formatAgo(now - member.joinedAt)}) · seen ${formatAgo(now - member.updatedAt)} · ${memberStats(member)}${requests}`,
					`  ${firstLine(doing)}${output}`,
					...awaiting(member, now, questions),
					...(asked ? [`  ${asked} to its parent`] : []),
					...waiting.map(
						(ask) =>
							`    #${ask.id} waiting on its parent (${formatAgo(now - ask.askedAt)}): ${cutText(firstLine(ask.text), 80, { chars: true })}`,
					),
					...(member.locks?.length
						? [
								`  holds ${member.locks.join(", ")}${elsewhere ? ` (in worktree ${path.basename(member.checkout!)})` : ""}`,
							]
						: []),
				].join("\n");
			})
			.join("\n"),
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

/** How long a lease has been held, for refusals: `locked 12m ago`. */
export function leaseAge(lease: Lease, now = Date.now()): string {
	return lease.acquiredAt > 0 ? `locked ${formatAgo(now - lease.acquiredAt)}` : "locked";
}

/** Each agent's goal, by id, from a team read: a holder named in a conflict comes with what it works on. */
export const memberGoals =
	(members: readonly Member[]) =>
	(id: string): string | undefined =>
		members.find((member) => member.id === id)?.goal;

/** One line per conflict: the holder, its goal when `goalOf` knows it, what it holds and why (a child's lease says its goal). */
export function conflictLines(
	conflicts: readonly LeaseConflict[],
	now = Date.now(),
	goalOf?: (id: string) => string | undefined,
): string[] {
	return conflicts.map(({ path, heldBy }) => {
		const goal = goalOf?.(heldBy.owner);
		const held = heldBy.kind === "tree" ? `${heldBy.path}/` : heldBy.path;
		const working = goal ? `, working on "${goal}"` : "";
		return `- ${path} is covered by ${heldBy.owner}${working} (${held}${heldBy.reason === goal ? "" : `: ${heldBy.reason}`}; ${leaseAge(heldBy, now)}).`;
	});
}

export function describeConflicts(
	conflicts: readonly LeaseConflict[],
	now = Date.now(),
	goalOf?: (id: string) => string | undefined,
): string {
	return visibleControls(
		[
			"Not reserved; nothing was locked:",
			...conflictLines(conflicts, now, goalOf),
			"Work on something else, or message the holder with agent type message, then lock again after they unlock.",
		].join("\n"),
	);
}

export { mutatedPaths };

/** Whether a lease `kind:key` (see TeamStore.owned) covers the file with comparison key `file`. */
export function covers(lease: string, file: string): boolean {
	const [kind, key = ""] = lease.split(/:(.*)/s);
	return keysOverlap(key, kind === "tree" ? "tree" : "file", file, "file");
}

/** The short reason a database call failed: SQLite's own text (e.g. "database is locked") when there is one. */
export function dbFailure(error: unknown): string {
	const { errstr, code } = error as { errstr?: unknown; code?: unknown };
	if (typeof errstr === "string") return errstr;
	return typeof code === "string" ? code : errorMessage(error).replace(/^Team database unavailable: /, "");
}

/** `coordinate changes` output: one line per file, newest first, naming every agent and tool that changed it (latest first). */
export function describeChanges(
	changes: Change[],
	options: {
		self?: string | undefined;
		minutes: number;
		requested?: number;
		limit: number;
		paths?: string[] | undefined;
	},
	now = Date.now(),
): string {
	const scope = options.paths?.length ? ` under ${options.paths.join(", ")}` : "";
	// `minutes` is the window searched: shorter than `requested` when changes are not kept that long.
	const kept =
		options.requested !== undefined && options.requested > options.minutes
			? [
					`(You asked for ${options.requested}m; changes are kept only ${formatDuration(options.minutes * 60_000)}, so that is all that was searched.)`,
				]
			: [];
	if (changes.length === 0)
		return [
			`No agent changed files${scope} in the last ${options.minutes}m. Files changed outside agents (you, git, scripts, bash commands whose writes cannot be named) are not tracked: search files by modification time for those.`,
			...kept,
		].join("\n");
	const shown = changes.slice(0, options.limit);
	const lines = shown.map(
		(change) =>
			`- ${change.path} · ${change.agents.map((agent) => `${agent}${agent === options.self ? " (you)" : ""}`).join(", ")} via ${change.tools.join(", ")} · ${formatAgo(now - change.at)}${change.count > 1 ? ` · ${change.count} changes` : ""}`,
	);
	const more =
		changes.length > shown.length ? [`(${changes.length - shown.length} more; raise limit or narrow paths)`] : [];
	return visibleControls(
		[
			`Files changed by agents in the last ${options.minutes}m${scope} (newest first):`,
			...lines,
			...more,
			...kept,
		].join("\n"),
	);
}
