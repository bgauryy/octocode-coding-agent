/**
 * What the ACP workspace needs from its host (the coding-agent application) and nothing more. This workspace imports no
 * host code: the host builds an `AcpClientHost` or an `AcpServerHost` at its composition root (see `octocode/external/
 * acp-host.ts` for the outbound client and `main/acp-host.ts` for the inbound broker) and hands it to `AcpBackend.connect`
 * or `runAcpMode`. Everything below is a narrow structural type: the host's richer RPC and session types satisfy it.
 */
import type { ImageContent, Message, TextContent } from "@octocodeai/octocode-ai";

/** Where a saved copy of captured output goes: the host's private session output folder. Undefined when it could not be written. */
export type AcpSaveOutput = (data: string | Uint8Array, label: string, extension: string) => string | undefined;

/** Process-tree control for a spawned child (job objects on Windows, process groups elsewhere). */
interface AcpProcessTree {
	/** How long a stop waits for a tree to exit before killing it. */
	readonly graceMs: number;
	/** Before spawning the root of a tree. */
	prepare(): Promise<void>;
	/** Right after spawning the root of a tree. */
	adopt(pid: number | undefined): void;
	/** Ends the tree rooted at `pid`: a signal, a grace period, then a kill. */
	stop(pid: number | undefined): Promise<void>;
}

/** What the outbound client (`AcpBackend`) needs from its host. */
export interface AcpClientHost {
	readonly saveOutput: AcpSaveOutput;
	readonly processTree: AcpProcessTree;
}

// ---------------------------------------------------------------------------------------------------------------------
// Inbound broker
// ---------------------------------------------------------------------------------------------------------------------

/** A displayed message an extension, hook or subagent injected into the transcript. */
interface AcpCustomMessage {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	timestamp: number;
	/** What the extension recorded with it; an external message's facts are at `external`. */
	details?: unknown;
}

/** A host message: the model's own kinds, the injected kind, and host-only kinds the projection ignores. */
type AcpMessage = Message | AcpCustomMessage | { role: "bashExecution" | "branchSummary" | "compactionSummary" };

/** The worker events the projection reads; the host delivers no others. */
export type AcpWorkerEvent =
	| { type: "session_dispatch"; active: boolean; dispatchId: string }
	| { type: "agent_settled"; aborted: boolean }
	| { type: "agent_end"; willRetry: boolean }
	| { type: "extension_error"; event: string; error: string }
	| { type: "message_start"; message: AcpMessage }
	| { type: "message_update"; assistantMessageEvent: { type: string; contentIndex?: number; delta?: string } }
	| { type: "message_end"; message: AcpMessage }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; finalError?: string }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: { summary: string; tokensBefore: number } | undefined;
			aborted: boolean;
			errorMessage?: string;
	  }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean };

/** A dialog the worker's extensions raise that a client can answer; the host drops every other UI request. */
export type AcpUiRequest =
	| {
			id: string;
			method: "select";
			title: string;
			options: string[];
			permission?: {
				toolName?: string;
				toolCallId?: string;
				targets: string[];
				allowOnce: string;
				rejectOnce: string;
			};
	  }
	| { id: string; method: "confirm" | "input" | "editor"; title: string };

/** The answer to an `AcpUiRequest`: a chosen value, or a cancellation. */
export type AcpUiResponse = { type: "extension_ui_response"; id: string } & ({ value: string } | { cancelled: true });

/** The state of a worker session the broker needs to own its identity. */
export interface AcpWorkerState {
	sessionId: string;
	sessionFile?: string;
}

