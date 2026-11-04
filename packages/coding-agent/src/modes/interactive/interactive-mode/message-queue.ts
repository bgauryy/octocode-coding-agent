/**
 * Messages queued while the agent works or compaction runs: steering and follow-up queues, the pending-messages
 * area, restoring queued text to the editor, and flushing the compaction queue.
 */

import { getApplicationPort } from "../../../core/application/index.ts";
import type { InteractiveModeHost } from "./host.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { recallLastQueuedMessage } from "./queue-manager.ts";
import type { CompactionQueuedMessage } from "./types.ts";

/** Interactive-mode members used by the message queues. */
type MessageQueueHost = Pick<
	InteractiveModeHost,
	| "chatContainer"
	| "clearAllQueues"
	| "editor"
	| "getAllQueuedMessages"
	| "isExtensionCommand"
	| "pendingBashComponents"
	| "pendingMessagesContainer"
	| "queueCompactionMessage"
	| "queueInteractiveMessage"
	| "restoreQueuedMessagesToEditor"
	| "session"
	| "showError"
	| "showExtensionEditor"
	| "showExtensionSelector"
	| "showStatus"
	| "ui"
	| "uiStore"
>;

export async function queueInteractiveMessage(
	host: MessageQueueHost,
	text: string,
	mode: "steer" | "followUp",
): Promise<void> {
	host.editor.addToHistory?.(text);
	host.editor.setText("");
	let accepted = false;
	try {
		await getApplicationPort(host.session).invoke("prompt", text, {
			streamingBehavior: mode,
			attachImagePaths: true,
			preflightResult: () => {
				accepted = true;
			},
		});
	} catch (error) {
		if (!accepted) host.editor.setText([text, host.editor.getText()].filter((part) => part.trim()).join("\n\n"));
		host.showError(
			`${accepted ? "Message failed" : "Message was not queued; restored to editor"}: ${errorMessage(error)}`,
		);
	}
}

/** While compaction runs, executes extension commands at once and queues other input; returns whether it did. */
export async function handleInputDuringCompaction(
	host: Pick<InteractiveModeHost, "editor" | "isExtensionCommand" | "queueCompactionMessage" | "session" | "showError">,
	text: string,
	mode: "steer" | "followUp",
): Promise<boolean> {
	if (!host.session.isCompacting) return false;
	if (host.isExtensionCommand(text)) {
		host.editor.addToHistory?.(text);
		host.editor.setText("");
		// Callers are editor key handlers that drop the promise; a command that could not start goes back to the editor.
		try {
			await getApplicationPort(host.session).invoke("prompt", text);
		} catch (error) {
			host.editor.setText([text, host.editor.getText()].filter((part) => part.trim()).join("\n\n"));
			host.showError(`Command did not run; restored to editor: ${errorMessage(error)}`);
		}
	} else {
		host.queueCompactionMessage(text, mode);
	}
	return true;
}

export async function handleFollowUp(host: MessageQueueHost): Promise<void> {
	const text = (host.editor.getExpandedText?.() ?? host.editor.getText()).trim();
	if (!text) return;

	// No await unless compaction runs: the editor is cleared before the next key, so keys typed in the same tick
	// start a new message instead of joining the one being queued.
	if (host.session.isCompacting && (await handleInputDuringCompaction(host, text, "followUp"))) return;

	// Alt+Enter queues a follow-up message (waits until agent finishes)
	// This handles extension commands (execute immediately), prompt template expansion, and queueing
	if (host.session.isStreaming) {
		await host.queueInteractiveMessage(text, "followUp");
	}
	// If not streaming, Alt+Enter acts like regular Enter (trigger onSubmit)
	else if (host.editor.onSubmit) {
		host.editor.setText("");
		host.editor.onSubmit(text);
	}
}

/** The dequeue key recalls the last queued message only; Escape restores them all (see the keybinding docs). */
export function handleDequeue(host: MessageQueueHost): void {
	recallLastQueuedMessage(host);
}

/**
 * Get all queued messages (read-only).
 * Combines session queue and compaction queue.
 */
export function getAllQueuedMessages(host: MessageQueueHost): { steering: string[]; followUp: string[] } {
	return {
		steering: [
			...host.session.getSteeringMessages(),
			...host.uiStore
				.getState()
				.queue.compaction.filter((msg) => msg.mode === "steer")
				.map((msg) => msg.text),
		],
		followUp: [
			...host.session.getFollowUpMessages(),
			...host.uiStore
				.getState()
				.queue.compaction.filter((msg) => msg.mode === "followUp")
				.map((msg) => msg.text),
		],
	};
}

/**
 * Clear all queued messages and return their contents.
 * Clears both session queue and compaction queue.
 */
