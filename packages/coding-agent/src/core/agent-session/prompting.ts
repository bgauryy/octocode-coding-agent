import { carryCustomReceipt } from "./custom-receipt.ts";
/** Sending user and custom messages to a session: start a run, queue into the current one, or append. */

import type { ImageContent } from "@octocodeai/octocode-ai/compat";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import {
	carriesClaudeSubscriptionToken,
	CLAUDE_SUBSCRIPTION_TOKEN_REFUSAL,
} from "@octocodeai/octocode-ai/api/anthropic-messages/token";
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
	throwIfFeatureCommand,
	tryExecuteFeatureCommand,
} from "./prompt-expansion.ts";
import { startQueuedInput } from "./queued-start.ts";
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
	// Handle feature commands first (execute immediately, even during streaming)
	// Feature commands manage their own LLM interaction via api.session.sendMessage()
	if (expandPromptTemplates && text.startsWith("/")) {
		let commandFailure: string | undefined;
		const handled = await tryExecuteFeatureCommand(session.featureHost, text, (message) => {
			commandFailure = message;
		});
		if (handled) {
			// Feature command executed, no prompt to send
			preflightResult?.("handled", commandFailure);
			return;
		}
	}

	// Manual compaction runs with no agent run, but its summary must not race a turn: input waits in the queues an
	// automatic compaction uses and is delivered by `releaseHeldInput` once the compaction ends.
	const isHolding = () => session.isStreaming || host.compaction.isManualRunning;
	const holding = isHolding();
	const behavior = options?.streamingBehavior ?? (host.compaction.isManualRunning ? "followUp" : undefined);

	// Emit input event for feature interception (before skill/template expansion)
	const processedInput = await runInputHandlers(
		session.featureHost,
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
	if (holding && !behavior) {
		throw new Error(
			"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
		);
	}
	// Input handlers, the auth check and image reads await, so a run may start or end meanwhile (a second prompt, a
	// triggered custom message, released held input). Whether the message joins the run that holds input or starts its
	// own is decided where it is queued or started, with no await in between: queued after its run ended, it would wait
	// for an unrelated prompt and land after it. Queued input carries its images normalized; a run normalizes its own.
	let queued: { text: string; images: ImageContent[] | undefined } | undefined;
	let started: { text: string; images: ImageContent[] | undefined } | undefined;
	let ready = false;
	for (;;) {
		checkSessionDispatch(session);
		if (isHolding()) {
			if (!queued) {
				queued = attachImagePaths
					? await attachPromptPathImages(host, expandedText, currentImages, true)
					: { text: expandedText, images: currentImages };
				continue;
			}
			await host.inputs.queue(behavior ?? "followUp", queued.text, queued.images, { ...input, images: queued.images });
			preflightResult?.("queued");
			return;
		}
		if (!ready) {
			await assertCanStart(host);
			ready = true;
			continue;
		}
		const prepared =
			queued ?? started ?? (attachImagePaths ? undefined : { text: expandedText, images: currentImages });
		if (!prepared) {
			started = await attachPromptPathImages(host, expandedText, currentImages, false);
			continue;
		}
		await host.runLoop.startRun(
			{ messageType: "user", prompt: prepared.text, images: prepared.images },
			() => preflightResult?.("started"),
			{ ...input, images: prepared.images },
		);
		return;
	}
}

/** A run can start: a model is selected and its provider has credentials; otherwise the error says what to set up. */
async function assertCanStart(host: PromptingHost): Promise<void> {
	const { session } = host;
	// Validate model
	if (!session.model) {
		throw new AuthRequiredError(formatNoModelSelectedMessage());
	}

	session.modelRuntime.assertModelAccess(session.model);
	const hasConfiguredAuth =
		session.modelRuntime.hasConfiguredAuth(session.model.provider) ||
		(await session.modelRuntime.checkAuth(session.model.provider)) !== undefined;
	checkSessionDispatch(session);
	if (hasConfiguredAuth) return;
	// Catalog availability hides rejected credentials; preserve their request diagnostic before calling them missing.
	if (session.model.api === "anthropic-messages") {
		const resolved = await session.modelRuntime.getAuth(session.model);
		checkSessionDispatch(session);
		if (carriesClaudeSubscriptionToken(resolved?.auth.apiKey, { ...session.model.headers, ...resolved?.auth.headers }))
			throw new AuthRequiredError(CLAUDE_SUBSCRIPTION_TOKEN_REFUSAL);
	}
	const isOAuth = session.modelRuntime.isUsingOAuth(session.model.provider);
	if (isOAuth) {
		throw new AuthRequiredError(formatAuthExpiredMessage(session.model.provider));
	}
	throw new AuthRequiredError(formatNoApiKeyFoundMessage(session.model.provider));
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
		throwIfFeatureCommand(session.featureHost, text);
	}

	const processedInput = await runInputHandlers(
		session.featureHost,
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
	// Queued with no run to deliver it (none was running, or it ended while the input was prepared): it starts one.
	releaseQueuedInput(host);
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
		// Untyped features can pass null/missing content; normalize at ingestion.
		content: message.content ?? [],
		display: message.display,
		details: message.details,
		timestamp: Date.now(),
	} satisfies CustomMessage<T>;
	carryCustomReceipt(message, appMessage);
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
 * Deliver input that waits in the queues with nothing to deliver it: a manual compaction ended (saved, failed or
 * cancelled), input was queued with no run, or a submission ended without starting one. One run starts with the first
 * queued message (steering before follow-ups); the agent loop delivers the rest of both queues in order. Held custom
 * messages with nothing queued are written now, behind the compaction entry. Nothing starts when a run, a manual
 * compaction or another submission is already under way (the queues are drained by it), or once the session is being
 * replaced or shut down (its interface carries the queue over).
 */
export async function releaseHeldInput(host: PromptingHost): Promise<void> {
	const { session, run, inputs } = host;
	if (run.active || hasSessionDispatch(session) || host.compaction.isManualRunning || host.runLoop.retiring) return;
	if (!session.agent.hasQueuedMessages()) {
		inputs.flushPendingCustomMessages();
		return;
	}
	await startQueuedInput({ session, inputs, startRun: (...args) => host.runLoop.startRun(...args) });
}

/** `releaseHeldInput` without waiting for the run it starts; a run that fails is reported as a feature error. */
export function releaseQueuedInput(host: PromptingHost): void {
	// While agent_settled handlers run, the settling run delivers what waits once they are done.
	if (host.run.active || host.run.isEmittingAgentSettled || !host.session.agent.hasQueuedMessages()) return;
	releaseHeldInput(host).catch((error: unknown) => {
		host.session.featureHost.emitError({ source: "<queue>", event: "queued_input", error: errorMessage(error) });
	});
}
