/** Sending user and custom messages to a session: start a run, queue into the current one, or append. */

import type { ImageContent, TextContent } from "@octocodeai/octocode-ai/compat";
import {
	AuthRequiredError,
	formatAuthExpiredMessage,
	formatNoApiKeyFoundMessage,
	formatNoModelSelectedMessage,
} from "../auth-guidance.ts";
import type { CustomMessage } from "../messages.ts";
import type { SessionCompaction } from "./compaction-control.ts";
import type { SessionInternals } from "./host.ts";
import type { SessionInputQueue } from "./input-queue.ts";
import { attachPromptPathImages, type PathImagesHost } from "./prompt-image-paths.ts";
import {
	expandSkillInput,
	runInputHandlers,
	throwIfExtensionCommand,
	tryExecuteExtensionCommand,
} from "./prompt-expansion.ts";
import type { SessionRunLoop } from "./run-loop.ts";
import type { PendingUserInput, PromptOptions, QueuedInputDisposition, QueuedInputOptions } from "./types.ts";
import { checkSessionDispatch, hasSessionDispatch } from "./dispatch.ts";

export interface PromptingHost
	extends Pick<SessionInternals, "session" | "run" | "cwd">, Pick<PathImagesHost, "limitsModel"> {
	readonly inputs: SessionInputQueue;
	readonly compaction: SessionCompaction;
	readonly runLoop: SessionRunLoop;
}

export async function prompt(host: PromptingHost, text: string, options?: PromptOptions): Promise<void> {
	const { session, run } = host;
	checkSessionDispatch(session);
	if (run.isEmittingAgentSettled) {
		run.deferredSettledActions.push(async () => session.prompt(text, options));
		return;
	}
	const expandPromptTemplates = options?.expandPromptTemplates ?? true;
	const preflightResult = options?.preflightResult;
	// Handle extension commands first (execute immediately, even during streaming)
	// Extension commands manage their own LLM interaction via api.sendMessage()
	if (expandPromptTemplates && text.startsWith("/")) {
		let commandFailure: string | undefined;
		const handled = await tryExecuteExtensionCommand(session.extensionRunner, text, (message) => {
			commandFailure = message;
		});
		if (handled) {
			// Extension command executed, no prompt to send
			preflightResult?.("handled", commandFailure);
			return;
		}
	}

	// Manual compaction runs with no agent run, but its summary must not race a turn: input waits in the queues an
	// automatic compaction uses and is delivered by `releaseHeldInput` once the compaction ends.
	const holding = session.isStreaming || host.compaction.isManualRunning;
	const behavior = options?.streamingBehavior ?? (host.compaction.isManualRunning ? "followUp" : undefined);

	// Emit input event for extension interception (before skill/template expansion)
	const processedInput = await runInputHandlers(
		session.extensionRunner,
		text,
		options?.images,
		options?.source ?? "interactive",
		holding ? behavior : undefined,
	);
	checkSessionDispatch(session);
	if (!processedInput) {
		preflightResult?.("handled");
		return;
	}
	const { text: currentText, images: currentImages } = processedInput;

	// Expand skill commands (/skill:name args) and prompt templates (/template args)
	let expandedText = currentText;
	let expandedPaths: Set<string> | undefined;
	if (expandPromptTemplates) {
		({ text: expandedText, expandedPaths } = expandSkillInput(host, expandedText));
	}

	// Image paths in typed text attach as images; a skill or template command line is not scanned.
	const attachImagePaths = options?.attachImagePaths === true && expandedText === currentText;
	const input: PendingUserInput = {
		text: currentText,
		images: currentImages,
		source: options?.source ?? "interactive",
		expandedPaths,
	};
	// If streaming, queue via steer() or followUp() based on option
	if (holding) {
		if (!behavior) {
			throw new Error(
				"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
			);
		}
		const queued = attachImagePaths
			? await attachPromptPathImages(host, expandedText, currentImages, true)
			: { text: expandedText, images: currentImages };
		checkSessionDispatch(session);
		await host.inputs.queue(behavior === "followUp" ? "followUp" : "steer", queued.text, queued.images, {
			...input,
			images: queued.images,
		});
		preflightResult?.("queued");
		return;
	}

	// Validate model
	if (!session.model) {
		throw new AuthRequiredError(formatNoModelSelectedMessage());
	}

	const hasConfiguredAuth =
		session.modelRuntime.hasConfiguredAuth(session.model.provider) ||
		(await session.modelRuntime.checkAuth(session.model.provider)) !== undefined;
	checkSessionDispatch(session);
	if (!hasConfiguredAuth) {
		const isOAuth = session.modelRuntime.isUsingOAuth(session.model.provider);
		if (isOAuth) {
			throw new AuthRequiredError(formatAuthExpiredMessage(session.model.provider));
		}
		throw new AuthRequiredError(formatNoApiKeyFoundMessage(session.model.provider));
	}

	const started = attachImagePaths
		? await attachPromptPathImages(host, expandedText, currentImages, false)
		: { text: expandedText, images: currentImages };
	checkSessionDispatch(session);
	await host.runLoop.startRun(
		{ messageType: "user", prompt: started.text, images: started.images },
		() => preflightResult?.("started"),
		{ ...input, images: started.images },
	);
}

