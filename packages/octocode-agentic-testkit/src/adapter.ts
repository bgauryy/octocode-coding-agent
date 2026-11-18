import type { SandboxOptions } from "./sandbox.ts";

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
	/** Files written into the workspace before the first run (relative path -> content). */
	files?: Record<string, string>;
}

/** One run of a session: the prompts of consecutive turns, plus per-run overrides. */
export interface RunInput {
	prompts: string[];
	/** Extra environment for this run only. */
	env?: Record<string, string>;
	timeoutMs?: number;
}

export interface AgentSession<R = unknown> {
	/** Runs the harness once with the prompt(s); `R` is whatever the adapter can report about the run. */
	run(input: string | RunInput): Promise<R>;
	/** Releases everything `start` acquired (processes, temp directories). */
	close(): Promise<void>;
}

/** The only seam between the testkit and a harness: the testkit never learns how a harness is configured. */
export interface AgentAdapter<R = unknown> {
	name: string;
	/** Why the harness cannot run here (CLI or bundle missing), or undefined; suites skip with the reason. */
	unavailable?(): string | undefined;
	start(ctx: AdapterContext): Promise<AgentSession<R>>;
}

/** Returns `adapter` unchanged, typed: an inline adapter object infers its run result `R` from `start`. */
export function defineAdapter<R>(adapter: AgentAdapter<R>): AgentAdapter<R> {
	return adapter;
}

/** Normalizes `run`'s argument. */
export function runInput(input: string | RunInput): RunInput {
	return typeof input === "string" ? { prompts: [input] } : input;
}

/** The single prompt of a run, for adapters whose harness takes one prompt per process. */
export function singlePrompt(adapter: string, input: string | RunInput): RunInput & { prompt: string } {
	const i = runInput(input);
	if (i.prompts.length !== 1) throw new Error(`${adapter} adapter: one prompt per run`);
	return { ...i, prompt: i.prompts[0] };
}

/**
 * The sandbox a CLI adapter runs its harness in. An explicit option wins (`false` opts out). Without one, the
 * harness is sandboxed when the testkit gateway at `gatewayUrl` forwards to a real model: a real model must not run
 * commands on the host. A scripted gateway, or an endpoint that is not a testkit gateway, runs unsandboxed; pass
 * `sandbox: {}` for any other real endpoint. A sandbox that cannot start fails the run, never falls back.
 */
export async function sandboxFor(
	option: false | SandboxOptions | undefined,
	ctx: AdapterContext,
	root: string,
): Promise<false | SandboxOptions> {
	if (option === false) return false;
	if (option) return { root, ...option };
	return (await gatewayForwards(ctx.gatewayUrl)) ? { root } : false;
}

/** Whether a testkit gateway forwards to a real upstream (`GET /testkit`); false for any other endpoint. */
export async function gatewayForwards(gatewayUrl: string): Promise<boolean> {
	try {
		const r = await fetch(`${gatewayUrl.replace(/\/$/, "")}/testkit`, { signal: AbortSignal.timeout(2_000) });
		if (!r.ok) return false;
		return ((await r.json()) as { forwarding?: unknown }).forwarding === true;
	} catch (e) {
		// Not a reachable testkit gateway: nothing to infer, so the default stays unsandboxed.
		if (e instanceof TypeError || (e instanceof DOMException && e.name === "TimeoutError")) return false;
		throw e;
	}
}
