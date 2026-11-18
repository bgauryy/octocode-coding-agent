export interface MessageEnvelope {
	channel: "internal" | "external";
	direction: "outbound" | "inbound";
	from: string;
	to: string;
	text: string;
	id?: string;
	replyTo?: string;
	/** The message asks for an answer; set when known (a send, or a received message that carries it). */
	replyRequired?: boolean;
	/** The message may start an idle recipient's turn; set when known. */
	wake?: boolean;
	/** The message stops the recipient's current step; set when known. */
	interrupt?: boolean;
}
export const INTERNAL_MESSAGE_TYPE = "octocode-agent-message";
export const EXTERNAL_MESSAGE_TYPE = "octocode-external-message";
/** The custom message a background bash job sends its session when it ends (`native/tools/bash/tool.ts`); subagent reports read it too. */
export const JOB_TYPE = "octocode-bash-job";
/** The custom message a timer sends its session when it fires (`timer/register.ts`). */
export const TIMER_TYPE = "octocode-timer";
/** The custom message type of a background subagent's report (`subagents/handoff.ts`). */
export const AGENT_RESULT_TYPE = "octocode-agent-result";
/** The custom message that carries coordination-graph notices no waking report carried (`subagents/graph-wake.ts`). */
export const GRAPH_NOTICE_TYPE = "octocode-graph-notice";
/** Sender id for messages typed by the user with `/agents tell`. */
export const USER_SENDER = "user";
/** Sender id for messages from a local API client (`agents.tell`): not the user, and nobody to reply to. */
export const EXTERNAL_SENDER = "external";
