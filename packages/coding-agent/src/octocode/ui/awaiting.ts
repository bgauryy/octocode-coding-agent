import type { ApplicationAwaiting } from "@octocodeai/octocode-contacts";
import { getApplicationPortForSession } from "../../core/application/index.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/index.ts";
import { redactSecrets } from "../shared/sanitize.ts";
import { clipText, firstLine } from "../shared/util.ts";
import { promptTitle } from "../shared/locks.ts";

/**
 * What a dialog asks, for the browser: a confirmation is an approval; a choice, an input or a custom dialog is a
 * question. With the dialog's `id` (the broker's), its options and whether it takes text, a client can answer it with
 * the `answer` command; an editor or custom dialog carries no id and stays terminal-only.
 */
export function awaitingFor(event: {
	kind: string;
	title?: string;
	id?: string;
	options?: string[];
	allowsText?: boolean;
}): ApplicationAwaiting {
	const title = promptTitle(event);
	const answerable = event.id !== undefined && ["select", "confirm", "input"].includes(event.kind);
	return {
		kind: event.kind === "confirm" ? "approval" : "question",
		...(title ? { title: clipText(redactSecrets(firstLine(title)), 200) } : {}),
		...(answerable
			? {
					id: event.id,
					options: (event.options ?? []).slice(0, 50).map((option) => clipText(redactSecrets(option), 200)),
					allowsText: event.allowsText === true,
				}
			: {}),
	};
}

/**
 * Tell the application snapshot that the run is blocked on a dialog, so the browser shows "waiting for you" instead of
 * the last tool or "Thinking", and can answer it when the dialog carries an id. Dialogs the user opens while no run is
 * active (a `/permissions` picker) are not waits and are not reported. Nested dialogs (an input over a select) are
 * reported too, so the client always sees the dialog that is actually open.
 */
export function registerAwaiting(api: ExtensionAPI): void {
	const publish = (ctx: ExtensionContext, awaiting?: ApplicationAwaiting) =>
		getApplicationPortForSession(ctx.sessionManager.getSessionId())?.publishDomain({
			type: "session.awaiting",
			...(awaiting ? { awaiting } : {}),
		});
	// Dialogs can stack (an approval over a question); the newest open one is shown until all close.
	let open: ApplicationAwaiting[] = [];
	api.on("session_start", async () => {
		open = [];
	});
	api.on("ui_prompt_start", async (event, ctx) => {
		if (ctx.isIdle()) return;
		const awaiting = awaitingFor(event);
		open.push(awaiting);
		publish(ctx, awaiting);
	});
	api.on("ui_prompt_end", async (_event, ctx) => {
		if (open.length === 0) return;
		open.pop();
		publish(ctx, open.at(-1));
	});
}
