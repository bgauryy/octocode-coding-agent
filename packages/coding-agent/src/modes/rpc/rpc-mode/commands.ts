import type { AgentSession } from "../../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../../core/agent-session-runtime.ts";
import { getPromptCommands } from "../../../core/prompt-templates.ts";
import { getSkillCommands } from "../../../core/skill-commands.ts";
import { VERSION } from "../../../config.ts";
import { redactUrlCredentials } from "@octocodeai/octocode-common/url-credentials";
import { sessionFileRunningPid } from "../../../octocode/shared/session-liveness.ts";
import type { RpcCommand, RpcResponse, RpcSessionState, RpcSlashCommand } from "../rpc-types.ts";
import { RPC_PROTOCOL_VERSION } from "../session-identity.ts";
import { error, success } from "./responses.ts";
import type { RpcOutput } from "./ui-context.ts";
import { handlePrompt } from "./prompt.ts";
import { handleDeleteSessions, handlePurge } from "./session-delete.ts";

/** What command handling reads from the running RPC mode; `session` follows session rebinds. */
export interface RpcCommandHost {
	readonly session: AgentSession;
	runtimeHost: AgentSessionRuntime;
	output: RpcOutput;
}

/** A model as an RPC client sees it: headers are already cleared; the baseUrl loses any user name or key a configuration put in it. */
function publicModel<T extends { baseUrl: string }>(model: T): T {
	return { ...model, baseUrl: redactUrlCredentials(model.baseUrl) };
}

export const handleCommand = async (host: RpcCommandHost, command: RpcCommand): Promise<RpcResponse | undefined> => {
	const { runtimeHost, output } = host;
	const id = command.id;

	switch (command.type) {
		case "prompt": {
			handlePrompt(host.session, command, output);
			return undefined;
		}

		case "steer": {
			if (command.toolChoice) host.session.agent.nextToolChoice = command.toolChoice;
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

		case "plan":
			return success(id, "plan", await host.session.controlPlan(command));
		case "get_state": {
			const state: RpcSessionState = {
				protocolVersion: RPC_PROTOCOL_VERSION,
				version: VERSION,
				model: host.session.model && publicModel(host.session.model),
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

		case "set_model": {
			const models = host.session.modelRuntime.getAvailableSnapshot();
			const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
			if (!model) {
				return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
			}
			await host.session.setModel(model);
			return success(id, "set_model", publicModel(model));
		}

		case "cycle_model": {
			const result = await host.session.cycleModel();
			if (!result) {
				return success(id, "cycle_model", null);
			}
			return success(id, "cycle_model", { ...result, model: publicModel(result.model) });
		}

		case "get_available_models": {
			const { modelRuntime } = host.session;
			const models = modelRuntime
				.getAvailableSnapshot()
				.map((model) =>
					modelRuntime.allowsUnattendedUse(model.provider)
						? publicModel(model)
						: { ...publicModel(model), interactiveOnly: true as const },
				);
			return success(id, "get_available_models", { models });
		}

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

		case "set_steering_mode": {
			host.session.setSteeringMode(command.mode);
			return success(id, "set_steering_mode");
		}

		case "set_follow_up_mode": {
			host.session.setFollowUpMode(command.mode);
			return success(id, "set_follow_up_mode");
		}

		case "compact": {
			const result = await host.session.compact({ customInstructions: command.customInstructions });
			return success(id, "compact", result);
		}

		case "set_auto_retry": {
			// A session's choice: `setAutoRetryEnabled` writes global settings, which would change every later session of the
			// user. Durable so that a later settings write by this session (a model change, say) does not undo it.
			host.session.settingsManager.applyOverrides({ retry: { enabled: command.enabled } }, { durable: true });
			return success(id, "set_auto_retry");
		}

		case "abort_retry": {
			host.session.abortRetry();
			return success(id, "abort_retry");
		}

		case "bash": {
			const result = await host.session.runUserBash(command.command, {
				excludeFromContext: command.excludeFromContext,
				id,
			});
			return success(id, "bash", result);
		}

		case "abort_bash": {
			host.session.abortBash();
			return success(id, "abort_bash");
		}

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
			// Two processes appending to one session overwrite each other's history; no one is here to confirm the risk.
			const runningPid = await sessionFileRunningPid(command.sessionPath);
			if (runningPid !== undefined && runningPid !== process.pid)
				return error(
					id,
					"switch_session",
					`Another Octocode process (pid ${runningPid}) has this session open: ${command.sessionPath}. Close it, or fork the session with --fork.`,
				);
			const result = await runtimeHost.switchSession(command.sessionPath);
			return success(id, "switch_session", result);
		}

		case "delete_sessions":
			return handleDeleteSessions(host, command);

		case "purge":
			return handlePurge(host, command);

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

		case "get_messages": {
			return success(id, "get_messages", { messages: host.session.messages });
		}

		case "get_commands": {
			const commands: RpcSlashCommand[] = [];

			for (const command of host.session.featureHost.getRegisteredCommands()) {
				commands.push({
					name: command.invocationName,
					description: command.description,
					...(command.argumentHint && { argumentHint: command.argumentHint }),
					source: "extension",
					sourceInfo: command.sourceInfo,
				});
			}

			for (const { template, name } of getPromptCommands(
				host.session.promptTemplates,
				host.session.featureHost.getRegisteredCommands(),
			)) {
				commands.push({
					name,
					description: template.description,
					source: "prompt",
					sourceInfo: template.sourceInfo,
				});
			}

			for (const { skill, name } of getSkillCommands(host.session.resourceLoader.getSkills().skills, [
				...host.session.featureHost.getRegisteredCommands(),
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
