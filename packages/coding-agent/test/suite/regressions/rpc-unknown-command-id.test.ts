import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "../harness.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	isRawStdoutWritePending: vi.fn(() => false),
	onRawStdoutFailure: vi.fn(() => () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../../../src/theme/theme.js", () => ({ theme: {} }));

vi.mock("@octocodeai/octocode-common/jsonl", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {
			rpcIo.lineHandler = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];

type ListenerSnapshot = {
	stdinEnd: NodeListener[];
	signals: Map<NodeJS.Signals, NodeListener[]>;
};

function takeListenerSnapshot(): ListenerSnapshot {
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]])),
	};
}

function restoreListeners(snapshot: ListenerSnapshot): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) {
			process.stdin.off("end", listener);
		}
	}

	for (const [signal, previousListeners] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previousListeners.includes(listener)) {
				process.off(signal, listener);
			}
		}
	}
}

function parseOutputLines(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createRuntimeHost(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

describe("RPC unknown command responses", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	test("preserves the request id on unknown command errors", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness();

		try {
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			rpcIo.lineHandler?.(JSON.stringify({ id: "test", type: "foobar" }));

			await vi.waitFor(() => {
				expect(parseOutputLines()).toContainEqual({
					id: "test",
					type: "response",
					command: "foobar",
					success: false,
					error: "Unknown command: foobar",
				});
			});
		} finally {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});
	test("lists direct skills and collision-safe qualified names through RPC", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const loader = createTestResourceLoader();
		const skills = ["research", "model"].map((name) => ({
			name,
			description: name,
			filePath: `/skills/${name}.md`,
			baseDir: "/skills",
			disableModelInvocation: false,
			sourceInfo: createSyntheticSourceInfo(`/skills/${name}.md`, {
				source: "local",
				scope: "project",
				origin: "top-level",
				baseDir: "/skills",
			}),
		}));
		loader.getSkills = () => ({ skills, diagnostics: [] });
		const harness = await createHarness({ resourceLoader: loader });
		try {
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
			rpcIo.lineHandler?.(JSON.stringify({ id: "skills", type: "get_commands" }));
			await vi.waitFor(() => {
				expect(parseOutputLines()).toContainEqual({
					id: "skills",
					type: "response",
					command: "get_commands",
					success: true,
					data: {
						commands: skills.map((skill, index) => ({
							name: index === 0 ? "research" : "skill:model",
							description: skill.description,
							source: "skill",
							sourceInfo: skill.sourceInfo,
						})),
					},
				});
			});
		} finally {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});

	test("binds a replaced session once: the runtime's rebind hook is the only rebind", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness();
		const bind = vi.spyOn(harness.session, "bindFeatures");
		let rebind: (() => Promise<void>) | undefined;
		// Like the real runtime, each replacement calls the registered rebind hook itself.
		const replaced = async () => {
			await rebind?.();
			return { cancelled: false, selectedText: "" };
		};
		const runtime = {
			...createRuntimeHost(harness),
			newSession: vi.fn(replaced),
			switchSession: vi.fn(replaced),
			fork: vi.fn(replaced),
			setRebindSession: vi.fn((hook: () => Promise<void>) => {
				rebind = hook;
			}),
		} as unknown as AgentSessionRuntime;
		try {
			void runRpcMode(runtime);
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
			await vi.waitFor(() => expect(bind).toHaveBeenCalledTimes(1));
			for (const [id, type] of [
				["n", "new_session"],
				["s", "switch_session"],
				["f", "fork"],
			] as const) {
				rpcIo.lineHandler?.(JSON.stringify({ id, type, sessionPath: "/x.jsonl", entryId: "e" }));
				await vi.waitFor(() =>
					expect(parseOutputLines().some((line) => line.id === id && line.type === "response")).toBe(true),
				);
			}
			expect(bind).toHaveBeenCalledTimes(4);
		} finally {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});
});
