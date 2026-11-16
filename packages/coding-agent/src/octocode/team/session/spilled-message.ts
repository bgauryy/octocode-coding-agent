import { fenceUntrusted, headerText } from "../../shared/fence.ts";
import { USER_SENDER } from "../../shared/messages.ts";
import { MESSAGE_MAX_CHARS } from "../routing.ts";
import { saveMessageFile } from "../spill.ts";
import { cutText } from "@octocodeai/octocode-common/text";

/**
 * What goes to the readers of a message: `text` when it fits `MESSAGE_MAX_CHARS`; a longer one is saved whole to a
 * private file and delivered as its head plus the file's path, still within the limit so no reader cuts the pointer off.
 * `text` is already sanitized, and the file holds it the way the recipient's message would carry it: fenced as data from
 * `from` (the user's own words excepted), because the recipient reads the file with `read`, outside the message's fence.
 * The file is named by the hash of its content (`team/spill.ts`), so the signature of a user's message covers it. An error when the file cannot be written (nothing is sent rather than a message with a silent gap).
 */
export function spilledMessage(text: string, from: string): string | { error: string } {
	if (text.length <= MESSAGE_MAX_CHARS) return text;
	const file = saveMessageFile(
		from === USER_SENDER
			? text
			: fenceUntrusted(`Full message (${text.length} characters) from ${headerText(from, 64)}`, text),
	);
	if (!file)
		return {
			error: `Message is ${text.length} characters (the limit is ${MESSAGE_MAX_CHARS}) and could not be saved to a file. Send a summary. Nothing was sent.`,
		};
	const note = `\n[Full message (${text.length} characters): ${file}]`;
	return `${cutText(text, Math.max(0, MESSAGE_MAX_CHARS - note.length), { chars: true })}${note}`;
}
