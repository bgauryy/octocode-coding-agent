import type { AssistantMessage, ImageContent } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionShutdownEvent } from "../src/core/features/index.ts";
import { createRunOutcome, recordRunMessage, type RunOutcome } from "../src/core/agent-session/run-outcome.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";

type EmitEvent = SessionShutdownEvent;

type FakeFeatureHost = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	sessionManager: { getHeader: () => object | undefined };
	agent: { waitForIdle: () => Promise<void>; subscribe: ReturnType<typeof vi.fn> };
	state: { messages: AssistantMessage[] };
	readonly lastRunOutcome: RunOutcome | undefined;
	featureHost: FakeFeatureHost;
	bindFeatures: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	settled: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

/** The outcome the run loop records, derived per message so each fake run reports a new object as a real one does. */
const outcomes = new WeakMap<AssistantMessage, RunOutcome>();
function outcomeOf(message: AssistantMessage | undefined): RunOutcome | undefined {
	if (!message) return undefined;
	let outcome = outcomes.get(message);
	if (!outcome) {
		outcome = createRunOutcome();
		recordRunMessage(outcome, message);
		outcomes.set(message, outcome);
	}
	return outcome;
}

function createRuntimeHost(assistantMessage: AssistantMessage): FakeRuntimeHost {
	const featureHost: FakeFeatureHost = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: [assistantMessage] };

	const session: FakeSession = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {}, subscribe: vi.fn(() => () => {}) },
		state,
		get lastRunOutcome() {
			return outcomeOf(state.messages.at(-1));
		},
		featureHost,
		bindFeatures: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		settled: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.featureHost.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runPrintMode", () => {
	it("writes one stderr line for each retry wait in text mode, and none in json mode", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const retry = {
			type: "auto_retry_start",
			attempt: 2,
			maxAttempts: 5,
			delayMs: 1500,
			errorMessage: "503\nservice unavailable",
		};
		for (const mode of ["text", "json"] as const) {
			error.mockClear();
			const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
			runtimeHost.session.subscribe.mockImplementation((listener: (event: unknown) => void) => {
				listener(retry);
				return () => {};
			});
			await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
				mode,
				initialMessage: "go",
			});
			if (mode === "text") {
				expect(error.mock.calls).toEqual([["Retrying in 2s (attempt 2 of 5): 503 service unavailable"]]);
			} else expect(error).not.toHaveBeenCalled();
		}
	});

	it("releases the session and exits 1 when stdout fails", async () => {
		vi.resetModules();
		const { runPrintMode: fresh } = await import("../src/modes/print-mode.ts");
		const write = vi.spyOn(process.stdout, "write").mockImplementation(((
			_text: string,
			callback: (e: Error) => void,
		) => {
			callback(Object.assign(new Error("closed"), { code: "EPIPE" }));
			return false;
		}) as never);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const exited = Promise.withResolvers<number | undefined>();
		const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exited.resolve(code);
		}) as never);
		try {
			const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
			await fresh(runtimeHost as unknown as Parameters<typeof fresh>[0], { mode: "text", initialMessage: "go" });
			await expect(exited.promise).resolves.toBe(1);
			expect(runtimeHost.dispose).toHaveBeenCalledTimes(1);
			expect(error.mock.calls.flat().join("\n")).toContain("stdout failed: closed");
		} finally {
			write.mockRestore();
			exit.mockRestore();
		}
	});

	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images });
		expect(session.featureHost.emit).toHaveBeenCalledTimes(1);
		expect(session.featureHost.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("fails when a message a command sent could not go out, and fails open on other feature errors", async () => {
		type FeatureError = { source: string; event: string; error: string };
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const run = async (failure: FeatureError) => {
			const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "" }));
			let onError: ((err: FeatureError) => void) | undefined;
			runtimeHost.session.bindFeatures.mockImplementation(async (bindings: { onError: typeof onError }) => {
				onError = bindings.onError;
			});
			// `/plan add ...` with no model: the command runs, then the turn it asks for cannot start.
			runtimeHost.session.prompt.mockImplementation(async () => onError?.(failure));
			return runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
				mode: "text",
				initialMessage: "/plan add a retry",
			});
		};
		const noModel = "No model selected. Run `octocode` and type /providers to connect one.";
		expect(await run({ source: "<runtime>", event: "send_message", error: noModel })).toBe(1);
		expect(error).toHaveBeenCalledWith(noModel);
		expect(await run({ source: "<runtime>", event: "send_user_message", error: noModel })).toBe(1);
		expect(await run({ source: "timer", event: "turn_end", error: "boom" })).toBe(0);
		expect(error).toHaveBeenLastCalledWith("Feature error (timer): boom");
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello");
		expect(session.featureHost.emit).toHaveBeenCalledTimes(1);
		expect(session.featureHost.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.featureHost.emit).toHaveBeenCalledTimes(1);
		expect(session.featureHost.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("names the failed provider, model and endpoint in the final line, as the retry lines do", async () => {
		const failed = createAssistantMessage({ stopReason: "error", errorMessage: "fetch failed" });
		const runtimeHost = createRuntimeHost(failed);
		const outcome = createRunOutcome();
		recordRunMessage(
			outcome,
			failed,
			(message) => `${message.provider}/${message.model} at llm.internal:8080: fetch failed`,
		);
		Object.defineProperty(runtimeHost.session, "lastRunOutcome", { get: () => outcome });
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});
		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("openai/gpt-4o-mini at llm.internal:8080: fetch failed");
		expect(errorSpy).not.toHaveBeenCalledWith("fetch failed");
	});

	it("returns non-zero in json mode when the run failed", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		vi.spyOn(console, "error").mockImplementation(() => {});
		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});
		expect(exitCode).toBe(1);
	});

	it("returns non-zero when an earlier prompt failed and a later one succeeded", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "unused" }));
		const replies = [
			createAssistantMessage({ stopReason: "error", errorMessage: "first failed" }),
			createAssistantMessage({ text: "second ok" }),
		];
		runtimeHost.session.state.messages = [];
		runtimeHost.session.prompt = vi.fn(async () => {
			runtimeHost.session.state.messages.push(replies.shift()!);
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			messages: ["one", "two"],
		});
		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("first failed");
	});

	it("judges a prompt only once what its run left behind has settled", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "unused" }));
		runtimeHost.session.state.messages = [];
		const { session } = runtimeHost;
		// The compaction an extension asked for as the run settled fails only after `prompt` has returned.
		session.settled = vi.fn(async () => {
			session.state.messages.push(createAssistantMessage({ stopReason: "error", errorMessage: "late failure" }));
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			messages: ["hello"],
		});
		expect(session.settled).toHaveBeenCalledTimes(1);
		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("late failure");
	});

	it("warns on stderr and returns non-zero when the response was truncated", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ stopReason: "length" }));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalled();
	});

	it("returns non-zero in json mode when the response was truncated", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ stopReason: "length" }));
		vi.spyOn(console, "error").mockImplementation(() => {});
		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});
		expect(exitCode).toBe(1);
	});

	it("fails on the recorded outcome even when the context's last message is not the failure", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "unused" }));
		const failure = createRunOutcome();
		failure.status = "failed";
		failure.stopReason = "error";
		failure.errorMessage = "Context overflow recovery failed: nothing in the context can be summarized.";
		Object.defineProperty(runtimeHost.session, "lastRunOutcome", { value: failure });
		runtimeHost.session.state.messages = [];
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			messages: ["hello"],
		});
		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith(failure.errorMessage);
	});

	it("reports why a truncated run stopped when the outcome names a reason", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "unused" }));
		const truncated = createRunOutcome();
		truncated.status = "truncated";
		truncated.stopReason = "length";
		truncated.errorMessage = "Run stopped: replies were cut off in the middle of tool calls.";
		Object.defineProperty(runtimeHost.session, "lastRunOutcome", { value: truncated });
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			messages: ["hello"],
		});
		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith(truncated.errorMessage);
	});
});
