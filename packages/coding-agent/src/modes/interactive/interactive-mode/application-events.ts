import type { ApplicationContentBlock, ApplicationEvent, ApplicationMessage } from "@octocodeai/octocode-contracts";
import type { AgentToolResult } from "@octocodeai/octocode-agent-core";
import { disposeTranscript } from "./transcript-dispose.ts";
import type { ApplicationService } from "../../../core/application/index.ts";
import { Spacer, Text } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../../common/src/sanitize.ts";
import { theme } from "../../../theme/theme.ts";
import { AssistantMessageComponent } from "../components/assistant-message.ts";
import { FullContentReader, toolContent } from "../components/application-content.ts";
import type { InteractiveModeHost } from "./host.ts";
import { addToolExecution } from "./session-render.ts";
import { TOOL_NOT_RUN } from "../../../core/application/interrupted-tools.ts";
import { addApplicationUserMessage } from "./user-message-render.ts";

type Host = Pick<
	InteractiveModeHost,
	| "chatContainer"
	| "editor"
	| "entriesRenderedByRebuild"
	| "getMarkdownThemeWithSettings"
	| "getMarkdownTransformers"
	| "hiddenThinkingLabel"
	| "uiStore"
	| "outputPad"
	| "pendingTools"
	| "session"
	| "settingsManager"
	| "streamingComponent"
	| "ui"
	| "getRegisteredToolDefinition"
	| "sessionManager"
	| "renderSessionEntries"
>;

/** Draws the branch's entries into the cleared transcript and remembers them: their announcements can still follow. */
function renderRebuild(host: Host): void {
	const entries = host.sessionManager.buildContextEntries();
	host.renderSessionEntries(entries);
	host.entriesRenderedByRebuild.clear();
	for (const entry of entries) host.entriesRenderedByRebuild.add(entry.id);
}

