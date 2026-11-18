import { Box, type Component, Text } from "@octocodeai/octocode-tui";
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import type { Theme } from "../../../theme/theme.ts";
import { resultBlock } from "../../render/tool.ts";
import { entityOfRole } from "../../shared/entity.ts";
import { formatClock } from "../../shared/format.ts";
import { USER_SENDER } from "../../shared/messages.ts";
import { clip, plural } from "../../shared/text.ts";
import type { Endpoint } from "@octocodeai/octocode-contracts/team";
import { endpointMarks, endpointName } from "../endpoint.ts";
import type { MailDetails } from "../model.ts";

/**
 * Agent mail as the transcript draws it, outgoing and incoming alike: `sender → recipient`, the message number and its
 * kind (request, FYI, reply to #N, interrupt), then the body. A delivered message names its real recipient (the agent whose
 * transcript this is) with role and, when `endpoints` resolves them, worktree and tmux marks; an entry without a recipient
 * (a team notice, an old entry) names the sender only.
 */

/** Resolves an agent id to its endpoint at render time (live row, else the row it left); absent: ids and recorded roles only. */
export type EndpointResolver = (id: string) => Endpoint;

/** Columns of the sent text shown on the collapsed result row. */
const PREVIEW_CHARS = 60;
/** Body lines a collapsed delivered message shows. */
const MAIL_PREVIEW_LINES = 3;

/** Arguments are model output and details another process's data: only strings and numbers are shown. */
const text = (value: unknown): string =>
	typeof value === "string" ? value : typeof value === "number" ? String(value) : "";

interface Kinded {
	replyRequired?: unknown;
	replyTo?: unknown;
	interrupt?: unknown;
}

/** The kind words of a message: a reply names what it answers (`reply` alone when the recipient already does). */
function kinds(message: Kinded, replyLinked = true): string[] {
	const words = [
		message.replyTo === undefined ? "" : replyLinked ? `reply to #${text(message.replyTo)}` : "reply",
		message.replyRequired === true ? "request" : "",
		message.interrupt === true ? "interrupt" : "",
	].filter(Boolean);
	return words.length ? words : ["FYI"];
}

/** The Send header's summary: `you → parent · request`, `you → sender of #17 · reply`, `you → eel · forward #17`. */
export function sendSummary(args: Record<string, unknown>): string {
	const named = args.to === undefined ? undefined : text(args.to);
	const to = named ?? (args.replyTo === undefined ? "" : `sender of #${text(args.replyTo)}`);
	if (!to && args.forward === undefined && args.message === undefined) return "";
	const kind = args.forward === undefined ? kinds(args, named !== undefined) : [`forward #${text(args.forward)}`];
	// A new message to a named agent wakes it by default, so only a choice that differs is shown: `no wake`, or a waking reply.
	if (args.wake === false) kind.push("no wake");
	else if (args.wake === true && args.replyTo !== undefined) kind.push("wake");
	return [`you → ${to || "?"}`, ...kind].join(" · ");
}

/** The result line: `#42 queued for kraken`; a recipient the header names already is not repeated. */
export function sendOutcome(args: Record<string, unknown>, details: Record<string, unknown>): string {
	const sent = Array.isArray(details.to) ? details.to.map(text) : [];
	const named = args.to === undefined ? undefined : text(args.to);
	const verb = details.forwarded === true ? "forwarded" : "queued";
	const [only] = sent;
	const recipients =
		sent.length > 1 ? ` for ${plural(sent.length, "agent")}` : only && only !== named ? ` for ${clip(only, 64)}` : "";
	const relayed = typeof details.relayed === "string" ? ` via ${clip(details.relayed, 64)}` : "";
	const departed =
		Array.isArray(details.departed) && details.departed.length
			? ` · not sent to ${details.departed.map(text).join(", ")}`
			: "";
	return `#${text(details.id)} ${verb}${recipients}${relayed}${departed}`;
}

/** The collapsed result line adds the start of what was sent; expanded, the body below shows all of it. */
export function sendPreview(message: string): string {
	const first = clip(message.trimStart(), PREVIEW_CHARS);
	return first ? ` · "${first}"` : "";
}

