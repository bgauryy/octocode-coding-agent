/** Starting a run with input that waits in the agent's queues while no run is there to deliver it. */

import type { ImageContent, TextContent } from "@octocodeai/octocode-ai/compat";
import type { BeforeAgentStartTrigger } from "../features/runner.ts";
import { withInputOrigin } from "../input-origin.ts";
import type { SessionInternals } from "./host.ts";
import type { SessionInputQueue } from "./input-queue.ts";
import type { PendingUserInput } from "./types.ts";

export interface QueuedStartHost extends Pick<SessionInternals, "session"> {
	readonly inputs: SessionInputQueue;
	startRun(trigger: BeforeAgentStartTrigger, onStarted?: () => void, input?: PendingUserInput): Promise<void>;
}

/**
 * Start a run with the first queued message (steering before follow-ups); the agent loop delivers the rest of both queues
 * in order. The caller checked that no run is active, with no await since. Resolves when that run settles; nothing
 * starts when the queues are empty.
 */
export async function startQueuedInput(host: QueuedStartHost): Promise<void> {
	const { session, inputs } = host;
	const next = session.agent.peekQueuedMessages()[0];
	if (!next) return;
	session.agent.removeQueuedMessage(next);
	const sentFrom = inputs.consumeQueuedUserMessage(next);
	if (next.role !== "user") {
		if (next.role !== "custom") return;
		await host.startRun({ messageType: "custom", message: next });
		return;
	}
	const { text, images } = splitUserContent(next.content);
	const input = inputs.getUserInput(next);
	// The run this starts is the queued message's: it carries the origin the message was sent from.
	const start = () =>
		host.startRun(
			{ messageType: "user", prompt: text, images },
			undefined,
			input ? { ...input, origin: "queued" } : { text, images, source: "interactive", origin: "queued" },
		);
	await (sentFrom ? withInputOrigin(sentFrom, start) : start());
}

export function splitUserContent(content: string | (TextContent | ImageContent)[]): {
	text: string;
	images: ImageContent[] | undefined;
} {
	if (typeof content === "string") return { text: content, images: undefined };
	const textParts: string[] = [];
	let images: ImageContent[] | undefined = [];
	for (const part of content) {
		if (part.type === "text") {
			textParts.push(part.text);
		} else {
			images.push(part);
		}
	}
	if (images.length === 0) images = undefined;
	return { text: textParts.join("\n"), images };
}
