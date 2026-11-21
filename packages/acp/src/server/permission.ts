import { randomUUID } from "node:crypto";
import { type AgentContext, methods } from "@agentclientprotocol/sdk";
import type { AcpUiRequest } from "../host.ts";
import { withAbort } from "./abort.ts";
import { toolKind } from "./events.ts";
import { reportFailure } from "./failure.ts";

/**
 * A worker's tool approval (a `select` dialog that names its allow and reject options) as a `session/request_permission`.
 * Anything else a client could answer wrongly is refused here: a dialog without those two options, a turn that already
 * ended, a cancelled or invalid answer, or a failing client never grant permission.
 */

/** A `select` dialog of the worker's permission gate. */
export type SelectRequest = Extract<AcpUiRequest, { method: "select" }>;

/** Who is asked, and the turn whose end stops the wait. */
export interface PermissionEnvironment {
	client: AgentContext;
	sessionId: string;
	/** The abort of the turn that raised the request; undefined when no turn is running (nobody is asked). */
	signal: AbortSignal | undefined;
	/** Settles once the updates queued so far reached the client, so the request follows the tool call it asks about. */
	output: Promise<void>;
	/** Whether the turn that raised the request is still the session's turn when the client answers. */
	current: () => boolean;
	/** The person dismissed the request (the protocol's `cancelled` outcome): the turn must stop before the worker's dialog is released. */
	onCancelled: () => void;
}

/** The option text the client chose (the request's `allowOnce` or `rejectOnce`), or undefined: the dialog is then cancelled. */
export async function askPermission(env: PermissionEnvironment, request: SelectRequest): Promise<string | undefined> {
	const { permission } = request;
	const { signal } = env;
	if (
		!signal ||
		signal.aborted ||
		!permission ||
		permission.allowOnce === permission.rejectOnce ||
		!request.options.includes(permission.allowOnce) ||
		!request.options.includes(permission.rejectOnce)
	)
		return undefined;
	try {
		await env.output;
		signal.throwIfAborted();
		const response = await withAbort(
			signal,
			env.client.request(
				methods.client.session.requestPermission,
				{
					sessionId: env.sessionId,
					toolCall: {
						toolCallId: permission.toolCallId ?? randomUUID(),
						title: request.title,
						status: "pending",
						kind: permission.toolName ? toolKind(permission.toolName) : "other",
						name: permission.toolName,
						content: [{ type: "content", content: { type: "text", text: permission.targets.join("\n") } }],
					},
					options: [
						{ optionId: "allow-once", name: permission.allowOnce, kind: "allow_once" },
						{ optionId: "reject-once", name: permission.rejectOnce, kind: "reject_once" },
					],
				},
				{ cancellationSignal: signal },
			),
		);
		if (!env.current() || signal.aborted) return undefined;
		if (response.outcome.outcome === "cancelled") env.onCancelled();
		else if (response.outcome.optionId === "allow-once") return permission.allowOnce;
		else if (response.outcome.optionId === "reject-once") return permission.rejectOnce;
	} catch (error) {
		// Cancellation, invalid options and client failures never grant permission. An abort is expected; log the rest.
		if (!signal.aborted) reportFailure("ACP permission request failed; permission denied")(error);
	}
	return undefined;
}
