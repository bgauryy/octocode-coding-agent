import type { ApplicationAwaiting } from "@octocodeai/octocode-contracts";
import { getApplicationPortForSession } from "../../core/application/index.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { redactSecrets } from "../../../../common/src/sanitize.ts";
import { clipText, firstLine } from "../shared/util.ts";
import { promptTitle } from "../shared/locks.ts";

/**
 * What a dialog asks, for the browser: a confirmation and a dialog opened with the `approval` option (every permission
 * prompt) are approvals; a choice, an input or a custom dialog is a question. With the dialog's `id` (the broker's), its
 * options and whether it takes text, a client can answer it with the `answer` command; an editor or custom dialog
 * carries no id and stays terminal-only.
 */
export function awaitingFor(event: {
	kind: string;
	title?: string;
	id?: string;
	options?: string[];
	allowsText?: boolean;
	approval?: boolean;
}): ApplicationAwaiting {
	const title = promptTitle(event);
	const answerable = event.id !== undefined && ["select", "confirm", "input"].includes(event.kind);
	return {
		kind: event.kind === "confirm" || event.approval ? "approval" : "question",
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

interface OpenDialog {
	/** The broker's id of the dialog (`ui_prompt_start.id`), which `ui_prompt_end` repeats. */
	id: string | undefined;
	awaiting: ApplicationAwaiting;
	/** The dialog stays a wait when the run settles (a subagent's dialog, relayed to this session). */
	blocking: boolean;
}

/**
 * Tell the application snapshot that the session is blocked on a dialog, so the browser shows "waiting for you" instead
 * of the last tool or "Thinking", and can answer it when the dialog carries an id. Dialogs the user opens while no run is
 * active (a `/permissions` picker) are not waits and are not reported; dialogs opened as `blocking` (a background
 * subagent's approval, relayed to this session) are, idle or not, and outlive the run's end. Nested dialogs (an input over
 * a select) are reported too, so the client always sees the dialog that is actually open. Open dialogs are tracked by
 * the broker's id: a close removes its own dialog, whatever order dialogs close in.
 */
export function registerAwaiting(api: ExtensionAPI): void {
	const publish = (ctx: ExtensionContext, awaiting?: ApplicationAwaiting) =>
		getApplicationPortForSession(ctx.sessionManager.getSessionId())?.publishDomain({
			type: "session.awaiting",
			...(awaiting ? { awaiting } : {}),
		});
	// Dialogs can stack (an approval over a question); the newest open one is shown until all close.
	let open: OpenDialog[] = [];
	api.on("session_start", async () => {
		open = [];
	});
	api.on("ui_prompt_start", async (event, ctx) => {
		const blocking = event.blocking === true;
		if (ctx.isIdle() && !blocking) return;
		const awaiting = awaitingFor(event);
		open.push({ id: event.id, awaiting, blocking });
		publish(ctx, awaiting);
	});
	api.on("ui_prompt_end", async (event, ctx) => {
		const index = open.findIndex((dialog) => dialog.id === event.id);
		if (index < 0) return;
		open.splice(index, 1);
		publish(ctx, open.at(-1)?.awaiting);
	});
	// /new or /resume replaces the session and disposes its application service: tell the page the dialog is gone first.
	api.on("session_shutdown", async (_event, ctx) => {
		if (open.length === 0) return;
		open = [];
		try {
			publish(ctx);
		} catch {
			// The service is already closed; the session is gone with its snapshot.
		}
	});
	// The run is over: what it waited on is not a wait any more, but a relayed subagent dialog still is.
	api.on("agent_settled", async (_event, ctx) => {
		const kept = open.filter((dialog) => dialog.blocking);
		if (kept.length === open.length) return;
		open = kept;
		publish(ctx, open.at(-1)?.awaiting);
	});
}
