import { renderPrompt } from "../../core/prompt-template.ts";
import { mutatedPaths } from "../tool-input/file-input.ts";
import { apiClientLabel, fenceUntrusted, headerText, messageHeader, PARENT_FENCE_NOTE } from "../shared/fence.ts";
import { formatAgo, formatDuration } from "../shared/format.ts";
import { resolveToolPath } from "../shared/home.ts";
import { EXTERNAL_SENDER, USER_SENDER } from "../shared/messages.ts";
import { visibleControls } from "@octocodeai/octocode-common/sanitize";
import type { Change } from "./edits.ts";
import { keysOverlap } from "./lease-key.ts";
import type { DeadLetter, Lease, LeaseConflict, Message, RecipientKind } from "./model.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { cutText } from "@octocodeai/octocode-common/text";

/** Pure text and routing helpers for the team: recipients, refusals, which paths a call edits (`coordinate list`: `member-list.ts`). */

/** A message body stays bounded when sent and when projected from another process into context. */
export const MESSAGE_MAX_CHARS = 8_000;
/** Senders that are not agents: they cannot be replied to, and their messages wake the recipient. */
export const outside = (from: string) => from === USER_SENDER || from === EXTERNAL_SENDER;

/** What a sender can do about mail `who` can no longer read: a child's report and resume, or, for a peer, another agent or the user. */
export const nextStep = (who: string, { child, reported }: RecipientKind): string =>
	renderPrompt("notices/mail/dead-letter-next.md", { who, child, reported });

const PEER: RecipientKind = { child: false, reported: false };

/**
 * The notice a sender gets when its message's recipients left the team before reading it, or before answering its
 * question, ending with the next step for each (`letter.kinds`; a recipient it does not name is a peer).
 */