const KIND_COLOR = { request: "warning", interrupt: "error", FYI: "dim" } as const;

/** One delivered message: `✉ 🐙 ink(main) [worktree fix] → you(main) · #51 · request · 16:05:00`, then its body (previewed while collapsed). */
function mailEntry(
	theme: Theme,
	entry: Record<string, unknown>,
	expanded: boolean,
	resolve: EndpointResolver | undefined,
): Component[] {
	const from = clip(text(entry.from) || "agent", 64);
	const recorded = asRecord(entry.sender).role;
	const isUser = from === USER_SENDER;
	const known: Endpoint = (!isUser && resolve?.(from)) || { id: from };
	// The resolver knows live and departed agents; a sender it cannot place keeps the role its message recorded.
	const sender: Endpoint = {
		...known,
		...(known.role === undefined && typeof recorded === "string" && !isUser ? { role: recorded } : {}),
	};
	const mark = sender.role !== undefined && !isUser ? `${entityOfRole(sender.role)} ` : "";
	const toId = text(entry.to) ? clip(text(entry.to), 64) : undefined;
	const recipient: Endpoint | undefined = toId ? (resolve?.(toId) ?? { id: toId }) : undefined;
	/** `ink(main) [worktree fix, tmux %2]`: the name, then where the agent works when that is known. */
	const shown = (end: Endpoint): string => {
		const marks = endpointMarks(end);
		return marks.length ? `${endpointName(end)} [${marks.join(", ")}]` : endpointName(end);
	};
	const kind = kinds(entry).map((word) =>
		theme.fg(word in KIND_COLOR ? KIND_COLOR[word as keyof typeof KIND_COLOR] : "success", word),
	);
	const by = typeof entry.forwardedBy === "string" ? clip(entry.forwardedBy, 64) : undefined;
	const dot = theme.fg("dim", " · ");
	const meta = [
		typeof entry.id === "number" ? theme.fg("accent", `#${entry.id}`) : "",
		...kind,
		by ? theme.fg("dim", `forwarded by ${by}`) : "",
		theme.fg("dim", formatClock(typeof entry.at === "number" ? entry.at : Date.now())),
	].filter(Boolean);
	const who = theme.fg("toolTitle", theme.bold(shown(sender)));
	const to = recipient ? ` ${theme.fg("dim", "→")} ${theme.fg("toolTitle", shown(recipient))}` : "";
	const header = `${theme.fg("accent", "✉")} ${mark}${who}${to}${dot}${meta.join(dot)}`;
	const note = by && entry.note !== undefined ? `${by}: ${text(entry.note)}\n` : "";
	const lines = `${note}${text(entry.text)}`.split("\n");
	// Collapsed, the first lines and how many more; the kit shows a short body whole, so the preview is cut here.
	const cut = !expanded && lines.length > MAIL_PREVIEW_LINES;
	const body = (cut ? lines.slice(0, MAIL_PREVIEW_LINES) : lines).join("\n");
	// resultBlock sanitizes the body.
	return [
		new Text(header, 0, 0),
		resultBlock(
			theme,
			{ expanded },
			{ summary: "", body, error: false, max: MAIL_PREVIEW_LINES, ...(cut ? { totalLines: lines.length } : {}) },
		),
	];
}

/** Delivered team mail: one header and body per message of the batch. */
export function mailRows(
	message: { content?: unknown; details?: unknown },
	options: { expanded?: boolean; outputPad?: number; endpoints?: EndpointResolver },
	theme: Theme,
): Component {
	const mail = (message.details as Partial<MailDetails> | undefined)?.messages;
	const box = new Box(options.outputPad ?? 1, 0);
	// Details are another process's data: anything but a batch shows the text the model got.
	const entries: unknown[] = Array.isArray(mail) ? mail : [{ from: "agent", text: text(message.content) }];
	for (const entry of entries)
		for (const row of mailEntry(theme, asRecord(entry), options.expanded === true, options.endpoints))
			box.addChild(row);
	return box;
}