/** Both live transcript adapters consume these semantic events; native events retain terminal controls and diagnostics. */
export function applicationRenderer(host: Host, port: ApplicationService): (event: ApplicationEvent) => void {
	const messages = new Map<string, ApplicationMessage>();
	const assistants = new Map<string, AssistantMessageComponent>();
	const fullContent = new FullContentReader();
	const readAsset = (id: string) => port.readAsset(id);
	const showError = (message: string) => {
		host.chatContainer.addChild(new Spacer(1));
		host.chatContainer.addChild(
			new Text(theme.fg("error", sanitizeTerminalText(message).slice(0, 1000)), host.outputPad, 0),
		);
		host.ui.requestRender();
	};
	const contentOptions = () => ({
		readAsset: (id: string) => port.readAsset(id),
		showImages: host.settingsManager.getShowImages(),
		imageWidthCells: host.settingsManager.getImageWidthCells(),
		requestRender: () => host.ui.requestRender(),
	});
	// A rebuild or compaction disposes rendered messages without an event here; drop what left the transcript, so the
	// maps do not keep disposed components (and their content) alive for the rest of the session.
	const forgetDetached = () => {
		const mounted = new Set(host.chatContainer.children);
		for (const [id, component] of assistants)
			if (!mounted.has(component)) {
				assistants.delete(id);
				messages.delete(id);
			}
	};
	const showMessage = (received: ApplicationMessage) => {
		const message = fullContent.message(received, readAsset);
		const previous = messages.get(message.id);
		messages.set(message.id, message);
		if (message.role === "user") {
			if (previous) return;
			addApplicationUserMessage(host, message);
		} else if (message.role === "assistant") {
			let component = assistants.get(message.id);
			if (!component) {
				forgetDetached();
				component = new AssistantMessageComponent(
					undefined,
					host.uiStore.getState().view.hideThinking,
					host.getMarkdownThemeWithSettings(),
					host.hiddenThinkingLabel,
					host.outputPad,
					host.getMarkdownTransformers(),
					contentOptions(),
				);
				// Only the fullscreen renderer reports the mouse; elsewhere a click hint would be false.
				component.setMouseHint(host.ui.mode === "fullscreen");
				assistants.set(message.id, component);
				host.chatContainer.addChild(component);
			}
			component.updateMessage(message, !message.complete);
			for (const block of message.content ?? []) {
				if (block.type !== "toolCall") continue;
				let tool = host.pendingTools.get(block.toolCallId);
				if (!tool && !previous?.complete) {
					tool = addToolExecution(host, block.name, block.toolCallId, block.arguments, component);
					host.pendingTools.set(block.toolCallId, tool);
				} else if (tool) tool.updateArgs(block.arguments);
				if (!tool || !message.complete) continue;
				tool.setArgsComplete();
				if (message.status === "failed" || message.status === "aborted") {
					// The tools never ran: a failure shows its provider error once on the message, not on every row.
					const text = message.status === "failed" ? TOOL_NOT_RUN : (message.errorMessage ?? "Operation interrupted");
					tool.updateResult({ content: [{ type: "text", text }], isError: true });
					host.pendingTools.delete(block.toolCallId);
				}
			}
			host.streamingComponent = message.complete ? undefined : component;
		}
		host.ui.requestRender();
	};
	return (received) => {
		let event = received;
		if (event.type === "tool.started" || event.type === "tool.progress" || event.type === "tool.completed") {
			const data = fullContent.data(event.full, readAsset);
			if (data)
				event = {
					...event,
					arguments: data.arguments ?? event.arguments,
					content: Array.isArray(data.content) ? (data.content as ApplicationContentBlock[]) : event.content,
					details: data.details ?? event.details,
					structuredContent: data.structuredContent ?? event.structuredContent,
					display: (data.display as typeof event.display) ?? event.display,
				};
		}
		switch (event.type) {
			case "application.error":
				showError(event.message);
				break;
			case "session.reset":
				messages.clear();
				assistants.clear();
				host.pendingTools.clear();
				host.streamingComponent = undefined;
				disposeTranscript(host.chatContainer);
				host.chatContainer.clear();
				renderRebuild(host);
				for (const error of event.errors ?? []) showError(error.message);
				break;
			case "message.started":
			case "message.completed":
				if (event.message.role === "user" || event.message.role === "assistant") showMessage(event.message);
				break;
			case "message.delta": {
				const previous = messages.get(event.messageId);
				showMessage({
					...previous,
					id: event.messageId,
					role: "assistant",
					complete: false,
					text: event.text ?? (previous?.text ?? "") + event.delta,
					content: event.content ?? previous?.content,
					full: event.full,
				});
				break;
			}
			case "tool.started": {
				// A call a tool makes while it runs (`ctx.executeTool`, e.g. the `file` tool's parse check) is the parent's
				// work, recorded on its result: no row of its own, so it never reads as a call the model made.
				if (event.parentToolCallId) break;
				let component = host.pendingTools.get(event.toolCallId);
				if (!component) {
					component = addToolExecution(
						host,
						event.toolName,
						event.toolCallId,
						event.arguments ?? {},
						event.messageId ? assistants.get(event.messageId) : undefined,
					);
					host.pendingTools.set(event.toolCallId, component);
				} else if (event.arguments !== undefined) component.updateArgs(event.arguments);
				component.setDisplay(event.display);
				component.setArgsComplete();
				component.markExecutionStarted();
				break;
			}
			case "tool.progress":
			case "tool.completed": {
				const component = host.pendingTools.get(event.toolCallId);
				if (!component) break;
				const full = fullContent.data(event.full, readAsset);
				const content = event.content
					? toolContent(event.content, readAsset)
					: [{ type: "text", text: event.text ?? "" }];
				if (event.full && !full) content.push({ type: "text", text: `[Full tool data unavailable: ${event.full.id}]` });
				component.setDisplay(event.display);
				component.updateResult(
					{
						content,
						isError: event.failed ?? false,
						details: full?.details ?? event.details,
						structuredContent: (full?.structuredContent ??
							event.structuredContent) as AgentToolResult["structuredContent"],
						usage: event.usage as AgentToolResult["usage"],
						...(event.progress ? { progress: event.progress } : {}),
						durationMs: event.durationMs,
					},
					event.type === "tool.progress",
				);
				if (event.type === "tool.completed") host.pendingTools.delete(event.toolCallId);
				host.ui.requestRender();
				break;
			}
			default:
				// Lifecycle, queue and receipt events reach the UI through the application state store.
				break;
		}
	};
}
