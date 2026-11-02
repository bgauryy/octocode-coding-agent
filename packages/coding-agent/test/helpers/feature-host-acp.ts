import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";
import {
	client,
	methods,
	ndJsonStream,
	PROTOCOL_VERSION,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import { getCliInvocation } from "../../src/config.ts";
import { QUIET_ARGS, SCRIPTED_MODEL_ARGS, type Sandbox } from "./feature-host-cli.ts";

/**
 * An ACP client attached to a real `octocode --mode acp` process in a sandbox (see `feature-host-cli.ts`), with the
 * scripted model selected. `permission` answers the agent's `session/request_permission` calls.
 */
export type AcpConnection = ReturnType<ReturnType<typeof client>["connect"]>;

export interface AcpAgent {
	child: ChildProcessWithoutNullStreams;
	connection: AcpConnection;
	/** Every `session/update` notification received, in order. */
	updates: SessionNotification[];
	/** Everything the process wrote to stdout and stderr so far. */
	output(): string;
	diagnostics(): string;
	exited: Promise<[number | null, NodeJS.Signals | null]>;
	initialize(): Promise<void>;
	newSession(): Promise<string>;
	prompt(sessionId: string, text: string): ReturnType<AcpConnection["agent"]["request"]>;
	/** Closes the connection and the process's stdin, and waits for it to exit (killing it after `graceMs`). */
	stop(graceMs?: number): Promise<void>;
}

export interface AcpAgentOptions {
	/** Extra CLI arguments after the quiet and scripted-model ones. */
	args?: string[];
	permission?: (
		params: RequestPermissionRequest,
		agent: AcpAgent,
	) => RequestPermissionResponse | Promise<RequestPermissionResponse>;
}

/** The outcome that selects the first option of `kind`. */
export function choose(
	params: RequestPermissionRequest,
	kind: "allow_once" | "reject_once",
): RequestPermissionResponse {
	const option = params.options.find((candidate) => candidate.kind === kind);
	if (!option) throw new Error(`No ${kind} option in ${JSON.stringify(params.options)}`);
	return { outcome: { outcome: "selected", optionId: option.optionId } };
}

/** The assistant text the updates carry, joined. */
export function agentText(updates: readonly SessionNotification[]): string {
	return updates
		.flatMap(({ update }) =>
			update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? [update.content.text] : [],
		)
		.join("");
}

export function startAcpAgent(sandbox: Sandbox, options: AcpAgentOptions = {}): AcpAgent {
	const invocation = getCliInvocation();
	const child = spawn(
		invocation.command,
		[...invocation.prefix, "--mode", "acp", ...QUIET_ARGS, ...SCRIPTED_MODEL_ARGS, ...(options.args ?? [])],
		{ cwd: sandbox.project, stdio: ["pipe", "pipe", "pipe"], env: sandbox.env },
	);
	let output = "";
	let diagnostics = "";
	child.stdout.on("data", (part) => (output += part.toString()));
	child.stderr.on("data", (part) => (diagnostics += part.toString()));
	// A client that closes only one pipe, or exits first, must not surface as an unhandled stream error.
	child.stdin.on("error", () => {});
	const exited = once(child, "close") as AcpAgent["exited"];
	const updates: SessionNotification[] = [];
	const agent = {} as AcpAgent;
	const connection = client({ name: "feature-host-acp-test" })
		.onNotification(methods.client.session.update, ({ params }) => {
			updates.push(params);
		})
		.onRequest(methods.client.session.requestPermission, async ({ params }) => {
			if (!options.permission) throw new Error("Unexpected permission request");
			return options.permission(params, agent);
		})
		.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
	Object.assign(agent, {
		child,
		connection,
		updates,
		output: () => output,
		diagnostics: () => diagnostics,
		exited,
		initialize: async () => {
			await connection.agent.request(methods.agent.initialize, {
				protocolVersion: PROTOCOL_VERSION,
				clientCapabilities: {},
			});
		},
		newSession: async () =>
			(await connection.agent.request(methods.agent.session.new, { cwd: sandbox.project, mcpServers: [] })).sessionId,
		prompt: (sessionId: string, text: string) =>
			connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] }),
		stop: async (graceMs = 15_000) => {
			connection.close();
			child.stdin.end();
			const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
			try {
				await exited;
			} finally {
				clearTimeout(timer);
			}
		},
	} satisfies Partial<AcpAgent>);
	return agent;
}
