import {
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type Provider,
	type StreamOptions,
	type TranscriptContext,
} from "@octocodeai/octocode-ai";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { ClaudeCodeLaunch } from "./launch.ts";
import { type CLAUDE_CODE_API, CLAUDE_CODE_MODELS, CLAUDE_CODE_PLAN, CLAUDE_CODE_PROVIDER } from "./models.ts";
import { Segment } from "./segment.ts";
import { ClaudeCodeSession } from "./session.ts";

const SOURCE = "Claude Code's own sign-in";

/** The provider, and the session its requests belong to. */
export interface ClaudeCodeBackend {
	provider: Provider<typeof CLAUDE_CODE_API>;
	/**
	 * The Octocode session whose requests reuse one Claude Code session, and the folder Claude Code works in. A different
	 * session closes the adapters of the one before.
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
 * The `claude-code` provider: Claude Code, signed in with its own login, runs each turn of Octocode's agent loop and
 * calls Octocode's tools over MCP. The loop's requests in the bound session continue that session's Claude Code session;
 * any other request (a summary, a side call) runs once in a session of its own, without tools, closed when it ends.
 */
export function createClaudeCodeBackend(launch: ClaudeCodeLaunch, signedOut?: () => void): ClaudeCodeBackend {
	const sessions = new Map<string, ClaudeCodeSession>();
	let bound: { id: string; cwd: string } | undefined;
	let turn = false;

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
		let session = own ? sessions.get(id) : undefined;
		if (!session) {
			session = new ClaudeCodeSession({ launch, cwd, tools: own, ...(signedOut ? { signedOut } : {}) });
			if (own) sessions.set(id, session);
		}
		try {
			await session.segment(model, context.messages, options?.signal ?? new AbortController().signal, out);
		} catch (error) {
			out.fail("error", `Claude Code failed: ${errorMessage(error)}`);
		} finally {
			if (!own) await session.close();
		}
	};

	const start = (model: Model<string>, context: TranscriptContext, options?: StreamOptions) => {
		const stream = createAssistantMessageEventStream();
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
			id: CLAUDE_CODE_PROVIDER,
			name: "Claude Code",
			auth: {
				apiKey: {
					name: SOURCE,
					check: async () => ({ type: "api_key", source: SOURCE }),
					resolve: async () => ({ auth: {}, source: SOURCE }),
				},
				plan: CLAUDE_CODE_PLAN,
			},
			getModels: () => CLAUDE_CODE_MODELS,
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
