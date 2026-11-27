import { randomUUID } from "node:crypto";
import type { PromptResponse } from "@agentclientprotocol/sdk";
import { AcpEventProjector, type CompactionText } from "./events.ts";

/** One prompt turn of a session: the client's, or one the worker began on its own (a wake, a queued follow-up). */
export interface Turn {
	id: string;
	controller: AbortController;
	projector: AcpEventProjector;
	accepted: boolean;
	settled: boolean;
	cancelled: boolean;
	ending: boolean;
	done: Promise<PromptResponse>;
	resolve: (value: PromptResponse) => void;
	reject: (error: Error) => void;
}

/** A turn whose `done` never rejects unobserved: the session settles it, and only a client prompt awaits it. */
export function createTurn(summaryText: CompactionText): Turn {
	const completion = Promise.withResolvers<PromptResponse>();
	void completion.promise.catch(() => {});
	return {
		...completion,
		id: randomUUID(),
		done: completion.promise,
		controller: new AbortController(),
		projector: new AcpEventProjector(summaryText),
		accepted: false,
		settled: false,
		cancelled: false,
		ending: false,
	};
}
