/** Which tool call a server's request for user input belongs to: the latest call still waiting on that connection. */

import type { McpContext } from "./host/types.ts";

/** A tool call in flight: where its session shows questions, and a signal aborted when the call ends. */
interface McpCallContext {
	ctx: McpContext;
	signal: AbortSignal;
}

const inFlight = new WeakMap<object, McpCallContext[]>();

/** Run a tool call on `connection`, known as waiting there with `ctx` until it settles. */
export async function withCallContext<T>(connection: object, ctx: McpContext, run: () => Promise<T>): Promise<T> {
	const ended = new AbortController();
	const call: McpCallContext = { ctx, signal: ended.signal };
	const calls = inFlight.get(connection) ?? [];
	inFlight.set(connection, calls);
	calls.push(call);
	try {
		return await run();
	} finally {
		calls.splice(calls.indexOf(call), 1);
		ended.abort();
	}
}

/** The latest tool call still waiting on `connection`; undefined when none is. */
export function callContext(connection: object): McpCallContext | undefined {
	return inFlight.get(connection)?.at(-1);
}
