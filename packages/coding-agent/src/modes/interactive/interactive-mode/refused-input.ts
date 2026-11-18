/**
 * Slash input that no command accepts. Text that starts with `/` is often a message about a command ("/harness shows
 * only skills"), so a refusal never loses it: the text goes back to the editor with the reason, and pressing Enter again
 * on the same text sends it to the model as a message, with no command, skill or template expansion.
 */

import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { getApplicationPort } from "../../../core/application/index.ts";
import { prependToEditorDraft } from "./helpers.ts";
import type { InteractiveModeHost } from "./host.ts";

/** What refused input needs from the interactive mode; `refusedInput` builds it from the host. */
export interface RefusedInput {
	readonly editor: InteractiveModeHost["editor"];
	readonly session: InteractiveModeHost["session"];
	warn(text: string): void;
	error(text: string): void;
	flushPendingBashComponents(): void;
}

export function refusedInput(
	host: Pick<InteractiveModeHost, "editor" | "flushPendingBashComponents" | "session" | "showError" | "showWarning">,
): RefusedInput {
	return {
		get editor() {
			return host.editor;
		},
		get session() {
			return host.session;
		},
		warn: (text) => host.showWarning(text),
		error: (text) => host.showError(text),
		flushPendingBashComponents: () => host.flushPendingBashComponents(),
	};
}

const SEND_HINT = "Enter again sends it as a message.";

/** The refused text per interactive mode (keyed by its editor), armed until the next submit. */
const refused = new WeakMap<object, string>();

/** Put back text the app refused to submit: the editor's own draft when it can, with its paste markers and cursor. */
export function restoreRefused(editor: InteractiveModeHost["editor"], text: string): void {
	if (editor.restoreSubmitted) editor.restoreSubmitted(text);
	else editor.setText(text);
}

/** Put the text back in the editor and say why it was not submitted. */
export function refuseWith(input: RefusedInput, text: string, reason: string): void {
	restoreRefused(input.editor, text);
	input.warn(reason);
}

/**
 * The reason a command that declares its first words (`argumentWords`) refuses `args`: undefined when it declares none,
 * when `args` is empty or when the first word is one of them.
 */
export function argumentWordRefusal(
	name: string,
	args: string,
	words: readonly string[] | undefined,
): string | undefined {
	const first = args.trim().split(/\s+/, 1)[0];
	if (!words || !first || words.includes(first.toLowerCase())) return undefined;
	return `/${name} has no "${first}" option; /help ${name} shows its usage.`;
}

/**
 * Handles a submit that `reason` refuses. The first time, the text returns to the editor with the reason and a hint;
 * the same text submitted again is sent as a literal message. Any other submit disarms it (`clearRefused`).
 */
export async function handleRefused(input: RefusedInput, text: string, reason: string): Promise<void> {
	if (refused.get(input.editor) === text) {
		// Held compaction messages are sent later with command expansion, so a literal waits in the editor instead.
		if (input.session.isCompacting)
			return refuseWith(
				input,
				text,
				"Compaction is running: press Enter again after it finishes to send this as a message.",
			);
		refused.delete(input.editor);
		await sendAsMessage(input, text);
		return;
	}
	refused.set(input.editor, text);
	refuseWith(input, text, `${reason} ${SEND_HINT}`);
}

export function clearRefused(input: RefusedInput): void {
	refused.delete(input.editor);
}

async function sendAsMessage(input: RefusedInput, text: string): Promise<void> {
	const { editor, session } = input;
	editor.addToHistory?.(text);
	input.flushPendingBashComponents();
	let accepted = false;
	try {
		await getApplicationPort(session).invoke("prompt", text, {
			expandPromptTemplates: false,
			attachImagePaths: true,
			...(session.isStreaming ? { streamingBehavior: "steer" as const } : {}),
			preflightResult: () => {
				accepted = true;
			},
		});
	} catch (error) {
		if (!accepted) restoreRefused(editor, text);
		input.error(`${accepted ? "Message failed" : "Message was not sent; restored to editor"}: ${errorMessage(error)}`);
	}
}

/**
 * Sends the submitted prompt and waits for its run. When Esc stopped the run before the prompt reached the transcript
 * (while it was still preparing: compaction check, `before_agent_start`), nothing was recorded, so the text returns to
 * the editor, ahead of any new draft, and a warning says it was not sent. Slash commands are not prompts and are left alone.
 */
export async function submitPrompt(
	host: Pick<InteractiveModeHost, "editor" | "escapeAbortedRun" | "session" | "showWarning">,
	text: string,
): Promise<void> {
	const { session } = host;
	const before = session.messages.length;
	host.escapeAbortedRun = false;
	await getApplicationPort(session).invoke("prompt", text, { attachImagePaths: true });
	if (!host.escapeAbortedRun || text.trimStart().startsWith("/")) return;
	if (session.messages.slice(before).some((message) => message.role === "user")) return;
	prependToEditorDraft(host.editor, text);
	host.showWarning("Cancelled before it reached the model: the prompt is back in the editor");
}
