import type { Member, Traffic } from "@octocodeai/octocode-contracts/team";
import { visibleControls } from "@octocodeai/octocode-common/sanitize";
import { cutText } from "@octocodeai/octocode-common/text";
import type { BadgeState } from "../../../theme/page-kit.ts";
import { cachedPercent, formatAgo, formatCost, formatTokenUsage } from "../../shared/format.ts";
import { formatDuration } from "../../../utils/duration.ts";
import { firstLine } from "../../shared/util.ts";
import type { MemberDetails } from "../../team/store/details.ts";
import { memberWorktree, worktreeLabel } from "../../worktree-paths/member-worktree.ts";
import { labelValueRows } from "../../../theme/columns.ts";

/** Messages to or from the agent shown on its page. */
const MESSAGES_SHOWN = 8;

export interface AgentDetailInput {
	member: Member;
	/** The viewing session's checkout: a worktree is named only when it differs. */
	here?: string;
	now: number;
	/** Its backlog item and transcript folder (`RunAudit.details`). */
	details?: MemberDetails;
	/** Recent team messages, newest first; those not to or from the agent are skipped. */
	traffic: readonly Traffic[];
	/** Where its finished report was written (`AgentRun.reportPath`). */
	reportPath?: string;
}

export interface AgentDetail {
	state: BadgeState;
	/** Label and value, in display order; a value may span lines. */
	facts: Array<[string, string]>;
}

const STATE: Record<Member["status"], BadgeState> = { working: "ready", idle: "off", settled: "off" };

/** `broken` for a failed run, `needs action` for one blocked, partial or waiting on the user. */
function stateOf(member: Member): BadgeState {
	if (member.outcome === "failed") return "broken";
	if (member.outcome === "blocked" || member.outcome === "partial" || member.waiting) return "attention";
	return STATE[member.status];
}

const clean = (text: string): string => visibleControls(text).trim();

function messageLine(message: Traffic, id: string, now: number): string {
	const arrow = message.from === id ? `to ${message.to.join(", ")}` : `from ${message.from}`;
	return `#${message.id} ${arrow} (${formatAgo(now - message.at)}, ${message.state}): ${cutText(clean(firstLine(message.text)), 100, { chars: true })}`;
}

/** Everything the agent page shows about one agent: other processes' text, so control characters are escaped. */
export function agentDetail(input: AgentDetailInput): AgentDetail {
	const { member, now, details, traffic } = input;
	const cache = cachedPercent(member.cacheRead, member.input);
	const usage = formatTokenUsage(member);
	const folder = memberWorktree(member, input.here);
	const place = [folder ? worktreeLabel(folder) : undefined, member.branch, member.cwd].filter(Boolean).join(" · ");
	const item = details?.item;
	const messages = traffic
		.filter((message) => message.from === member.id || message.to.includes(member.id))
		.slice(0, MESSAGES_SHOWN)
		.map((message) => messageLine(message, member.id, now));
	const rows: Array<[string, string | undefined]> = [
		["name", member.id],
		["role", member.role + (member.parentId ? ` · parent ${member.parentId}` : "")],
		["model", member.model],
		[
			"status",
			[
				member.status,
				member.waiting ? `waiting on ${member.waiting === "approval" ? "an approval" : "a reply"}` : undefined,
				member.outcome ? `${member.outcome}${member.headline ? `: ${member.headline}` : ""}` : undefined,
			]
				.filter(Boolean)
				.join(" · "),
		],
		["elapsed", `${formatDuration(now - member.joinedAt)} · seen ${formatAgo(now - member.updatedAt)}`],
		[
			"tokens",
			usage
				? `${usage}${cache === undefined ? "" : ` · ${cache}% cached`} · ${member.toolCalls} tool calls`
				: undefined,
		],
		["cost", formatCost(member) || undefined],
		["goal", member.goal],
		["activity", member.status === "working" ? (member.activity ?? "working") : "idle"],
		["item", item ? `B${item.seq} ${firstLine(item.title)}${item.more ? ` (+${item.more} more)` : ""}` : undefined],
		["worktree", place || undefined],
		["holds", member.locks?.length ? member.locks.join(", ") : "no files reserved"],
		["messages", messages.length > 0 ? messages.join("\n") : "none in the last 10 minutes"],
		["transcripts", details?.transcripts],
		["report", input.reportPath],
	];
	return {
		state: stateOf(member),
		facts: rows
			.filter((row): row is [string, string] => Boolean(row[1]))
			.map(([label, value]) => [label, clean(value)]),
	};
}

/** The page as plain text, for sessions without a UI. */
export function agentDetailPageText(detail: AgentDetail): string {
	return labelValueRows(detail.facts).join("\n");
}