export function deadLetterText(letter: DeadLetter): string {
	const read = letter.read ?? [];
	const unread = letter.recipients.filter((recipient) => !read.includes(recipient));
	const began = renderPrompt("notices/mail/dead-letter-began.md", {
		text: cutText(letter.text.split("\n")[0], 120, { chars: true }),
	});
	if (letter.relay) {
		const reason =
			letter.relay.reason ??
			renderPrompt("notices/mail/dead-letter-parent-left.md", {
				parents: letter.recipients.join(", "),
				to: letter.relay.to,
			});
		return visibleControls(
			renderPrompt("notices/mail/dead-letter-relay.md", { id: letter.id, to: letter.relay.to, reason, began }),
		);
	}
	const notice = (who: string[], wasRead: boolean) =>
		renderPrompt("notices/mail/dead-letter.md", {
			id: letter.id,
			who: who.join(", "),
			read: wasRead,
			one: who.length === 1,
		});
	const parts = [unread.length > 0 ? notice(unread, false) : "", read.length > 0 ? notice(read, true) : ""].filter(
		Boolean,
	);
	const next = new Set(letter.recipients.map((recipient) => nextStep(recipient, letter.kinds?.[recipient] ?? PEER)));
	return visibleControls(`${parts.join(" ")} ${began} ${[...next].join(" ")}`);
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
			: renderPrompt("notices/mail/unverified-user.md")
		: message.from === EXTERNAL_SENDER
			? apiClientLabel()
			: `${fromParent ? "your coordinator" : writtenByParent ? "agent (your coordinator)" : claimsParent ? "agent (recorded as your coordinator, unverified)" : "agent"} ${headerText(message.from, 64)}${senderTag(message.sender)}`;
	const footer = outside(message.from)
		? ""
		: message.replyRequired
			? renderPrompt("notices/mail/reply-needed.md", { to: headerText(message.from, 64), id: message.id })
			: renderPrompt("notices/mail/no-reply-needed.md");
	// sendMessage saves a longer body to a file and sends its start with the path, so a body over the limit comes from a
	// writer that bypassed it: withheld whole, since a cut instruction can lose the line that changes its meaning.
	const body =
		message.text.length > MESSAGE_MAX_CHARS
			? renderPrompt("notices/mail/body-withheld.md", { max: MESSAGE_MAX_CHARS })
			: message.text;
	// Only the user's own interrupt asks to be acted on first; any other is a request from a sender that is not verified as the user.
	const interrupt = stopped && message.interrupt ? renderPrompt("notices/mail/interrupt.md", { fromUser }) : "";
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
 * Why `from` may not interrupt `targets` (undefined when it may): an interrupt cancels running work, so it reaches only
 * subagents `from` started, or, from the user of its session (`scope`, in `members`), subagents of that session. Every
 * target must qualify: one that does not refuses the whole send, so a broadcast never stops a peer by accident.
 */
export function interruptRefusal(
	members: Member[],
	targets: Member[],
	from: string,
	to: string,
	scope: string | undefined,
): string | undefined {
	if (targets.length === 0) return "An interrupt needs a recipient: name a subagent id, or use all. Nothing was sent.";
	const tree = from === USER_SENDER && scope !== undefined ? sessionTree(members, scope) : undefined;
	for (const target of targets) {
		if (from !== USER_SENDER) {
			if (target.parentId !== from)
				return to === "all"
					? `An interrupt stops only subagents you started; ${target.id} is not one. Name your subagents one by one, or send without interrupt. Nothing was sent.`
					: `An interrupt stops only a subagent you started; ${target.id} is not one. Send it without interrupt. Nothing was sent.`;
		} else if (target.parentId === undefined || !tree?.has(target.id)) {
			return `An interrupt stops only a subagent of this session; ${target.id} is not one. Nothing was sent.`;
		}
	}
	return undefined;
}

/** Whether `name` is an Octocode process title (`octocode-main-<id>`, `octocode-rpc-<id>`; see `processes/title.ts`), not an agent id. */
export const isProcessName = (name: string): boolean => /^octocode-(main|rpc)-/.test(name);

/** A path to lock as the file tools resolve it: relative from the session's cwd (not the repository root), `~` from home. */
export function resolveLockPath(cwd: string | undefined, entry: string): string {
	return resolveToolPath(cwd ?? process.cwd(), entry);
}

/**
 * The ids of `id`'s session tree: its topmost live ancestor and every live descendant of that ancestor. A broadcast
 * stays inside it, so it never reaches another user's session working in the same repository. An ancestor that is not
 * listed (left, or not joined yet) still roots the tree, so the children it started stay one team.
 */
export function sessionTree(members: readonly Member[], id: string): Set<string> {
	const byId = new Map(members.map((member) => [member.id, member]));
	let root = id;
	for (
		let parent = byId.get(root)?.parentId, hops = 0;
		parent && hops <= members.length;
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

/** The refusal a subagent gets for a recipient outside its session tree: only its parent reaches other trees. */
const outsideTeam = (who: string, parentId: string | undefined) =>
	`${who} is outside your team; ask your coordinator (${parentId}) to relay.`;

/**
 * Who a message goes to: an id, a role held by one agent, `parent`, or `all` (every other agent in the session tree of
 * `scope`, the sender by default). Returns the recipients or an error text. `stalled` (`TeamStore.list` with `stalled`:
 * process running, not seen for `STALE_MS`) are reached by id, as `parent` or by `all`, never by role. A subagent sender
 * (`parentId` set, `from` an agent) reaches only its session tree, its parent included, plus `answering` (the sender of
 * the message it replies to, who opened that conversation); anything beyond goes through its parent.
 */
export function resolveTarget(
	members: Member[],
	from: string,
	to: string,
	parentId?: string,
	scope = from,
	stalled: readonly Member[] = [],
	answering?: string,
): Member[] | string {
	const wanted = to === "parent" ? parentId : to;
	const everyone = [...members, ...stalled];
	const confined = parentId !== undefined && !outside(from);
	// Built from stalled members too, so a silent parent still links its children to the tree.
	const team = confined ? sessionTree(everyone, scope) : undefined;
	const inTeam = (member: Member) => !team || team.has(member.id) || member.id === parentId || member.id === answering;
	const named = everyone.find((member) => member.id !== from && member.id === wanted);
	if (named && to !== "all") return inTeam(named) ? [named] : outsideTeam(named.id, parentId);
	// `parent` is the coordinator's id, never a role: once it left, the child is told so, and how to end its run.
	if (to === "parent" && parentId !== undefined && !outside(from))
		return renderPrompt("notices/mail/coordinator-left.md", { parent: parentId });
	const others = members.filter((member) => member.id !== from);
	if (to === "all") {
		// A stalled member is still in the session: its mail waits for it, like a named message does.
		const tree = sessionTree(everyone, scope);
		const reached = everyone.filter((member) => member.id !== from && tree.has(member.id));
		return reached.length > 0
			? reached
			: "No other agents are in your session tree (the top session and every subagent under it).";
	}
	const roleHolders = others.filter((member) => member.role === wanted);
	const byRole = roleHolders.filter(inTeam);
	if (byRole.length === 1) return byRole;
	if (byRole.length === 0 && roleHolders.length > 0) return outsideTeam(`Every "${to}"`, parentId);
	const known =
		others
			.filter(inTeam)
			.map((member) => member.id)
			.join(", ") || "none";
	return byRole.length > 1
		? `"${to}" matches several agents (${known}); use one id.`
		: `No live agent "${to}". Live agents: ${known}.`;
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
