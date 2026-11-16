/** What a harness under test needs to know to talk to the testkit's probes. */
export interface AdapterContext {
	/** Model gateway origin (`Gateway.url`): point the harness's model base URL here. */
	gatewayUrl: string;
	/** Mock MCP servers by name -> URL (`MockMcp.listen()`); the adapter registers them with the harness. */
	mcpUrls?: Record<string, string>;
	/** Working directory of the harness; the adapter creates a temporary one when omitted. */
	workdir?: string;
	/** Extra environment for the harness process. */
	env?: Record<string, string>;
}

export interface AgentSession<R = unknown> {
	/** Runs the harness once with the prompt; `R` is whatever the adapter can report about the run. */
	run(prompt: string): Promise<R>;
	/** Releases everything `start` acquired (processes, temp directories). */
	close(): Promise<void>;
}

/** The only seam between the testkit and a harness: the testkit never learns how a harness is configured. */
export interface AgentAdapter<R = unknown> {
	name: string;
	start(ctx: AdapterContext): Promise<AgentSession<R>>;
}