export function clearAllQueues(host: MessageQueueHost): { steering: string[]; followUp: string[] } {
	const { steering, followUp } = getApplicationPort(host.session).invoke("clearQueue");
	const held = host.uiStore.getState().takeHeldMessages();
	const compactionSteering = held.filter((msg) => msg.mode === "steer").map((msg) => msg.text);
	const compactionFollowUp = held.filter((msg) => msg.mode === "followUp").map((msg) => msg.text);
	return {
		steering: [...steering, ...compactionSteering],
		followUp: [...followUp, ...compactionFollowUp],
	};
}

export function restoreQueuedMessagesToEditor(
	host: MessageQueueHost,
	options?: { abort?: boolean; currentText?: string },
): number {
	const { steering, followUp } = host.clearAllQueues();
	const allQueued = [...steering, ...followUp];
	if (allQueued.length === 0) {
		if (options?.abort) {
			void getApplicationPort(host.session).invoke("abort");
		}
		return 0;
	}
	const queuedText = allQueued.join("\n\n");
	const currentText = options?.currentText ?? host.editor.getText();
	const combinedText = [queuedText, currentText].filter((t) => t.trim()).join("\n\n");
	host.editor.setText(combinedText);
	if (options?.abort) {
		void getApplicationPort(host.session).invoke("abort");
	}
	return allQueued.length;
}

export function queueCompactionMessage(host: MessageQueueHost, text: string, mode: "steer" | "followUp"): void {
	host.uiStore.getState().holdMessage({ text, mode });
	host.editor.addToHistory?.(text);
	host.editor.setText("");
	host.showStatus("Queued message for after compaction");
}

export function isExtensionCommand(host: MessageQueueHost, text: string): boolean {
	if (!text.startsWith("/")) return false;

	const extensionRunner = host.session.extensionRunner;

	const spaceIndex = text.indexOf(" ");
	const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	return !!extensionRunner.getCommand(commandName);
}

/** Sends the messages typed during compaction. Messages carried over a session switch wait for the user. */
export function flushCompactionQueue(host: MessageQueueHost, options?: { willRetry?: boolean }): Promise<void> {
	return deliverHeldMessages(host, host.uiStore.getState().takeHeldMessages(false), options?.willRetry ?? false);
}

/** Enter in an empty editor: sends the messages carried over a session switch, in their order and kinds. */
export async function sendCarriedMessages(host: MessageQueueHost): Promise<void> {
	if (host.uiStore.getState().queue.compaction.every((message) => !message.carried)) return;
	if (host.session.isCompacting) {
		host.showStatus("Compaction is running; press Enter again when it ends to send the queued messages");
		return;
	}
	await deliverHeldMessages(host, host.uiStore.getState().takeHeldMessages(true), false);
}

async function deliverHeldMessages(
	host: MessageQueueHost,
	messages: CompactionQueuedMessage[],
	willRetry: boolean,
): Promise<void> {
	const pending = new Set(messages);
	if (pending.size === 0) return;
	let started = willRetry;
	try {
		for (const message of pending) {
			if (host.isExtensionCommand(message.text)) {
				await getApplicationPort(host.session).invoke("prompt", message.text);
			} else if (!started) {
				let beganRun = false;
				await new Promise<void>((resolve, reject) => {
					let accepted = false;
					const accept = (disposition?: string) => {
						if (accepted) return;
						accepted = true;
						beganRun = disposition !== "handled";
						pending.delete(message);
						resolve();
					};
					void getApplicationPort(host.session)
						.invoke("prompt", message.text, {
							streamingBehavior: message.mode,
							attachImagePaths: true,
							preflightResult: accept,
						})
						.then(
							() => accept(),
							(error) => {
								if (accepted) host.showError(errorMessage(error));
								else reject(error);
							},
						);
				});
				started = beganRun;
			} else if (message.mode === "followUp") {
				await getApplicationPort(host.session).invoke("followUp", message.text, undefined, { attachImagePaths: true });
			} else {
				await getApplicationPort(host.session).invoke("steer", message.text, undefined, { attachImagePaths: true });
			}
			pending.delete(message);
		}
	} catch (error) {
		host.uiStore.getState().editHeldMessages((held) => held.unshift(...pending));
		host.showError(
			`Could not send ${pending.size} queued message${pending.size === 1 ? "" : "s"}; kept for editing: ${errorMessage(error)}`,
		);
	}
}

/** Move pending bash components from pending area to chat */
export function flushPendingBashComponents(host: MessageQueueHost): void {
	for (const component of host.pendingBashComponents) {
		host.pendingMessagesContainer.removeChild(component);
		host.chatContainer.addChild(component);
	}
	host.pendingBashComponents = [];
}
