import type { Question } from "@octocodeai/octocode-contracts";
import type { DialogOptions, SessionUI } from "../../core/features/types.ts";
import { showAskDialog } from "./dialog.ts";

/** What a confirmation needs from the host: the terminal's custom-component slot. */
export type ConfirmHost = { ui: Pick<SessionUI, "custom"> };

/**
 * A yes/no confirmation as one choice question of the tabbed ask dialog: `title` is the question, `message` its body, No
 * is listed first so Enter and a click never confirm by accident. There is no write-in row and no typing: a confirmation
 * answers yes or no only.
 */
function confirmQuestion(title: string, message: string): Question {
	return {
		id: "confirm",
		type: "confirm",
		question: title,
		...(message.trim() ? { body: { text: message } } : {}),
		options: [
			{ id: "no", label: "No", role: "no" },
			{ id: "yes", label: "Yes", role: "yes" },
		],
	};
}

/**
 * Ask a confirmation in the ask dialog and resolve true only for Yes. A dismissal, an abort of `signal` and the end of
 * `timeout` (milliseconds, counted down on the card as `auto: No in Ns`, running whatever the person presses) answer
 * false. `onClose` runs once the dialog is gone, on every path, before anything that takes its place can open.
 */
export async function confirmInAsk(
	host: ConfirmHost,
	title: string,
	message: string,
	opts: DialogOptions = {},
	onClose?: () => void,
): Promise<boolean> {
	if (opts.signal?.aborted) return false;
	const expiry =
		opts.timeout && opts.timeout > 0 ? { seconds: Math.ceil(opts.timeout / 1000), label: "No" } : undefined;
	const [reply] = await showAskDialog(host, [confirmQuestion(title, message)], opts.signal, onClose, expiry);
	return reply !== undefined && "picks" in reply && reply.picks.includes("yes");
}
