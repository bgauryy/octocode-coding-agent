import type { AgentSession, PromptDisposition } from "../../../core/agent-session.ts";
import {
	completeSessionDispatch,
	hasSessionDispatch,
	PromptDispatchCancelled,
} from "../../../core/agent-session/dispatch.ts";
import { AuthRequiredError } from "../../../core/auth-guidance.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { createRunOutcome, type RunOutcome } from "../../../core/agent-session/run-outcome.ts";
import type { RpcCommand } from "../rpc-types.ts";
import { error, success } from "./responses.ts";
import type { RpcOutput } from "./ui-context.ts";

/** Ordinary RPC clients get acceptance; completion-aware clients also await feature-dispatched work. */
export function handlePrompt(
	session: AgentSession,
	command: Extract<RpcCommand, { type: "prompt" }>,
	output: RpcOutput,
): void {
	if (command.waitForCompletion && (hasSessionDispatch(session) || !session.isIdle)) {
		output({ ...error(command.id, "prompt", "Session is busy; nothing was sent."), execution: "not-sent" });
		return;
	}
	let disposition: PromptDisposition | undefined;
	// A command that failed answers as a refused prompt does: its `extension_error` event alone reads as success to a driver.
	let commandFailure: string | undefined;
	const send = () =>
		session.prompt(command.message, {
			images: command.images,
			streamingBehavior: command.streamingBehavior,
			source: "rpc",
			preflightResult: (result, failure) => {
				disposition = result;
				commandFailure = failure;
				if (!command.waitForCompletion)
					output(failure ? error(command.id, "prompt", failure) : success(command.id, "prompt", { disposition }));
			},
		});
	const sending = command.waitForCompletion ? completeSessionDispatch(session, send, command.dispatchId) : send();
	void sending.then(
		() => {
			if (command.waitForCompletion)
				output(
					commandFailure
						? error(command.id, "prompt", commandFailure)
						: success(command.id, "prompt", { disposition: disposition ?? "handled", outcome: session.lastRunOutcome }),
				);
		},
		(failure: unknown) => {
			// An abort is a run outcome, not a failed command: answer it as the settled run did.
			if (command.waitForCompletion && failure instanceof PromptDispatchCancelled) {
				output(
					success(command.id, "prompt", {
						disposition: disposition ?? "handled",
						outcome: abortedOutcome(session.lastRunOutcome),
					}),
				);
				return;
			}
			if (command.waitForCompletion || disposition === undefined)
				output({
					...error(command.id, "prompt", errorMessage(failure)),
					...(failure instanceof AuthRequiredError ? { authRequired: true } : {}),
				});
			// The acceptance was already answered, so this is the driver's only sign of the failure.
			else output({ type: "run_error", id: command.id, error: errorMessage(failure) });
		},
	);
}

/** The settled run's outcome when it was aborted; an abort before any run started has none, so it reports a bare one. */
function abortedOutcome(last: RunOutcome | undefined): RunOutcome {
	return last?.status === "aborted" ? last : { ...createRunOutcome(), status: "aborted" };
}
