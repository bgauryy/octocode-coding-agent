import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@octocodeai/octocode-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@octocodeai/octocode-ai/compat";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import type { ApplicationConnection, ApplicationFrame } from "@octocodeai/octocode-contracts";
import { expect, it } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { getApplicationPortForSession } from "../src/core/application/index.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

function message(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 101,
	};
}
async function until(connection: ApplicationConnection, type: string): Promise<ApplicationFrame> {
	const iterator = connection[Symbol.asyncIterator]();
	for (;;) {
		const { value: frame, done } = await iterator.next();
		if (done) throw new Error(`Stream closed before ${type}`);
		if (frame.type === "event" && frame.event.type === type) return frame;
	}
}

it.each([false, true])("streams one engine run and preserves late attachment (headless=%s)", async (headless) => {
	const directory = mkdtempSync(join(tmpdir(), "application-engine-"));
	let session: AgentSession | undefined;
	try {
		let invocations = 0;
		let signal: AbortSignal | undefined;
		let ready!: () => void;
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const stream = createAssistantMessageEventStream();
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: getBuiltinModel("anthropic", "claude-sonnet-4-5"),
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: (_model, _context, options) => {
				invocations++;
				signal = options?.signal;
				signal?.addEventListener(
					"abort",
					() =>
						stream.push({
							type: "error",
							reason: "aborted",
							error: { ...message("Aborted"), stopReason: "aborted" },
						}),
					{ once: true },
				);
				ready();
				return stream;
			},
		});
		const auth = AuthStorage.create(join(directory, "auth.json"));
		await auth.modify("anthropic", async () => ({
			type: "api_key",
			key: "test-key",
		}));
		const registry = await createModelRegistry(auth, directory);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.create(directory, directory),
			cwd: directory,
			modelRuntime: getModelRuntime(registry),
			resourceLoader: createTestResourceLoader(),
		});
		const id = session.sessionId;
		const port = getApplicationPortForSession(id);
		expect(port).toBeDefined();
		if (headless) {
			let observed!: () => void;
			const deltaObserved = new Promise<void>((resolve) => {
				observed = resolve;
			});
			const detach = session.subscribe((event) => {
				if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") observed();
			});
			const running = session.prompt("Show headless progress");
			await started;
			stream.push({ type: "start", partial: message("") });
			stream.push({
				type: "text_delta",
				contentIndex: 0,
				delta: "Headless partial",
				partial: message("Headless partial"),
			});
			await deltaObserved;
			detach();
			const frame = (await port!.connect()[Symbol.asyncIterator]().next()).value;
			expect(frame.snapshot.runId).toEqual(expect.any(String));
			// A late view sees the text released so far: the unfinished last word waits until it is proven free of a secret.
			expect(frame.snapshot.messages).toContainEqual(
				expect.objectContaining({
					text: "Headless ",
					complete: false,
				}),
			);
			stream.push({
				type: "done",
				reason: "stop",
				message: message("Headless done"),
			});
			await running;
			expect(invocations).toBe(1);
			session.dispose();
			session = undefined;
			expect(getApplicationPortForSession(id)).toBeUndefined();
			return;
		}
		const native: AgentSessionEvent[] = [];
		port!.subscribeNative((event) => native.push(event));
		const first = port!.connect();
		const second = port!.connect();
		const running = port!.invoke("prompt", "Show progress");
		await started;
		stream.push({ type: "start", partial: message("") });
		stream.push({
			type: "text_start",
			contentIndex: 0,
			partial: message(""),
		});
		stream.push({
			type: "text_delta",
			contentIndex: 0,
			delta: "Partial output",
			partial: message("Partial output"),
		});
		const [a, b] = await Promise.all([until(first, "message.delta"), until(second, "message.delta")]);
		expect(a).toEqual(b);
		expect(a).toMatchObject({
			type: "event",
			event: { type: "message.delta", delta: "Partial ", block: { index: 0, length: 0 } },
		});
		expect(
			native.some(
				(event) =>
					event.type === "message_update" &&
					event.assistantMessageEvent.type === "text_delta" &&
					event.assistantMessageEvent.delta === "Partial output",
			),
		).toBe(true);
		expect(native.some((event) => event.type === "agent_settled")).toBe(false);
		expect(invocations).toBe(1);
		first.close();
		expect(signal?.aborted).toBe(false);
		stream.push({
			type: "text_end",
			contentIndex: 0,
			content: "Partial output finished",
			partial: message("Partial output finished"),
		});
		stream.push({
			type: "done",
			reason: "stop",
			message: message("Partial output finished"),
		});
		await running;
		expect(await until(second, "message.completed")).toMatchObject({
			type: "event",
			event: { message: { text: "Partial output finished", complete: true } },
		});
		expect(await until(second, "run.settled")).toMatchObject({
			type: "event",
			event: { aborted: false },
		});
		const final = (await port!.connect()[Symbol.asyncIterator]().next()).value;
		expect(
			final.snapshot.messages.some(
				(item: { text: string; complete: boolean }) => item.text === "Partial output finished" && item.complete,
			),
		).toBe(true);
		expect(invocations).toBe(1);
		session.dispose();
		session = undefined;
		expect(getApplicationPortForSession(id)).toBeUndefined();
	} finally {
		if (session) {
			await session.abort();
			session.dispose();
		}
		rmSync(directory, { recursive: true, force: true });
	}
});
