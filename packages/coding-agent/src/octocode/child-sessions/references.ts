import { renderInstruction } from "../../core/prompt-template.ts";
import { sha256 } from "../../../../common/src/atomic-file.ts";
import { readChildReport, type SessionChild, sessionChildren } from "./session-children.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { apiClientLabel, fenceUntrusted, headerText, messageHeader } from "../shared/fence.ts";
import { formatClock } from "../shared/format.ts";
import { tildePath } from "../shared/home.ts";
import { EXTERNAL_SENDER, USER_SENDER } from "../shared/messages.ts";

/**
 * Typed references to content stored once: `msg#<N>` (a team message, read through the team store with its
 * authorization) and `report:<agent-id>` (the latest report of a subagent this session started). The system, not a
 * model, expands them: each referent keeps the untrusted fence of the agent that produced it, its producer, its time and
 * a short SHA-256 of the content, so a referrer can neither retype it nor lend it its own authority. Bare `#N` is not a
 * form: it means a backlog item there (`backlog/item.ts`).
 */

/** A team message as the store returns it (owner: `team/`); only the fields a reference shows. */
export interface ReferencedMessage {
	id: number;
	from: string;
	text: string;
	at: number;
	forwardedBy?: string;
}

/** Reads one stored message for `requester`, or why not (not found, expired); `Team` satisfies it. */
export interface MessageReader {
	readMessage(id: number, requester: string): ReferencedMessage | { error: string };
}

/** What a resolution may read, and for whom. */
export interface ReferenceContext {
	/** The team id of the agent whose text cites the references; without one, no message resolves. */
	requester: string | undefined;
	/** The team store, for `msg#<N>`; without it, no message resolves. */
	messages?: MessageReader;
	/** The subagents this session started (`sessionChildren`), for `report:<agent-id>`. */
	children: () => readonly SessionChild[];
	/** The fence note for a message the requester itself sent (a parent's own words in its child's task); else the default untrusted note. */
	ownNote?: string;
	/** Whether the receiving agent can read local report artifacts; external and restricted children cannot. */
	artifactAccess?: "local" | "none";
}

/** One expanded reference: `text` is the fenced block the reader gets. */
export interface ResolvedReference {
	ref: string;
	producer: string;
	at?: number;
	/** The first 12 hex digits of the SHA-256 of the referenced content. */
	sha: string;
	text: string;
}

/** The citable handle of a subagent's report, as report headers show it. */
export const reportRef = (id: string): string => `report:${id}`;

