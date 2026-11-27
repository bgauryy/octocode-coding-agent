import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AcpOutput } from "./output.ts";

/** One session update of the turn in flight, as it arrives: thoughts and other sessions' updates never reach it. */
export type AcpTurnUpdate = (update: SessionNotification["update"]) => void;

export interface Turn {
	controller: AbortController;
	/** SDK protocol cancellation is sent only after the host captures owned descendants. */
	protocolCancel: AbortController;
	signal: AbortSignal;
	output: AcpOutput;
	onUpdate?: AcpTurnUpdate;
}