/** One isolated native process serving one ACP session. */
export interface AcpWorkerClient {
	start(): Promise<void>;
	stop(): Promise<void>;
	getState(): Promise<AcpWorkerState>;
	persistSession(): Promise<void>;
	/**
	 * Resolves with the host's disposition of the prompt; `handled` means a command consumed it. A prompt refused because
	 * the worker has no usable provider credentials rejects with an error whose `authRequired` is true.
	 */
	prompt(
		message: string,
		images?: ImageContent[],
		streamingBehavior?: "steer" | "followUp",
		options?: { waitForCompletion?: boolean; dispatchId?: string },
	): Promise<string>;
	abort(): Promise<void>;
	onEvent(listener: (event: AcpWorkerEvent) => void): () => void;
	onClose(listener: (error: Error) => void): () => void;
	onExtensionUIRequest(listener: (request: AcpUiRequest) => void): () => void;
	respondToExtensionUIRequest(response: AcpUiResponse): Promise<void>;
	/** The slash commands a prompt can run in this session. */
	getCommands(): Promise<Array<{ name: string; description?: string; argumentHint?: string }>>;
}

/** What the broker passes to start a worker. */
export interface AcpWorkerLaunch {
	cwd: string;
	/** Arguments after the host's own executable prefix. */
	args: string[];
	env: Record<string, string>;
	/** Called with the canonical session id the worker announces before its extensions start. */
	onSessionIdentity(id: string): void;
}

/** A saved session as listed by the host's transcript index. */
export interface AcpSessionInfo {
	id: string;
	path: string;
	cwd: string;
	name?: string;
	firstMessage: string;
	modified: Date;
}

/** One entry of a transcript branch that a replay shows. */
export type AcpTranscriptEntry =
	| { type: "compaction"; id: string; summary: string; tokensBefore: number }
	| { type: "message"; message: AcpMessage };

/** The ordered current branch of an opened transcript. */
interface AcpTranscript {
	sessionId: string;
	branch: AcpTranscriptEntry[];
}

/** The command-line options that select a session or a one-shot action; ACP owns session selection, so they are refused. */
export interface AcpLaunchOptions {
	messages: readonly unknown[];
	fileArgs: readonly unknown[];
	print?: boolean;
	continue?: boolean;
	resume?: boolean;
	session?: string;
	sessionId?: string;
	noSession?: boolean;
	fork?: string;
	export?: string;
	listModels?: unknown;
}

/** What the inbound broker (`runAcpMode`, `AcpBroker`) needs from its host. */
export interface AcpServerHost {
	/** Reported to the client as the agent's version. */
	readonly version: string;
	/** The environment variable that names the shared session directory. */
	readonly sessionDirEnv: string;
	/** The host's agent directory: where user MCP configuration lives. */
	agentDir(): string;
	/** The Node executable a generated MCP launcher runs under. */
	nodeRuntime(): string;
	/** The session directory the settings of `cwd` choose, when they choose one. */
	configuredSessionDir(cwd: string): string | undefined;
	/**
	 * Whether the user trusts the folder a session would open in. A client cannot grant trust, so an untrusted folder is
	 * a per-session error; `command` is what the user can run to trust it. Nothing of the folder is read.
	 */
	folderTrust(cwd: string): { trusted: true } | { trusted: false; message: string; command: string };
	/** Saved sessions of `cwd` (or of every directory) in `sessionDir`, newest first. */
	listSessions(cwd: string | undefined, sessionDir: string | undefined): Promise<AcpSessionInfo[]>;
	/** The current branch of the transcript at `path`; throws when it cannot be read. */
	openTranscript(path: string): AcpTranscript;
	/** A compaction summary as Markdown a person reads. */
	compactionSummaryText(summary: string, tokensBefore: number): string;
	/** Owns stdout for the protocol stream: nothing else may write to it afterwards. */
	readonly stdout: {
		takeOver(): void;
		write(text: string): Promise<void>;
		flush(): Promise<void>;
	};
	/** Starts a native worker process (not yet running; `start()` runs it). */
	createWorker(launch: AcpWorkerLaunch): AcpWorkerClient;
}

/** The part of the host the broker itself uses: identity, saved sessions and the compaction summary format. */
export type AcpBrokerHost = Pick<
	AcpServerHost,
	| "version"
	| "sessionDirEnv"
	| "configuredSessionDir"
	| "folderTrust"
	| "listSessions"
	| "openTranscript"
	| "compactionSummaryText"
>;