export async function queueUserInput(
	host: PromptingHost,
	text: string,
	images: ImageContent[] | undefined,
	behavior: "steer" | "followUp",
	options?: QueuedInputOptions,
): Promise<QueuedInputDisposition> {
	const { session } = host;
	const source = options?.source ?? "interactive";
	if (text.startsWith("/")) {
		throwIfExtensionCommand(session.extensionRunner, text);
	}

	const processedInput = await runInputHandlers(
		session.extensionRunner,
		text,
		images,
		source,
		session.isStreaming ? behavior : undefined,
	);
	if (!processedInput) return "handled";

	const { text: expandedText, expandedPaths } = expandSkillInput(host, processedInput.text);

	const queued =
		options?.attachImagePaths === true && expandedText === processedInput.text
			? await attachPromptPathImages(host, expandedText, processedInput.images, true)
			: { text: expandedText, images: processedInput.images };
	const input: PendingUserInput = { text: processedInput.text, images: queued.images, source, expandedPaths };
	await host.inputs.queue(behavior, queued.text, queued.images, input);
	return "queued";
}

export async function sendCustomMessage<T = unknown>(
	host: PromptingHost,
	message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
	options?: {
		triggerTurn?: boolean;
		deliverAs?: "steer" | "followUp" | "nextTurn";
		together?: boolean;
	},
): Promise<void> {
	const { session, run } = host;
	const appMessage = {
		role: "custom" as const,
		customType: message.customType,
		// Untyped extensions can pass null/missing content; normalize at ingestion.
		content: message.content ?? [],
		display: message.display,
		details: message.details,
		timestamp: Date.now(),
	} satisfies CustomMessage<T>;
	const holding = session.isStreaming || host.compaction.isManualRunning;
	if (options?.deliverAs === "nextTurn") {
		host.inputs.addNextTurnMessage(appMessage);
	} else if (holding && options?.triggerTurn !== false) {
		host.inputs.noteQueuedCustomMessage(appMessage);
		if (options?.deliverAs === "followUp") {
			session.agent.followUp(appMessage, { together: options.together });
		} else {
			session.agent.steer(appMessage);
			host.inputs.noteSteeredCustomMessage(appMessage);
		}
	} else if (options?.triggerTurn) {
		if (run.isEmittingAgentSettled) {
			run.deferredSettledActions.push(async () => session.sendCustomMessage(message, options));
			return;
		}
		await host.runLoop.startRun({ messageType: "custom", message: appMessage });
	} else if (holding) {
		// Appending now would put the message between an assistant tool call and its
		// result, which providers that validate message order reject on replay. Defer
		// to the end of the turn. Nothing is emitted yet: message events must not
		// describe messages the session tree does not contain.
		host.inputs.addPendingCustomMessage(appMessage);
	} else {
		host.inputs.appendCustomMessage(appMessage);
	}
}

/**
 * A manual compaction ended (saved, failed or cancelled): deliver what waited for it. One run starts with the first queued
 * message (steering before follow-ups); the agent loop delivers the rest of both queues in order. Held custom messages with
 * nothing queued are written now, behind the compaction entry. Nothing starts when a run or another submission is already
 * under way: the queues are drained by it.
 */
export async function releaseHeldInput(host: PromptingHost): Promise<void> {
	const { session, run, inputs } = host;
	if (run.active || hasSessionDispatch(session)) return;
	const next = session.agent.peekQueuedMessages()[0];
	if (!next) {
		inputs.flushPendingCustomMessages();
		return;
	}
	session.agent.removeQueuedMessage(next);
	inputs.consumeQueuedUserMessage(next);
	if (next.role !== "user") {
		if (next.role !== "custom") return;
		await host.runLoop.startRun({ messageType: "custom", message: next });
		return;
	}
	const { text, images } = splitUserContent(next.content);
	await host.runLoop.startRun({ messageType: "user", prompt: text, images }, undefined, inputs.getUserInput(next));
}

/** Split message content into the prompt text and its images. */
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
