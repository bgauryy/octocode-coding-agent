import { AgentToolExecutionError } from "@octocodeai/octocode-agent-core";
import type { TruncationResult } from "../truncate.ts";

/** Command facts and the bounded output, separate from human-readable status and hints. */
export interface BashToolDetails {
	output?: string;
	/** Host warnings and receipts, displayed separately from command output. */
	notices?: string[];
	exitCode?: number | null;
	termination?: "timeout" | "aborted" | "terminated";
	timeoutSeconds?: number;
	/** What was cut; the kept text itself is `output` (results written before this held it again as `content`). */
	truncation?: TruncationFacts;
	fullOutputPath?: string;
}

/** A truncation without the kept text, which a bash result already holds in `output` and its content. */
export type TruncationFacts = Omit<TruncationResult, "content">;

export function truncationFacts({ content: _content, ...facts }: TruncationResult): TruncationFacts {
	return facts;
}

/** Keeps direct callers' rejected promises while preserving facts for the agent and renderers. */
export class BashExecutionError extends AgentToolExecutionError<BashToolDetails> {
	readonly details: BashToolDetails;
	/** Formatted output before the host's failure status, used when a running process is adopted. */
	readonly outputText: string;
	constructor(message: string, details: BashToolDetails, outputText = details.output ?? "") {
		super(message, { content: [{ type: "text", text: message }], details, isError: true });
		this.name = "BashExecutionError";
		this.details = details;
		this.outputText = outputText;
	}
}
