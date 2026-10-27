/**
 * A model response that fails or is aborted ends the turn before its tool calls run. Their rows say so: a failure reads
 * as not run (the message shows the provider error once), and an abort keeps its abort text.
 */
export const TOOL_NOT_RUN = "Not run: the model response failed";

/** The result text for the tool rows of a response that stopped before its tools ran; undefined when it did not stop. */
export function stoppedToolText(stopReason: string | undefined, retryAttempt: number): string | undefined {
	if (stopReason === "error") return TOOL_NOT_RUN;
	if (stopReason !== "aborted") return undefined;
	return retryAttempt > 0
		? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
		: "Operation aborted";
}

let toolInterrupted = false;

/** Whether a tool of the current run ended under an interrupt: its row already says `aborted`. */
export function toolInterruptShown(): boolean {
	return toolInterrupted;
}

/** Record that a tool ended under an interrupt (`true`), or that a new run began (`false`). */
export function setToolInterruptShown(shown: boolean): void {
	toolInterrupted = shown;
}
