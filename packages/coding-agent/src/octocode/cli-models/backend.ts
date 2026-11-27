import {
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type Provider,
	type StreamOptions,
	type TranscriptContext,
} from "@octocodeai/octocode-ai";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { AcpModelSession } from "./acp-session.ts";
import { runCliTurn } from "./cli-session.ts";
import type { CliModelRoute } from "./route.ts";
import { Segment } from "./segment.ts";

/** The provider, and the session its requests belong to. */
export interface RouteBackend {
	provider: Provider;
	/**
	 * The Octocode session whose requests reuse one agent session, and the folder the agent works in. A different session
	 * closes the agent sessions of the one before.
	 */
	bind(sessionId: string, cwd: string): Promise<void>;
	/**
	 * The agent loop is about to send a request (its `context` event): the next request of the bound session is a turn.
	 * Any other request with that session id (a compaction summary shares it for its cache) runs on its own.
	 */
	markTurn(): void;
	close(): Promise<void>;
}

/**
 * A provider backed by an external CLI or ACP agent signed in with its own login. On an `acp` route the loop's requests
 * in the bound session continue that session's ACP session and call Octocode's tools over MCP; any other request (a
 * summary, a side call) runs once in a session of its own, without tools, closed when it ends. A `cli` route runs every
 * request as a process of its own. A route with `plan.disabled` is unavailable: the runtime offers none of its models.
 */
export function createRouteBackend(route: CliModelRoute): RouteBackend {
	const sessions = new Map<string, AcpModelSession>();
	let bound: { id: string; cwd: string } | undefined;
	let turn = false;
	const source = `${route.name}'s own sign-in`;

	const run = async (
		model: Model<string>,
		context: TranscriptContext,
		options: StreamOptions | undefined,
		stream: AssistantMessageEventStream,
	) => {
		const out = new Segment(stream, model);
		const id = options?.sessionId;
		const own = id !== undefined && id === bound?.id && turn;
		turn = false;
		const cwd = bound?.cwd ?? process.cwd();
		const signal = options?.signal ?? new AbortController().signal;
		if (route.plan.disabled) return out.fail("error", `${route.name} is unavailable: ${route.plan.disabled}`);
		const changed = route.recheck?.();
		if (changed) return out.fail("error", `${route.name} is unavailable: ${changed}`);
		if (route.kind === "cli") return runCliTurn(route, model, context.messages, cwd, signal, out);
		let session = own ? sessions.get(id) : undefined;
		if (!session) {
			session = new AcpModelSession({ route, cwd, tools: own });
			if (own) sessions.set(id, session);
		}
		try {
			await session.segment(model, context.messages, signal, out);
		} catch (error) {
			out.fail("error", `${route.name} failed: ${errorMessage(error)}`);
		} finally {
			if (!own) await session.close();
		}
	};

	const start = (model: Model<string>, context: TranscriptContext, options?: StreamOptions) => {
		const stream = createAssistantMessageEventStream();
		// `run` settles every failure into the stream: it never rejects.
		void run(model, context, options, stream);
		return stream;
	};

	const closeAll = async (keep?: string) => {
		const closing = [...sessions].filter(([id]) => id !== keep);
		for (const [id] of closing) sessions.delete(id);
		await Promise.all(closing.map(([, session]) => session.close()));
	};

	return {
		provider: {
			id: route.provider,
			name: route.name,
			auth: {
				apiKey: {
					name: source,
					check: async () => ({ type: "api_key", source }),
					resolve: async () => ({ auth: {}, source }),
				},
				plan: route.plan,
			},
			getModels: () => route.models,
			stream: (model, context, options) => start(model, context, options),
			streamSimple: (model, context, options) => start(model, context, options),
		},
		bind: async (sessionId, cwd) => {
			bound = { id: sessionId, cwd };
			await closeAll(sessionId);
		},
		markTurn: () => {
			turn = true;
		},
		close: () => closeAll(),
	};
}
