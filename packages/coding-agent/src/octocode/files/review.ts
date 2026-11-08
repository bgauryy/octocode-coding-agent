import type { OptionRole, Question } from "@octocodeai/octocode-contracts";
import type { ExtensionContext } from "../../core/features/index.ts";
import type { ExtensionUIPermissionRequest } from "../../core/features/types.ts";
import { ask } from "../ask/ask.ts";
import { approvalQuestion } from "../ask/question.ts";
import { kindOption } from "../permission/ask/text.ts";
import { systemNote } from "../permission/ask/view.ts";
import { plural } from "../shared/render/text.ts";
import { foldLines } from "../permission/effect.ts";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import { clipText } from "../shared/util.ts";

/**
 * The review of a `file` batch: the `file.workspace` permission dialog. In `manual` mode every batch shows each
 * change with the system's reason lines and the model's reason (labelled unverified, last), and the user applies all, rejects all, or decides change by change.
 */

interface ChangeQuery {
	movePath?: string;
	type: string;
	path: string;
	reason: string;
	edits?: Array<{ oldText: string; newText: string; replaceAll?: boolean }> | undefined;
	content?: string | undefined;
}

// Model-supplied paths, reason and file text reach Octocode's dialogs: strip terminal escapes first.
const clipLine = (line: string, max = 110) => clipText(sanitizeTerminalText(line), max);

/** A change's target on one line: a path may hold a line break, which must not add dialog lines. */
const target = (query: ChangeQuery): string =>
	`${query.type} ${foldLines(query.path)}${query.movePath ? ` → ${foldLines(query.movePath)}` : ""}`;

const AGENT_SAYS = "agent says (unverified):";

/** What the agent says a change is for, as the dialogs label it. */
const agentSays = (reason: string, label = ""): string => `${AGENT_SAYS} ${label}${clipLine(foldLines(reason), 160)}`;

function snippet(text: string, sign: "-" | "+", maxLines = 3): string[] {
	const lines = text.replace(/\n$/, "").split("\n");
	return [
		...lines.slice(0, maxLines).map((line) => `${sign} ${clipLine(line)}`),
		...(lines.length > maxLines ? [`${sign} … ${lines.length - maxLines} more line(s)`] : []),
	];
}

/** What a change does, for the review dialog: what, a bounded preview of the text involved, then what the agent says about it (unverified, last). */
export function describeChange(query: ChangeQuery): string[] {
	const head = target(query);
	const says = `  ${agentSays(query.reason)}`;
	if (query.type === "delete") return [head, "  removes the file", says];
	if (query.type === "write") return [head, ...snippet(query.content ?? "", "+", 5).map((line) => `  ${line}`), says];
	const edits = query.edits ?? [];
	return [
		`${head} · ${plural(edits.length, "edit")}`,
		...edits
			.slice(0, 3)
			.flatMap((edit) =>
				[
					...(edit.replaceAll ? ["all occurrences"] : []),
					...snippet(edit.oldText, "-", 2),
					...snippet(edit.newText, "+", 2),
				].map((line) => `  ${line}`),
			),
		...(edits.length > 3 ? [`  … ${edits.length - 3} more edit(s)`] : []),
		says,
	];
}

const APPLY_ALL = "Apply all";
/** Apply these and every later file change in the repository this session without reviewing. */
const APPLY_SESSION = kindOption("file.workspace")!;
const ONE_BY_ONE = "Review one by one";
const REJECT_ALL = "Reject all";
const REJECT_ALL_NOTE = "Reject all and tell the agent why…";
const APPLY = "Apply";
const REJECT = "Reject";
const REJECT_NOTE = "Reject and tell the agent why…";

/** Dim lines a question's metadata holds at most (`QUESTION_LIMITS.metaLines`). */
const META_LINES = 12;
/** Preview lines a per-change question shows, leaving room for what the agent says. */
const PREVIEW_LINES = META_LINES - 2;
const NOTE_TITLE = "Tell the agent why";
const NOTE_PLACEHOLDER = "what to change instead";

/** `lines` cut to `max`, the last one saying how many more there are. */
const capped = (lines: string[], max: number, more: (count: number) => string): string[] =>
	lines.length <= max ? lines : [...lines.slice(0, max - 1), more(lines.length - max + 1)];

interface ReviewStep {
	question: string;
	/** The exact changes this answer covers; an RPC client reads them as the permission's targets. */
	targets: string[];
	/** What the change does, dim: a bounded preview of the text involved. */
	preview?: string[];
	/** What the agent says about each change, unverified, drawn last. */
	says: string[];
	reasonLines: readonly string[];
	/** The choices, each with what it means to the engine; the one without a role opens a per-change review. */
	choices: [label: string, role?: OptionRole][];
	identity: Pick<ExtensionUIPermissionRequest, "toolCallId" | "toolName">;
}

