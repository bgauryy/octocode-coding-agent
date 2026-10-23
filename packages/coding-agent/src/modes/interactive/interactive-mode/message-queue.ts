/**
 * Messages queued while the agent works or compaction runs: steering and follow-up queues, the pending-messages
 * area, restoring queued text to the editor, and flushing the compaction queue.
 */

import { Spacer, TruncatedText } from "@octocodeai/octocode-tui";
import { stripAnsi } from "../../../utils/ansi.ts";
import { getApplicationPort } from "../../../core/application/index.ts";
import { theme } from "../theme/theme.ts";
import type { InteractiveModeHost } from "./host.ts";
import { errorMessage } from "../../../utils/guards.ts";

/** Interactive-mode members used by the message queues. */
export type MessageQueueHost = Pick<
	InteractiveModeHost,
	| "chatContainer"
	| "clearAllQueues"
	| "compactionQueuedMessages"
	| "editor"
	| "getAllQueuedMessages"
	| "getAppKeyDisplay"
	| "isExtensionCommand"
	| "pendingBashComponents"
	| "pendingMessagesContainer"
	| "queueCompactionMessage"
	| "queueInteractiveMessage"
	| "restoreQueuedMessagesToEditor"
	| "session"
	| "showError"
	| "showStatus"
	| "ui"
	| "updatePendingMessagesDisplay"
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
	host.updatePendingMessagesDisplay();
	host.ui.requestRender();
}

export async function handleFollowUp(host: MessageQueueHost): Promise<void> {
	const text = (host.editor.getExpandedText?.() ?? host.editor.getText()).trim();
	if (!text) return;

	// Queue input during compaction (extension commands execute immediately)
	if (host.session.isCompacting) {
		if (host.isExtensionCommand(text)) {
			host.editor.addToHistory?.(text);
			host.editor.setText("");
			await getApplicationPort(host.session).invoke("prompt", text);
		} else {
			host.queueCompactionMessage(text, "followUp");
		}
		return;
	}

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

export function handleDequeue(host: MessageQueueHost): void {
	const restored = host.restoreQueuedMessagesToEditor();
	if (restored === 0) {
		host.showStatus("No queued messages to restore");
	} else {
		host.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
	}
}

/**
 * Get all queued messages (read-only).
 * Combines session queue and compaction queue.
 */
export function getAllQueuedMessages(host: MessageQueueHost): { steering: string[]; followUp: string[] } {
	return {
		steering: [
			...host.session.getSteeringMessages(),
			...host.compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text),
		],
		followUp: [
			...host.session.getFollowUpMessages(),
			...host.compactionQueuedMessages.filter((msg) => msg.mode === "followUp").map((msg) => msg.text),
		],
	};
}

/**
 * Clear all queued messages and return their contents.
 * Clears both session queue and compaction queue.
 */
export function clearAllQueues(host: MessageQueueHost): { steering: string[]; followUp: string[] } {
	const { steering, followUp } = getApplicationPort(host.session).invoke("clearQueue");
	const compactionSteering = host.compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text);
	const compactionFollowUp = host.compactionQueuedMessages
		.filter((msg) => msg.mode === "followUp")
		.map((msg) => msg.text);
	host.compactionQueuedMessages = [];
	return {
		steering: [...steering, ...compactionSteering],
		followUp: [...followUp, ...compactionFollowUp],
	};
}

export function updatePendingMessagesDisplay(host: MessageQueueHost): void {
	host.pendingMessagesContainer.clear();
	const { steering: steeringMessages, followUp: followUpMessages } = host.getAllQueuedMessages();
	if (steeringMessages.length > 0 || followUpMessages.length > 0) {
		host.pendingMessagesContainer.addChild(new Spacer(1));
		const total = steeringMessages.length + followUpMessages.length;
		host.pendingMessagesContainer.addChild(
			new TruncatedText(
				theme.fg(
					"accent",
					`${total} queued · ${steeringMessages.length} next turn · ${followUpMessages.length} after run`,
				),
				1,
				0,
			),
		);
		const previews = [
			...steeringMessages.map((text) => ({ label: "Next turn", text })),
			...followUpMessages.map((text) => ({ label: "After run", text })),
		];
		for (const [index, message] of previews.slice(0, 3).entries()) {
			const preview = stripAnsi(message.text)
				.replace(/[\r\n\t\u2028\u2029]+/g, " ")
				.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
			const text = `${theme.fg("muted", `${index + 1}. ${message.label}: `)}${theme.fg("text", preview)}`;
			host.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
		}
		if (total > 3)
			host.pendingMessagesContainer.addChild(new TruncatedText(theme.fg("muted", `… ${total - 3} more queued`), 1, 0));
		const dequeueHint = host.getAppKeyDisplay("app.message.dequeue");
		const hintText = theme.fg(
			"muted",
			`↳ ${dequeueHint} to restore all to editor${host.session.isCompacting ? " · waiting for compaction" : ""}`,
		);
		host.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
	}
}

export function restoreQueuedMessagesToEditor(
	host: MessageQueueHost,
	options?: { abort?: boolean; currentText?: string },
): number {
	const { steering, followUp } = host.clearAllQueues();
	const allQueued = [...steering, ...followUp];
	if (allQueued.length === 0) {
		host.updatePendingMessagesDisplay();
		if (options?.abort) {
			void getApplicationPort(host.session).invoke("abort");
		}
		return 0;
	}
	const queuedText = allQueued.join("\n\n");
	const currentText = options?.currentText ?? host.editor.getText();
	const combinedText = [queuedText, currentText].filter((t) => t.trim()).join("\n\n");
	host.editor.setText(combinedText);
	host.updatePendingMessagesDisplay();
	if (options?.abort) {
		void getApplicationPort(host.session).invoke("abort");
	}
	return allQueued.length;
}

export function queueCompactionMessage(host: MessageQueueHost, text: string, mode: "steer" | "followUp"): void {
	host.compactionQueuedMessages.push({ text, mode });
	host.editor.addToHistory?.(text);
	host.editor.setText("");
	host.updatePendingMessagesDisplay();
	host.showStatus("Queued message for after compaction");
}

export function isExtensionCommand(host: MessageQueueHost, text: string): boolean {
	if (!text.startsWith("/")) return false;

	const extensionRunner = host.session.extensionRunner;

	const spaceIndex = text.indexOf(" ");
	const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	return !!extensionRunner.getCommand(commandName);
}

export async function flushCompactionQueue(host: MessageQueueHost, options?: { willRetry?: boolean }): Promise<void> {
	if (host.compactionQueuedMessages.length === 0) return;
	const pending = new Set(host.compactionQueuedMessages);
	host.compactionQueuedMessages = [];
	host.updatePendingMessagesDisplay();
	let started = options?.willRetry ?? false;
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
				await getApplicationPort(host.session).invoke("followUp", message.text);
			} else {
				await getApplicationPort(host.session).invoke("steer", message.text);
			}
			pending.delete(message);
		}
	} catch (error) {
		host.compactionQueuedMessages = [...pending, ...host.compactionQueuedMessages];
		host.showError(
			`Could not send ${pending.size} queued message${pending.size === 1 ? "" : "s"}; kept for editing: ${errorMessage(error)}`,
		);
	}
	host.updatePendingMessagesDisplay();
}

/** Move pending bash components from pending area to chat */
export function flushPendingBashComponents(host: MessageQueueHost): void {
	for (const component of host.pendingBashComponents) {
		host.pendingMessagesContainer.removeChild(component);
		host.chatContainer.addChild(component);
	}
	host.pendingBashComponents = [];
}
