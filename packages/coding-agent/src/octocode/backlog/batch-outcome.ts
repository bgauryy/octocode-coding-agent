import { AgentToolExecutionError } from "@octocodeai/octocode-agent-core";

export interface BatchOutcome {
	index: number;
	status: "applied" | "refused" | "unknown";
	text: string;
}

interface BatchAbortReceipt {
	status: "aborted";
	operation: "add" | "edit";
	requested: number;
	applied: number;
	refused: number;
	uncertain: number;
	notAttempted: number;
	outcomes: BatchOutcome[];
}

/** Committed entries cannot be rolled back by cancelling the remaining batch. Preserve their receipt for the loop. */
export class BacklogBatchAbortedError extends AgentToolExecutionError<BatchAbortReceipt> {
	constructor(operation: "add" | "edit", requested: number, outcomes: BatchOutcome[]) {
		const count = (status: BatchOutcome["status"]) => outcomes.filter((row) => row.status === status).length;
		const details: BatchAbortReceipt = {
			status: "aborted",
			operation,
			requested,
			outcomes,
			applied: count("applied"),
			refused: count("refused"),
			uncertain: count("unknown"),
			notAttempted: requested - outcomes.length,
		};
		const text = [
			`Cancelled ${operation} batch: ${details.applied} applied; ${details.refused} refused; ${details.uncertain} uncertain; ${details.notAttempted} not attempted.`,
			...outcomes.map((row) => `${row.index + 1}. ${row.text}`),
			"Earlier applied entries remain committed. Inspect the listed items before retrying; an uncertain entry may already have applied.",
		].join("\n");
		super(text, { content: [{ type: "text", text }], details, isError: true });
		this.name = "AbortError";
	}
}