/** One review dialog as an approval question: its `allow_once` and `deny` choices are the permission's `allowOnce` and `rejectOnce`. */
function reviewQuestion(step: ReviewStep): Question {
	const preview = capped(step.preview ?? [], PREVIEW_LINES, (count) => `… ${count} more line(s)`);
	const says = capped(step.says, META_LINES - preview.length, (count) => `${AGENT_SAYS} … ${count} more`);
	const meta = [...preview, ...says];
	const note = step.choices.find(([, role]) => role === "deny_note")?.[0];
	return approvalQuestion({
		id: "file-review",
		view: {
			question: step.question,
			...(meta.length ? { meta } : {}),
			...(step.reasonLines.length ? { notes: step.reasonLines.map(systemNote) } : {}),
			options: step.choices.map(([label, role]) => ({
				label,
				...(role === "deny" || role === "deny_note" ? { tone: "danger" as const } : {}),
			})),
			...(note ? { writeIn: { label: note, title: NOTE_TITLE, placeholder: NOTE_PLACEHOLDER } } : {}),
		},
		roles: Object.fromEntries(step.choices.flatMap(([label, role]) => (role ? [[label, role]] : []))),
		approval: { ...step.identity, action: "file.workspace", targets: step.targets },
	});
}

/** The choice picked in one review dialog and the note typed with it; undefined when dismissed or when it picks none of the offered choices. */
async function decide(
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
	step: ReviewStep,
	signal: AbortSignal | undefined,
): Promise<{ label: string; note: string | undefined } | undefined> {
	const question = reviewQuestion(step);
	const [reply] = await ask(ctx, [question], signal ? { signal } : {});
	if (!reply || "cancelled" in reply || signal?.aborted) return undefined;
	const picked = question.options?.find((option) => option.id === reply.picks[0]);
	return picked ? { label: picked.label, note: reply.text?.trim() || undefined } : undefined;
}

/**
 * Ask which changes of a batch to apply. Maps rejected indices to optional user notes, or returns 'cancelled' when the dialog was
 * dismissed or interrupted (no verdict). Nothing is applied before this returns. `Permission.check` runs it, inside
 * its one-dialog-at-a-time lock. Every dialog is an `approval` question, so a host that draws no card (an RPC client
 * without `ask`) still gets its `select` with the permission fields derived from it.
 */
export async function askReview(
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
	queries: ChangeQuery[],
	signal?: AbortSignal,
	reasonLines: readonly string[] = [],
	identity: Pick<ExtensionUIPermissionRequest, "toolCallId" | "toolName"> = {},
): Promise<Map<number, string | undefined> | "cancelled" | "session"> {
	const all = (note?: string) => new Map(queries.map((_, index) => [index, note]));
	const raw = (query: ChangeQuery) => `${query.type} ${query.path}${query.movePath ? ` → ${query.movePath}` : ""}`;
	const whole = await decide(
		ctx,
		{
			question: `Apply ${plural(queries.length, "file change")}?`,
			targets: queries.map(raw),
			says: queries.map((query, index) => agentSays(query.reason, `${index + 1}. `)),
			reasonLines,
			choices: [
				[APPLY_ALL, "allow_once"],
				[APPLY_SESSION, "allow_kind"],
				...(queries.length > 1 ? [[ONE_BY_ONE] as [string]] : []),
				[REJECT_ALL, "deny"],
				[REJECT_ALL_NOTE, "deny_note"],
			],
			identity,
		},
		signal,
	);
	if (!whole) return "cancelled";
	if (whole.label === APPLY_ALL) return new Map();
	if (whole.label === APPLY_SESSION) return "session";
	if (whole.label === REJECT_ALL) return all();
	if (whole.label === REJECT_ALL_NOTE) return all(whole.note);
	if (whole.label !== ONE_BY_ONE) return "cancelled";
	const rejected = new Map<number, string | undefined>();
	for (const [index, query] of queries.entries()) {
		const [, ...details] = describeChange(query);
		const decision = await decide(
			ctx,
			{
				question: `Change ${index + 1} of ${queries.length}`,
				targets: [raw(query)],
				preview: details.slice(0, -1).map((line) => line.replace(/^ {2}/, "")),
				says: [agentSays(query.reason)],
				reasonLines,
				choices: [
					[APPLY, "allow_once"],
					[REJECT, "deny"],
					[REJECT_NOTE, "deny_note"],
				],
				identity,
			},
			signal,
		);
		if (!decision) return "cancelled";
		if (decision.label === APPLY) continue;
		if (decision.label === REJECT) rejected.set(index, undefined);
		else if (decision.label === REJECT_NOTE) rejected.set(index, decision.note);
		else return "cancelled";
	}
	return rejected;
}
