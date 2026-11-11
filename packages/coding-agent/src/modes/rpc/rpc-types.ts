import type { PlanState } from "../../core/plan-state.ts";
/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */

import type { AgentMessage, ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { Model } from "@octocodeai/octocode-ai";
import type {
	PromptDisposition,
	QueuedInput,
	QueuedInputDisposition,
	RunOutcome,
	SessionStats,
} from "../../core/agent-session.ts";
import type { Question, Reply } from "@octocodeai/octocode-contracts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import type { ExtensionUIAskView, ExtensionUIPermissionRequest } from "../../core/features/types.ts";
import type { StatusTone } from "../../core/footer-data-provider.ts";
import type { SessionEntry, SessionTreeNode } from "../../core/session-manager.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import type { DeleteByIdResult } from "../../octocode/sessions/delete.ts";
import type { PurgeResult } from "../../octocode/sessions/purge.ts";
import type { Static } from "typebox";
import type { RpcCommandSchema } from "./rpc-command-schema.ts";

// RPC Commands (stdin)

/** The command union is derived from the validation schema, so the two cannot drift apart. */
export type RpcCommand = Static<typeof RpcCommandSchema>;

/** `delete_sessions`: what was removed, refused (current or running), failed, or not found. */
type RpcDeleteSessionsResult = DeleteByIdResult;

/** `purge`: with `confirm: false` or a refusal nothing is deleted and `lines` is the preview or the reason; else the outcome. */
interface RpcPurgeResult {
	purged: boolean;
	lines: string[];
	refused?: string;
	result?: PurgeResult;
}

// RPC Slash Command (for get_commands response)

/** A command available for invocation via prompt */
export interface RpcSlashCommand {
	/** Command name (without leading slash) */
	name: string;
	description?: string;
	/** Usage of the arguments, such as `[all|<query>]` (extension commands) */
	argumentHint?: string;
	/** What kind of command this is */
	source: "extension" | "prompt" | "skill";
	/** Source metadata for the owning resource */
	sourceInfo: SourceInfo;
}

// RPC State

export interface RpcSessionState {
	/** The version of this protocol, as in `rpc_ready`. */
	protocolVersion: number;
	/** The Octocode version answering. */
	version: string;
	model?: Model<any>;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
}

// RPC Responses (stdout)

// Success responses with data
export type RpcResponse =
	// Prompting
	| {
			id?: string;
			type: "response";
			command: "prompt";
			success: true;
			/** `outcome` is set on a `waitForCompletion` answer: how the run ended, since a failed run still answers success. */
			data: { disposition: PromptDisposition; outcome?: RunOutcome };
	  }
	| { id?: string; type: "response"; command: "steer"; success: true; data: { disposition: QueuedInputDisposition } }
	| {
			id?: string;
			type: "response";
			command: "follow_up";
			success: true;
			data: { disposition: QueuedInputDisposition };
	  }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| {
			id?: string;
			type: "response";
			command: "clear_queue";
			success: true;
			data: { steering: string[]; followUp: string[] };
	  }
	| { id?: string; type: "response"; command: "get_queue"; success: true; data: { items: QueuedInput[] } }
	| {
			id?: string;
			type: "response";
			command: "edit_queued";
			success: true;
			data: { outcome: "replaced" | "removed" | "missing" };
	  }
	| { id?: string; type: "response"; command: "remove_queued"; success: true; data: { removed: boolean } }
	| { id?: string; type: "response"; command: "move_queued"; success: true; data: { moved: boolean } }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "plan"; success: true; data: PlanState }
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model<any>;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			/** `interactiveOnly`: the model's plan allows interactive use only (`ModelRuntime.allowsUnattendedUse`). */
			data: { models: Array<Model<any> & { interactiveOnly?: true }> };
	  }
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: ThinkingLevel } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_thinking_levels";
			success: true;
			data: { levels: ThinkingLevel[] };
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| { id?: string; type: "response"; command: "clone"; success: true; data: { cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_fork_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_entries";
			success: true;
			data: { entries: SessionEntry[]; leafId: string | null };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_tree";
			success: true;
			data: { tree: SessionTreeNode[]; leafId: string | null };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }
	| { id?: string; type: "response"; command: "persist_session"; success: true }
	| { id?: string; type: "response"; command: "delete_sessions"; success: true; data: RpcDeleteSessionsResult }
	| { id?: string; type: "response"; command: "purge"; success: true; data: RpcPurgeResult }
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }

	// Commands
	| {
			id?: string;
			type: "response";
			command: "get_commands";
			success: true;
			data: { commands: RpcSlashCommand[] };
	  }

	// Error response (any command can fail)
	| {
			id?: string;
			type: "response";
			command: string;
			success: false;
			error: string;
			execution?: "not-sent";
			authRequired?: true;
	  };

// Extension UI Events (stdout)

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| {
			type: "extension_ui_request";
			id: string;
			method: "select";
			title: string;
			options: string[];
			timeout?: number;
			/** A permission prompt sent to a client without `--rpc-ask`: the identity of the call and which `options` allow it once or refuse it. */
			permission?: ExtensionUIPermissionRequest;
			/** The dialog decides whether to allow an action: show it as an approval. Set on a permission prompt sent to a client without `--rpc-ask`. */
			approval?: boolean;
			/** The permission prompt's card, a terminal may draw it; its labels are `options`. Clients may ignore it. */
			ask?: ExtensionUIAskView;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "confirm";
			title: string;
			message: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			/**
			 * A batch of typed questions, sent only to a client that started the process with `--rpc-ask`. Answer with an
			 * `extension_ui_response` carrying `replies`: one `Reply` per question id. A client that did not declare `ask` never
			 * sees this method; it gets the same questions as `select`, `confirm` and `input`.
			 */
			method: "ask";
			questions: Question[];
			/** A question here is an `approval` (a permission prompt): show it as one. Repeats the questions' types. */
			approval?: boolean;
			/** A subagent's one approval: the permission header line its parent reads to answer without a dialog. Never shown. */
			header?: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
			/** How the status should read; `statusText` itself carries no colour codes. */
			statusTone?: StatusTone;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

/**
 * Emitted when a dialog of an earlier `extension_ui_request` ended without the host's response (a remote client answered
 * it, its run was aborted, or its timeout passed): the host closes dialog `id`. A late response to it is ignored.
 */
export interface RpcExtensionUIDismiss {
	type: "extension_ui_dismiss";
	id: string;
}

// Extension UI Commands (stdin)

export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; replies: Reply[] }
	| { type: "extension_ui_response"; id: string; cancelled: true };

/** Extension failure already emitted on the RPC wire alongside session events. */
export interface RpcExtensionErrorEvent {
	type: "extension_error";
	extensionPath: string;
	event: string;
	error: string;
}
