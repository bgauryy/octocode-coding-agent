/** Sending user and custom messages to a session: start a run, queue into the current one, or append. */

import type { ImageContent, TextContent } from "@octocodeai/octocode-ai/compat";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "../auth-guidance.ts";
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
import { checkSessionDispatch } from "./dispatch.ts";

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
		const handled = await tryExecuteExtensionCommand(session.extensionRunner, text);
		if (handled) {
			// Extension command executed, no prompt to send
			preflightResult?.("handled");
			return;
		}
	}

	if (host.compaction.isManualRunning) {
		throw new Error("Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.");
	}

	// Emit input event for extension interception (before skill/template expansion)
	const processedInput = await runInputHandlers(
		session.extensionRunner,
		text,
		options?.images,
		options?.source ?? "interactive",
		session.isStreaming ? options?.streamingBehavior : undefined,
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
	if (session.isStreaming) {
		if (!options?.streamingBehavior) {
			throw new Error(
				"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
			);
		}
		const queued = attachImagePaths
			? await attachPromptPathImages(host, expandedText, currentImages, true)
			: { text: expandedText, images: currentImages };
		checkSessionDispatch(session);
		await host.inputs.queue(
			options.streamingBehavior === "followUp" ? "followUp" : "steer",
			queued.text,
			queued.images,
			{ ...input, images: queued.images },
		);
		preflightResult?.("queued");
		return;
	}

	// Validate model
	if (!session.model) {
		throw new Error(formatNoModelSelectedMessage());
	}

	const hasConfiguredAuth =
		session.modelRuntime.hasConfiguredAuth(session.model.provider) ||
		(await session.modelRuntime.checkAuth(session.model.provider)) !== undefined;
	checkSessionDispatch(session);
	if (!hasConfiguredAuth) {
		const isOAuth = session.modelRuntime.isUsingOAuth(session.model.provider);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${session.model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${session.model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(session.model.provider));
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
	if (options?.deliverAs === "nextTurn") {
		host.inputs.addNextTurnMessage(appMessage);
	} else if (session.isStreaming && options?.triggerTurn !== false) {
		host.inputs.noteQueuedCustomMessage(appMessage);
		if (options?.deliverAs === "followUp") {
			session.agent.followUp(appMessage);
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
	} else if (session.isStreaming) {
		// Appending now would put the message between an assistant tool call and its
		// result, which providers that validate message order reject on replay. Defer
		// to the end of the turn. Nothing is emitted yet: message events must not
		// describe messages the session tree does not contain.
		host.inputs.addPendingCustomMessage(appMessage);
	} else {
		host.inputs.appendCustomMessage(appMessage);
	}
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
