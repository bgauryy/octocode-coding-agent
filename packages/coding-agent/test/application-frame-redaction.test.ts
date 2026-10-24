import { expect, it } from "vitest";
import type { ApplicationEvent, ApplicationFrame } from "@octocodeai/octocode-contacts";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { ApplicationService } from "../src/core/application/index.ts";

it("redacts credentials from rich frames and reconnect snapshots without changing canonical or native data", async () => {
	const secret = `ghp_${"a1B2c3D4e5".repeat(4)}`;
	let emit!: (event: AgentSessionEvent) => void;
	const session = {
		sessionId: "redaction",
		messages: [],
		isStreaming: false,
		subscribe(listener: typeof emit) {
			emit = listener;
			return () => {};
		},
	} as unknown as AgentSession;
	const service = new ApplicationService(session);
	const canonical: ApplicationEvent[] = [];
	const native: AgentSessionEvent[] = [];
	service.subscribe((event) => canonical.push(event));
	service.subscribeNative((event) => native.push(event));
	const connection = service.connect();
	const stream = connection[Symbol.asyncIterator]();
	await stream.next();
	try {
		const args = { path: "src/login.ts", nested: { credential: secret, retries: 3 } };
		emit({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args });
		const frame = (await stream.next()).value as ApplicationFrame;
		expect(frame).toMatchObject({
			type: "event",
			event: {
				type: "tool.started",
				toolCallId: "read-1",
				toolName: "read",
				arguments: { path: "src/login.ts", nested: { credential: "[redacted]", retries: 3 } },
			},
		});
		expect(JSON.stringify(canonical[0])).toContain(secret);
		expect(native[0]).toMatchObject({ args });
		expect(args.nested.credential).toBe(secret);
		emit({
			type: "tool_execution_end",
			toolCallId: "read-1",
			toolName: "read",
			isError: false,
			result: {
				content: [{ type: "text", text: `Result ${secret}` }],
				structuredContent: { count: 2, token: secret },
				details: { path: "src/login.ts", token: secret },
			},
		});
		const completed = (await stream.next()).value;
		expect(JSON.stringify(completed)).not.toContain(secret);
		expect(completed).toMatchObject({
			event: {
				structuredContent: { count: 2, token: "[redacted]" },
				details: { path: "src/login.ts", token: "[redacted]" },
			},
		});
		const reopened = service.connect();
		try {
			const snapshot = (await reopened[Symbol.asyncIterator]().next()).value;
			expect(JSON.stringify(snapshot)).not.toContain(secret);
			expect(snapshot).toMatchObject({
				snapshot: {
					tools: [
						expect.objectContaining({
							arguments: { path: "src/login.ts", nested: { credential: "[redacted]", retries: 3 } },
						}),
					],
				},
			});
		} finally {
			reopened.close();
		}
		const resumed = service.connect({ cursor: frame.cursor });
		try {
			const replay = resumed[Symbol.asyncIterator]();
			expect((await replay.next()).value).toMatchObject({ type: "resumed" });
			expect(JSON.stringify((await replay.next()).value)).not.toContain(secret);
		} finally {
			resumed.close();
		}
	} finally {
		connection.close();
		service.dispose();
	}
});
