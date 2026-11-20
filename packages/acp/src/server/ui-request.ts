import type { AgentContext } from "@agentclientprotocol/sdk";
import type { AcpUiRequest, AcpUiResponse } from "../host.ts";
import { askClient } from "./ask.ts";
import { reportFailure } from "./failure.ts";
import { askPermission } from "./permission.ts";

/** What answering one worker dialog needs from the session that received it. */
export interface UiRequestScope {
	client: AgentContext;
	sessionId: string;
	/** The client advertised `elicitation.form`, so non-approval questions can be asked (`ask.ts`). */
	elicitationForm: boolean;
	/** The abort of the turn the dialog belongs to; undefined with no turn, and then nobody is asked. */
	signal: AbortSignal | undefined;
	/** Settles once the updates queued so far reached the client. */
	output: Promise<void>;
	/** Whether the turn the dialog belongs to is still the session's. */
	current: () => boolean;
	/** Stops the session's turn. Never awaited here: the worker's dialog waits for this answer. */
	cancel: () => Promise<void>;
	/** Sends the answer to the worker, unless the session ended meanwhile. */
	respond: (response: AcpUiResponse) => Promise<void>;
}

/**
 * Answers one dialog the worker raised: a batch of questions through `ask.ts`, a permission `select` through
 * `permission.ts`; any other dialog is cancelled. The host forwards only dialogs; a UI notification (status, widget,
 * title) has no one to answer it and is dropped.
 */
export async function answerUiRequest(request: AcpUiRequest, scope: UiRequestScope): Promise<void> {
	if (!["select", "confirm", "input", "editor", "ask"].includes(request.method)) return;
	// Send abort before releasing the worker's dialog; awaiting completion here would deadlock it.
	const onCancelled = () => void scope.cancel().catch(reportFailure("ACP permission cancellation failed"));
	if (request.method === "ask") {
		const env = {
			client: scope.client,
			sessionId: scope.sessionId,
			// No turn to answer for: every question is aborted (a closed signal).
			signal: scope.signal ?? AbortSignal.abort(),
			elicitationForm: scope.elicitationForm,
			onCancelled,
		};
		const replies = await askClient(env, request.questions);
		await scope.respond({ type: "extension_ui_response", id: request.id, replies });
		return;
	}
	const value =
		request.method === "select"
			? await askPermission(
					{
						client: scope.client,
						sessionId: scope.sessionId,
						signal: scope.signal,
						output: scope.output,
						current: scope.current,
						onCancelled,
					},
					request,
				)
			: undefined;
	await scope.respond({
		type: "extension_ui_response",
		id: request.id,
		...(value === undefined ? { cancelled: true } : { value }),
	});
}
