import type { CancelReason, Question, Reply } from "@octocodeai/octocode-contracts";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "../../core/features/types.ts";
import { SUBMIT_PICKS } from "./dialog/answers.ts";
import { type AskOptions, plainTitle } from "./question.ts";

/** What a host that shows an approval its own way returns: the label of the option picked, and the note typed in its write-in. */
interface ApprovalPick {
	label: string;
	note?: string;
}

/**
 * The dialogs a host without `ask` has: one select, input or confirm at a time. A host that draws an approval as more
 * than a select (the terminal's card, an RPC client's permission request) adds `approve`; without it an approval is a
 * plain select over its labels.
 */
export type DialogUi = Pick<ExtensionUIContext, "select" | "input" | "confirm"> & {
	approve?(question: Question, dialog: ExtensionUIDialogOptions): Promise<ApprovalPick | undefined>;
};

/**
 * Questions asked as plain `select`, `input` and `confirm` dialogs, one after another, for a host that cannot draw them
 * together (an RPC client without `ask`): numbered choices (identities that tell duplicate labels and labels named after
 * UI actions apart), a multi question as repeated picks until "Submit selection", the write-in as a last row that opens an
 * input, an empty typed answer asked again. The first dismissed dialog cancels its question and every later one.
 */
export async function degrade(ui: DialogUi, questions: readonly Question[], opts: AskOptions = {}): Promise<Reply[]> {
	const { signal } = opts;
	const started = Date.now();
	const dialog: ExtensionUIDialogOptions = {
		...(signal ? { signal } : {}),
		...(opts.blocking ? { blocking: true } : {}),
		...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
	};
	/** Why a dialog came back empty: the turn was interrupted, the timeout ran out, or the person dismissed it. */
	const why = (): CancelReason =>
		signal?.aborted
			? "aborted"
			: opts.timeout !== undefined && Date.now() - started >= opts.timeout
				? "timeout"
				: "declined";

	const replies: Reply[] = [];
	for (const question of questions) {
		const reply = signal?.aborted
			? ({ id: question.id, cancelled: "aborted" } as const)
			: await askOne(ui, question, dialog, why);
		replies.push(reply);
		if ("cancelled" in reply) {
			const rest = questions.slice(replies.length);
			return [...replies, ...rest.map((q): Reply => ({ id: q.id, cancelled: reply.cancelled }))];
		}
	}
	return replies;
}

/** Free text, asked again while the answer is empty; undefined when dismissed. */
async function typed(
	ui: DialogUi,
	title: string,
	placeholder: string | undefined,
	dialog: ExtensionUIDialogOptions,
	interrupted: () => boolean,
): Promise<string | undefined> {
	for (;;) {
		const answer = (await ui.input(sanitizeTerminalText(title), placeholder, dialog))?.trim();
		if (interrupted() || answer === undefined) return undefined;
		if (answer) return answer;
	}
}

async function askOne(
	ui: DialogUi,
	q: Question,
	dialog: ExtensionUIDialogOptions,
	why: () => CancelReason,
): Promise<Reply> {
	const cancelled = (): Reply => ({ id: q.id, cancelled: why() });
	const interrupted = (): boolean => dialog.signal?.aborted === true;
	const writeIn = q.writeIn ? q.writeIn : undefined;

	if (q.type === "text") {
		const answer = await typed(ui, q.question, writeIn?.placeholder, dialog, interrupted);
		return answer === undefined ? cancelled() : { id: q.id, picks: [], text: answer };
	}

	if (q.type === "confirm") {
		const yes = await ui.confirm(sanitizeTerminalText(q.question), sanitizeTerminalText(q.body?.text ?? ""), dialog);
		if (interrupted()) return cancelled();
		const option = q.options?.find((o) => o.role === (yes ? "yes" : "no"));
		return option ? { id: q.id, picks: [option.id] } : cancelled();
	}

	const options = q.options ?? [];
	if (q.type === "approval") return askApproval(ui, q, dialog, why, interrupted);

	// Numbered labels; the write-in and the submit row keep their own words.
	const labels = options.map((option, index) =>
		sanitizeTerminalText(`${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`),
	);
	const multi = q.type === "multi";
	const chosen = new Set<number>();
	let text: string | undefined;
	for (;;) {
		const open = options.flatMap((_, index) => (chosen.has(index) ? [] : [index]));
		const extra = [...(multi && chosen.size > 0 ? [SUBMIT_PICKS] : []), ...(writeIn ? [writeIn.label] : [])];
		const selected = [...chosen].map((index) => options[index].label).join(", ");
		const title = multi
			? `${q.question} (choose one or more, then ${SUBMIT_PICKS}${selected ? `; selected: ${selected}` : ""})`
			: q.question;
		const rows = [...open.map((index) => labels[index]), ...extra];
		const picked = await ui.select(sanitizeTerminalText(title), rows, dialog);
		if (interrupted() || picked === undefined) return cancelled();
		if (writeIn && picked === writeIn.label) {
			// An empty answer is no answer, as in the TUI dialog.
			const note = (await ui.input(sanitizeTerminalText(q.question), undefined, dialog))?.trim();
			if (interrupted()) return cancelled();
			if (!note) continue;
			text = note;
			break;
		}
		if (picked === SUBMIT_PICKS) break;
		const index = labels.indexOf(picked);
		if (index < 0 || chosen.has(index)) return cancelled();
		chosen.add(index);
		if (!multi || chosen.size === labels.length) break;
	}
	const picks = options.flatMap((option, index) => (chosen.has(index) ? [option.id] : []));
	return { id: q.id, picks, ...(text !== undefined ? { text } : {}) };
}

/**
 * A permission prompt: the host's own `approve` when it has one, else one select over its labels. "Deny with a note" asks
 * the note next unless the host already took it. A reply that is none of the offered labels decides nothing: the question
 * is cancelled.
 */
async function askApproval(
	ui: DialogUi,
	q: Question,
	dialog: ExtensionUIDialogOptions,
	why: () => CancelReason,
	interrupted: () => boolean,
): Promise<Reply> {
	const options = q.options ?? [];
	const picked: ApprovalPick | undefined = ui.approve
		? await ui.approve(q, dialog)
		: await ui
				.select(
					plainTitle(q),
					options.map((option) => option.label),
					dialog,
				)
				.then((label) => (label === undefined ? undefined : { label }));
	const option = picked === undefined ? undefined : options.find((o) => o.label === picked.label);
	if (interrupted() || !picked || !option) return { id: q.id, cancelled: why() };
	if (option.role !== "deny_note") return { id: q.id, picks: [option.id] };
	const note =
		picked.note ??
		(await ui.input(
			sanitizeTerminalText(q.writeIn ? q.writeIn.title : ""),
			q.writeIn ? q.writeIn.placeholder : undefined,
			dialog,
		));
	return note === undefined || interrupted()
		? { id: q.id, cancelled: why() }
		: { id: q.id, picks: [option.id], text: note.trim() };
}
