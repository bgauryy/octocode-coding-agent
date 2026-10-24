import type { AgentSession } from "../../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../../core/agent-session-runtime.ts";
import { getPromptCommands } from "../../../core/prompt-templates.ts";
import { getSkillCommands } from "../../../core/skill-commands.ts";
import type { RpcCommand, RpcResponse, RpcSessionState, RpcSlashCommand } from "../rpc-types.ts";
import { error, success } from "./responses.ts";
import type { RpcOutput } from "./ui-context.ts";

/** What command handling reads from the running RPC mode; `session` follows session rebinds. */
export interface RpcCommandHost {
	readonly session: AgentSession;
	runtimeHost: AgentSessionRuntime;
	output: RpcOutput;
}

// Handle a single command
export const handleCommand = async (host: RpcCommandHost, command: RpcCommand): Promise<RpcResponse | undefined> => {
	const { runtimeHost, output } = host;
	const id = command.id;

	switch (command.type) {
		// =================================================================
		// Prompting
		// =================================================================

		case "prompt": {
			// Start prompt handling immediately, but emit the authoritative response only after
			// prompt preflight succeeds. Queued and immediately handled prompts also count as success.
			let preflightSucceeded = false;
			void host.session
				.prompt(command.message, {
					images: command.images,
					streamingBehavior: command.streamingBehavior,
					source: "rpc",
					preflightResult: (disposition) => {
						preflightSucceeded = true;
						output(success(id, "prompt", { disposition }));
					},
				})
				.catch((e) => {
					if (!preflightSucceeded) {
						output(error(id, "prompt", e.message));
					}
				});
			return undefined;
		}

		case "steer": {
			const disposition = await host.session.steer(command.message, command.images, { source: "rpc" });
			return success(id, "steer", { disposition });
		}

		case "follow_up": {
			const disposition = await host.session.followUp(command.message, command.images, { source: "rpc" });
			return success(id, "follow_up", { disposition });
		}

		case "abort": {
			await host.session.abort();
			return success(id, "abort");
		}

		case "clear_queue": {
			return success(id, "clear_queue", host.session.clearQueue());
		}

		case "get_queue": {
			return success(id, "get_queue", { items: host.session.getQueuedInputs() });
		}

		case "edit_queued": {
			return success(id, "edit_queued", { outcome: host.session.replaceQueuedInput(command.queueId, command.text) });
		}

		case "remove_queued": {
			return success(id, "remove_queued", { removed: host.session.removeQueuedInput(command.queueId) !== undefined });
		}

		case "move_queued": {
			return success(id, "move_queued", { moved: host.session.moveQueuedInput(command.queueId, command.direction) });
		}

		case "new_session": {
			const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
			const result = await runtimeHost.newSession(options);
			return success(id, "new_session", result);
		}

		// =================================================================
		// State
		// =================================================================

		case "plan":
			return success(id, "plan", await host.session.controlPlan(command));
		case "get_state": {
			const state: RpcSessionState = {
				model: host.session.model,
				thinkingLevel: host.session.thinkingLevel,
				isStreaming: host.session.isStreaming,
				isCompacting: host.session.isCompacting,
				steeringMode: host.session.steeringMode,
				followUpMode: host.session.followUpMode,
				sessionFile: host.session.sessionFile,
				sessionId: host.session.sessionId,
				sessionName: host.session.sessionName,
				autoCompactionEnabled: host.session.autoCompactionEnabled,
				messageCount: host.session.messages.length,
				pendingMessageCount: host.session.pendingMessageCount,
			};
			return success(id, "get_state", state);
		}

		// =================================================================
		// Model
		// =================================================================

		case "set_model": {
			const models = host.session.modelRuntime.getAvailableSnapshot();
			const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
			if (!model) {
				return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
			}
			await host.session.setModel(model);
			return success(id, "set_model", model);
		}

		case "cycle_model": {
			const result = await host.session.cycleModel();
			if (!result) {
				return success(id, "cycle_model", null);
			}
			return success(id, "cycle_model", result);
		}

		case "get_available_models": {
			const models = host.session.modelRuntime.getAvailableSnapshot();
			return success(id, "get_available_models", { models });
		}

		// =================================================================
		// Thinking
		// =================================================================

		case "set_thinking_level": {
			host.session.setThinkingLevel(command.level);
			return success(id, "set_thinking_level");
		}

		case "cycle_thinking_level": {
			const level = host.session.cycleThinkingLevel();
			if (!level) {
				return success(id, "cycle_thinking_level", null);
			}
			return success(id, "cycle_thinking_level", { level });
		}

		case "get_available_thinking_levels": {
			const levels = host.session.getAvailableThinkingLevels();
			return success(id, "get_available_thinking_levels", { levels });
		}

		// =================================================================
		// Queue Modes
		// =================================================================

		case "set_steering_mode": {
			host.session.setSteeringMode(command.mode);
			return success(id, "set_steering_mode");
		}

		case "set_follow_up_mode": {
			host.session.setFollowUpMode(command.mode);
			return success(id, "set_follow_up_mode");
		}

		// =================================================================
		// Compaction
		// =================================================================

		case "compact": {
			const result = await host.session.compact({ customInstructions: command.customInstructions });
			return success(id, "compact", result);
		}

		// =================================================================
		// Retry
		// =================================================================

		case "set_auto_retry": {
			host.session.setAutoRetryEnabled(command.enabled);
			return success(id, "set_auto_retry");
		}

		case "abort_retry": {
			host.session.abortRetry();
			return success(id, "abort_retry");
		}

		// =================================================================
		// Bash
		// =================================================================

		case "bash": {
			const eventResult = await host.session.extensionRunner.emitUserBash({
				type: "user_bash",
				command: command.command,
				excludeFromContext: command.excludeFromContext ?? false,
				cwd: host.session.sessionManager.getCwd(),
			});

			if (eventResult?.result) {
				host.session.recordBashResult(command.command, eventResult.result, {
					excludeFromContext: command.excludeFromContext,
				});
				return success(id, "bash", eventResult.result);
			}

			const result = await host.session.executeBash(command.command, undefined, {
				excludeFromContext: command.excludeFromContext,
				id,
				operations: eventResult?.operations,
			});
			return success(id, "bash", result);
		}

		case "abort_bash": {
			host.session.abortBash();
			return success(id, "abort_bash");
		}

		// =================================================================
		// Session
		// =================================================================

		case "get_session_stats": {
			const stats = host.session.getSessionStats();
			return success(id, "get_session_stats", stats);
		}

		case "persist_session": {
			host.session.sessionManager.materialize();
			return success(id, "persist_session");
		}

		case "export_html": {
			const path = await host.session.exportToHtml(command.outputPath);
			return success(id, "export_html", { path });
		}

		case "switch_session": {
			const result = await runtimeHost.switchSession(command.sessionPath);
			return success(id, "switch_session", result);
		}

		case "fork": {
			const result = await runtimeHost.fork(command.entryId);
			return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
		}

		case "clone": {
			const leafId = host.session.sessionManager.getLeafId();
			if (!leafId) {
				return error(id, "clone", "Cannot clone session: no current entry selected");
			}
			const result = await runtimeHost.fork(leafId, { position: "at" });
			return success(id, "clone", { cancelled: result.cancelled });
		}

		case "get_fork_messages": {
			const messages = host.session.getUserMessagesForForking();
			return success(id, "get_fork_messages", { messages });
		}

		case "get_entries": {
			const sessionManager = host.session.sessionManager;
			let entries = sessionManager.getEntries();
			if (command.since !== undefined) {
				const sinceIndex = entries.findIndex((e) => e.id === command.since);
				if (sinceIndex === -1) {
					return error(id, "get_entries", `Entry not found: ${command.since}`);
				}
				entries = entries.slice(sinceIndex + 1);
			}
			return success(id, "get_entries", { entries, leafId: sessionManager.getLeafId() });
		}

		case "get_tree": {
			const sessionManager = host.session.sessionManager;
			return success(id, "get_tree", { tree: sessionManager.getTree(), leafId: sessionManager.getLeafId() });
		}

		case "get_last_assistant_text": {
			const text = host.session.getLastAssistantText();
			return success(id, "get_last_assistant_text", { text });
		}

		case "set_session_name": {
			const name = command.name.trim();
			if (!name) {
				return error(id, "set_session_name", "Session name cannot be empty");
			}
			host.session.setSessionName(name);
			return success(id, "set_session_name");
		}

		// =================================================================
		// Messages
		// =================================================================

		case "get_messages": {
			return success(id, "get_messages", { messages: host.session.messages });
		}

		// =================================================================
		// Commands (available for invocation via prompt)
		// =================================================================

		case "get_commands": {
			const commands: RpcSlashCommand[] = [];

			for (const command of host.session.extensionRunner.getRegisteredCommands()) {
				commands.push({
					name: command.invocationName,
					aliases: command.invocationAliases,
					description: command.description,
					source: "extension",
					sourceInfo: command.sourceInfo,
				});
			}

			for (const { template, name } of getPromptCommands(
				host.session.promptTemplates,
				host.session.extensionRunner.getRegisteredCommands(),
			)) {
				commands.push({
					name,
					description: template.description,
					source: "prompt",
					sourceInfo: template.sourceInfo,
				});
			}

			for (const { skill, name } of getSkillCommands(host.session.resourceLoader.getSkills().skills, [
				...host.session.extensionRunner.getRegisteredCommands(),
				...host.session.promptTemplates,
			])) {
				commands.push({
					name,
					description: skill.description,
					source: "skill",
					sourceInfo: skill.sourceInfo,
				});
			}

			return success(id, "get_commands", { commands });
		}

		default: {
			const unknownCommand = command as { type: string };
			return error(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
		}
	}
};