/** Bound automatic expansion; instructions in messages are never silently shortened. */
const MAX_MESSAGE_CHARS = 8_192;
const REPORT_EXCERPT_CHARS = 4_096;
const MAX_HANDOFF_CHARS = 32_768;
export const MAX_HANDOFF_REFERENCES = 16;
const SHA_DIGITS = 12;
/** `msg#12`, `report:general-bg`, not inside a word, path or URL, without a trailing sentence dot. */
const REFERENCE = /(?<![\w#:/.-])(msg#\d+|report:[A-Za-z0-9](?:[\w.-]*[A-Za-z0-9])?)(?![\w#])/g;
const MESSAGE_REF = /^msg#(\d+)$/;
const REPORT_REF = /^report:([A-Za-z0-9](?:[\w.-]*[A-Za-z0-9])?)$/;

/** The references `text` cites, each once, in order of first mention. */
export function findReferences(text: string): string[] {
	return [...new Set([...text.matchAll(REFERENCE)].map((match) => match[1]))];
}

/** The context for references cited by this process's agent: its team id and store, and the children its session records. */
export function referenceContext(
	team: MessageReader & { readonly id: string | undefined },
	ctx: { sessionManager: { getEntries(): readonly unknown[] } },
	ownNote?: string,
): ReferenceContext {
	return {
		requester: team.id,
		messages: team,
		children: () => sessionChildren(ctx.sessionManager.getEntries()),
		...(ownNote ? { ownNote } : {}),
	};
}

const shortSha = (text: string): string => sha256(text).slice(0, SHA_DIGITS);

function resolveMessage(ref: string, id: number, ctx: ReferenceContext): ResolvedReference | string {
	// Not found and not authorized read the same, so a reference cannot probe for messages it may not read.
	if (!ctx.requester || !ctx.messages) return `${ref}: not found`;
	let found: ReferencedMessage | { error: string };
	try {
		found = ctx.messages.readMessage(id, ctx.requester);
	} catch (error) {
		return `${ref}: could not be read (${errorMessage(error)})`;
	}
	if ("error" in found) return `${ref}: ${found.error}`;
	if (found.text.length > MAX_MESSAGE_CHARS)
		return `${ref}: message exceeds the ${MAX_MESSAGE_CHARS}-character inline limit; cite a smaller message or ask its sender for a summary containing the required instructions`;
	const who =
		found.from === USER_SENDER
			? renderInstruction("notices/mail/unverified-user.md")
			: found.from === EXTERNAL_SENDER
				? apiClientLabel()
				: `agent ${headerText(found.from, 64)}`;
	const sha = shortSha(found.text);
	const forwarded = found.forwardedBy ? `, forwarded by ${headerText(found.forwardedBy, 64)}` : "";
	const header = `${ref}: ${messageHeader(who, found.at, found.id)}${forwarded} (sha256 ${sha})`;
	const own = ctx.ownNote && found.from === ctx.requester ? { note: ctx.ownNote } : {};
	return {
		ref,
		producer: found.from,
		at: found.at,
		sha,
		text: fenceUntrusted(header, found.text, own),
	};
}

async function resolveReport(ref: string, id: string, ctx: ReferenceContext): Promise<ResolvedReference | string> {
	const child = ctx.children().find((candidate) => candidate.id === id);
	if (!child) return `${ref}: no subagent "${id}" was started by this session`;
	if (child.status === "background") return `${ref}: ${id} has not reported yet`;
	// Read the version selected by the session, retaining a bounded excerpt and hashing the whole artifact.
	let body:
		| { text: string; at?: number; file?: string; sha256?: string; truncated?: boolean; tail?: string }
		| undefined;
	if (child.report) {
		try {
			body = { ...(await readChildReport(child.report, child.reportArtifact?.sha256)), file: child.report };
		} catch (error) {
			// Swept or removed: the received report still answers. A file that is not the child's own is refused outright.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				return `${ref}: refused ${tildePath(child.report)} (${errorMessage(error)}); only a regular report artifact in ${id}'s scratch folder is read`;
		}
	}
	body ??= child.reportText === undefined ? undefined : { text: child.reportText, at: child.reportAt };
	if (!body) return `${ref}: ${id} has no saved report (it ${child.status || "ended"} without one)`;
	const sha = body.sha256?.slice(0, SHA_DIGITS) ?? shortSha(body.text);
	const outcome = child.outcome ? `, reported ${child.outcome}` : "";
	const when = body.at === undefined ? "" : ` at ${formatClock(body.at)}`;
	const header = `${ref}: Report of subagent ${headerText(id, 64)} (${headerText(child.profile, 40)}: ${headerText(child.goal, 120)})${outcome}${when} (sha256 ${sha})`;
	const excerpt = body.truncated || body.text.length > REPORT_EXCERPT_CHARS;
	if (excerpt && ctx.artifactAccess === "none")
		return `${ref}: report exceeds the ${REPORT_EXCERPT_CHARS}-character inline limit and the recipient cannot read local artifacts; provide a focused summary containing the required evidence`;
	const source = body.file ?? child.transcript ?? child.folder;
	if (excerpt && !source)
		return `${ref}: report exceeds the ${REPORT_EXCERPT_CHARS}-character inline limit without a saved artifact; request a smaller report or a summary`;
	const content = excerpt
		? `${body.text.slice(0, REPORT_EXCERPT_CHARS - 512)}\n\n[Excerpt: intervening details omitted; read or search ${tildePath(source!)} for the complete report before relying on omitted details.]\n\n${(body.tail ?? body.text).slice(-512)}`
		: body.text;
	return {
		ref,
		producer: id,
		...(body.at === undefined ? {} : { at: body.at }),
		sha,
		text: fenceUntrusted(header, content),
	};
}

/**
 * Expands each reference (duplicates once). `errors` holds one line per reference that cannot be resolved, starting
 * with the reference: malformed, not found (or not readable by the requester), expired, or a report that does not exist.
 */
export async function resolveReferences(
	refs: readonly string[],
	ctx: ReferenceContext,
): Promise<{ resolved: ResolvedReference[]; errors: string[] }> {
	const resolved: ResolvedReference[] = [];
	const errors: string[] = [];
	const unique = new Set(refs.map((value) => value.trim()));
	if (unique.size > MAX_HANDOFF_REFERENCES)
		return {
			resolved: [],
			errors: [
				`Reference handoff exceeds the limit of ${MAX_HANDOFF_REFERENCES} references; cite fewer sources or a focused summary`,
			],
		};
	for (const ref of unique) {
		const message = MESSAGE_REF.exec(ref);
		const report = message ? undefined : REPORT_REF.exec(ref);
		const result = message
			? resolveMessage(ref, Number(message[1]), ctx)
			: report
				? await resolveReport(ref, report[1], ctx)
				: `${ref || "(empty)"}: not a reference (use msg#<N> or report:<agent-id>)`;
		if (typeof result === "string") errors.push(result);
		else {
			resolved.push(result);
			if (referencedContentBlock(resolved).length > MAX_HANDOFF_CHARS)
				return {
					resolved: [],
					errors: [
						...errors,
						`Reference handoff exceeds the ${MAX_HANDOFF_CHARS}-character limit; cite fewer sources or a focused summary`,
					],
				};
		}
	}
	return { resolved, errors };
}

/** The `## Referenced content` section that carries the expanded references; empty when there are none. */
export function referencedContentBlock(resolved: ResolvedReference[]): string {
	if (resolved.length === 0) return "";
	return [
		"## Referenced content",
		renderInstruction("notices/mail/referenced-content.md"),
		...resolved.map((reference) => reference.text),
	].join("\n\n");
}
