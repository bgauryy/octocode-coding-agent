/** The model an external agent runs on and the ids its model option accepts, when its protocol reports them. */
export interface ExternalModels {
	current?: string;
	available: string[];
}

export interface ExternalReply {
	text: string;
	stopReason?: string;
	updates?: unknown[];
	/** The reply's message id on the remote Octocode instance, when the transport reports one. */
	remoteMessageId?: string;
	/** The session's token totals so far, when the agent reports them with its reply (ACP's prompt response `usage`). */
	usage?: ExternalUsage;
}

/** Token totals an external agent reports for its session; counts it leaves out are absent. */
export interface ExternalUsage {
	inputTokens: number;
	outputTokens: number;
	cachedReadTokens?: number;
	cachedWriteTokens?: number;
	totalTokens?: number;
}

/** One live connection to an external agent: the shape the host's `agent` `external` action drives and each transport implements. */
export interface ExternalBackend {
	readonly sessionId: string;
	readonly cwd: string;
	/** Explicit liveness lets a transport retain a connection after an uncertain prompt failure. */
	readonly isClosed?: boolean;
	/** Remote work may remain active after the local prompt waiter times out. */
	readonly isBusy?: boolean;
	/** The agent's current model and the ids it accepts; it can change while the connection is open. */
	readonly models?: ExternalModels;
	prompt(text: string, options: { timeoutMs: number; signal?: AbortSignal; key?: string }): Promise<ExternalReply>;
	cancel(): Promise<void>;
	close(): Promise<void>;
}
