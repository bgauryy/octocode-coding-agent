import type { ChildProcess } from "node:child_process";

/** One JSON-RPC message as it crossed the wire. */
export interface WireMessage {
	jsonrpc?: string;
	id?: number | string | null;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { code: number; message: string; data?: Record<string, unknown> };
}

export interface SessionUpdate {
	sessionUpdate?: string;
	toolCallId?: string;
	title?: string;
	kind?: string;
	name?: string;
	status?: string;
	content?: unknown;
	_meta?: Record<string, unknown>;
}

/** The answer a permission request gets: an option kind's prefix, or a cancellation. */
export type PermissionAnswer = "allow" | "reject" | "cancelled" | "hold";

/**
 * A plain ACP client on a process's pipes, on purpose not the SDK: it sends what a test tells it, malformed lines
 * included, and keeps every stdout line, so a test can check that nothing but protocol reached stdout.
 */
export function acpClient(child: ChildProcess, answer: PermissionAnswer = "allow") {
	const lines: string[] = [];
	const received: WireMessage[] = [];
	const updates: Array<{ sessionId: string; update: SessionUpdate; at: number }> = [];
	const permissions: WireMessage[] = [];
	const pending = new Map<number, (message: WireMessage) => void>();
	const responses: WireMessage[] = [];
	let buffer = "";
	let next = 1;
	let sequence = 0;
	const write = (text: string) => child.stdin?.write(`${text}\n`);
	const send = (message: Record<string, unknown>) => write(JSON.stringify({ jsonrpc: "2.0", ...message }));
	const answers = { current: answer };
	const respondPermission = (
		id: unknown,
		reply: PermissionAnswer,
		options: Array<{ optionId: string; kind: string }>,
	) => {
		if (reply === "cancelled") return send({ id, result: { outcome: { outcome: "cancelled" } } });
		const option = options.find((candidate) => candidate.kind.startsWith(reply));
		return send({ id, result: { outcome: { outcome: "selected", optionId: option?.optionId } } });
	};
	child.stdout?.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			lines.push(line);
			let message: WireMessage;
			try {
				message = JSON.parse(line) as WireMessage;
			} catch {
				continue;
			}
			received.push(message);
			if (message.method === "session/update") {
				updates.push({
					sessionId: String(message.params?.sessionId),
					update: message.params?.update as SessionUpdate,
					at: sequence++,
				});
			} else if (message.method === "session/request_permission") {
				permissions.push(message);
				if (answers.current !== "hold")
					respondPermission(
						message.id,
						answers.current,
						message.params?.options as Array<{ optionId: string; kind: string }>,
					);
			} else if (message.id !== undefined && message.method === undefined) {
				responses.push(message);
				if (typeof message.id === "number") pending.get(message.id)?.(message);
			}
		}
	});
	/** Sends a request and resolves with its whole response, error or not. */
	const raw = (method: string, params: unknown = {}) =>
		new Promise<WireMessage>((resolve) => {
			const id = next++;
			pending.set(id, resolve);
			send({ id, method, params });
		});
	/** Sends a request and throws when it fails. */
	const request = async <T = Record<string, unknown>>(method: string, params: unknown = {}): Promise<T> => {
		const response = await raw(method, params);
		if (response.error) throw new Error(`${method}: ${JSON.stringify(response.error)}`);
		return (response.result ?? {}) as T;
	};
	const notify = (method: string, params: unknown = {}) => send({ method, params });
	const said = () =>
		updates
			.filter(({ update }) => update.sessionUpdate === "agent_message_chunk")
			.map(({ update }) => (update.content as { text?: string } | undefined)?.text ?? "")
			.join("");
	const prompt = (sessionId: string, text: string) =>
		request<{ stopReason: string }>("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
	return {
		lines,
		received,
		responses,
		updates,
		permissions,
		answers,
		write,
		send,
		raw,
		request,
		notify,
		said,
		prompt,
		respondPermission,
	};
}

export const initialize = { protocolVersion: 1, clientCapabilities: {} };
