import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as lifecycle from "../src/modes/interactive/interactive-mode/lifecycle.ts";
import { holdTerminalForChild } from "../src/utils/foreground-child.ts";
import { createFakeHost } from "./interactive-mode-host.ts";
import { createUiStore, type UiStore } from "../src/modes/interactive/state/store.ts";

type SignalContext = {
	signalCleanupHandlers: Array<() => void>;
	shutdown: (options?: { fromSignal?: boolean }) => Promise<void>;
	uiStore: UiStore;
	unregisterSignalHandlers: () => void;
	emergencyTerminalExit: () => never;
	uncaughtCrash: (error: Error) => never;
	ui: {
		mode: "fullscreen" | "regular";
		start: () => void;
		stop: (options?: { preserveScreen?: boolean }) => void;
		requestRender: (force?: boolean) => void;
	};
};

function createContext(mode: "fullscreen" | "regular" = "fullscreen"): SignalContext {
	const context: SignalContext = {
		signalCleanupHandlers: [],
		shutdown: vi.fn(async () => {}),
		uiStore: createUiStore(),
		unregisterSignalHandlers: () => lifecycle.unregisterSignalHandlers(createFakeHost(context)),
		emergencyTerminalExit: () => {
			throw new Error("unexpected emergency exit");
		},
		uncaughtCrash: () => {
			throw new Error("unexpected crash");
		},
		ui: { mode, start: vi.fn(), stop: vi.fn(), requestRender: vi.fn() },
	};
	return context;
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGCONT", "SIGTSTP"] as const;

describe("interactive mode signals", () => {
	let context: SignalContext | undefined;
	let foreign: Map<string, Set<unknown>>;

	// The test runner's worker listens for these signals too and exits on them: dispatch only to the listeners
	// these tests add, as the process would for a signal. Raw listeners, so a `once` listener removes itself as on emit.
	function deliver(signal: (typeof SIGNALS)[number]): void {
		for (const listener of process.rawListeners(signal)) {
			if (!foreign.get(signal)?.has(listener)) (listener as () => void)();
		}
	}

	beforeEach(() => {
		foreign = new Map(SIGNALS.map((signal) => [signal, new Set<unknown>(process.rawListeners(signal))]));
	});

	afterEach(() => {
		context?.unregisterSignalHandlers();
		context = undefined;
		for (const signal of SIGNALS) {
			for (const listener of process.rawListeners(signal)) {
				if (!foreign.get(signal)?.has(listener)) process.removeListener(signal, listener as () => void);
			}
		}
		vi.restoreAllMocks();
	});

	test.each(["SIGINT", "SIGTERM"] as const)("an external %s shuts down gracefully", (signal) => {
		context = createContext();
		lifecycle.registerSignalHandlers(createFakeHost(context));

		deliver(signal);

		expect(context.shutdown).toHaveBeenCalledWith({ fromSignal: true });
	});

	test("the signal listeners are removed on unregister", () => {
		context = createContext();
		const before = process.listenerCount("SIGINT");
		lifecycle.registerSignalHandlers(createFakeHost(context));
		expect(process.listenerCount("SIGINT")).toBe(before + 1);

		context.unregisterSignalHandlers();

		expect(process.listenerCount("SIGINT")).toBe(before);
	});

	test("a SIGINT while suspended is ignored, and shuts down again after resume", () => {
		context = createContext();
		vi.spyOn(process, "kill").mockImplementation(() => true);
		lifecycle.registerSignalHandlers(createFakeHost(context));

		lifecycle.handleCtrlZ(createFakeHost(context));
		deliver("SIGINT");
		expect(context.shutdown).not.toHaveBeenCalled();

		deliver("SIGCONT");
		expect(context.ui.start).toHaveBeenCalledTimes(1);
		deliver("SIGINT");
		expect(context.shutdown).toHaveBeenCalledWith({ fromSignal: true });
	});

	test("a SIGTERM while suspended still shuts down", () => {
		context = createContext();
		vi.spyOn(process, "kill").mockImplementation(() => true);
		lifecycle.registerSignalHandlers(createFakeHost(context));

		lifecycle.handleCtrlZ(createFakeHost(context));
		deliver("SIGTERM");

		expect(context.shutdown).toHaveBeenCalledWith({ fromSignal: true });
		deliver("SIGCONT");
	});

	test("suspending a fullscreen UI preserves the screen so the transcript is not written into the shell", () => {
		context = createContext("fullscreen");
		vi.spyOn(process, "kill").mockImplementation(() => true);

		lifecycle.handleCtrlZ(createFakeHost(context));
		deliver("SIGCONT");

		expect(context.ui.stop).toHaveBeenCalledWith({ preserveScreen: true });
	});

	test("suspending a regular UI keeps its trailing line break below the transcript", () => {
		context = createContext("regular");
		vi.spyOn(process, "kill").mockImplementation(() => true);

		lifecycle.handleCtrlZ(createFakeHost(context));
		deliver("SIGCONT");

		expect(context.ui.stop).toHaveBeenCalledWith({ preserveScreen: false });
	});

	describe.skipIf(process.platform === "win32")("an external SIGTSTP", () => {
		test("suspends like Ctrl+Z, and the suspend's own group signal then stops the process", () => {
			context = createContext();
			const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
			lifecycle.registerSignalHandlers(createFakeHost(context));

			deliver("SIGTSTP");

			// The UI restored the terminal, then the suspend signalled its process group.
			expect(context.ui.stop).toHaveBeenCalledTimes(1);
			expect(kill.mock.calls).toEqual([[0, "SIGTSTP"]]);
			// That group signal reaches this listener too: it stops the process, without a second suspend.
			deliver("SIGTSTP");
			expect(context.ui.stop).toHaveBeenCalledTimes(1);
			expect(kill.mock.calls).toEqual([
				[0, "SIGTSTP"],
				[process.pid, "SIGSTOP"],
			]);

			deliver("SIGCONT");
			expect(context.ui.start).toHaveBeenCalledTimes(1);
			// Resumed: the next external signal suspends again.
			deliver("SIGTSTP");
			expect(context.ui.stop).toHaveBeenCalledTimes(2);
			deliver("SIGTSTP");
			deliver("SIGCONT");
			expect(context.ui.start).toHaveBeenCalledTimes(2);
		});

		test("the Ctrl+Z key's group signal stops the process once", () => {
			context = createContext();
			const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
			lifecycle.registerSignalHandlers(createFakeHost(context));

			lifecycle.handleCtrlZ(createFakeHost(context));
			deliver("SIGTSTP");

			expect(context.ui.stop).toHaveBeenCalledTimes(1);
			expect(kill.mock.calls).toEqual([
				[0, "SIGTSTP"],
				[process.pid, "SIGSTOP"],
			]);
			deliver("SIGCONT");
			expect(context.ui.start).toHaveBeenCalledTimes(1);
		});

		test("a signal while the suspend drains its restore output waits for that suspend", async () => {
			let drained!: (value: boolean) => void;
			context = createContext();
			Object.assign(context.ui, {
				terminal: { drainOutput: () => new Promise<boolean>((resolve) => (drained = resolve)) },
			});
			const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
			lifecycle.registerSignalHandlers(createFakeHost(context));

			deliver("SIGTSTP");
			deliver("SIGTSTP");
			expect(context.ui.stop).toHaveBeenCalledTimes(1);
			expect(kill).not.toHaveBeenCalled();

			drained(true);
			await Promise.resolve();
			expect(kill.mock.calls).toEqual([[0, "SIGTSTP"]]);
			deliver("SIGCONT");
			expect(context.ui.start).toHaveBeenCalledTimes(1);
		});

		test("while a foreground child owns the terminal, it stops the process without touching the UI", () => {
			context = createContext();
			const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
			lifecycle.registerSignalHandlers(createFakeHost(context));
			const release = holdTerminalForChild();
			try {
				deliver("SIGTSTP");
			} finally {
				release();
			}

			expect(context.ui.stop).not.toHaveBeenCalled();
			expect(kill.mock.calls).toEqual([[process.pid, "SIGSTOP"]]);
			deliver("SIGCONT");
			expect(context.ui.start).not.toHaveBeenCalled();
		});

		test("during shutdown it stops the process without a suspend", () => {
			context = createContext();
			context.uiStore.getState().beginShutdown();
			const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
			lifecycle.registerSignalHandlers(createFakeHost(context));

			deliver("SIGTSTP");

			expect(context.ui.stop).not.toHaveBeenCalled();
			expect(kill.mock.calls).toEqual([[process.pid, "SIGSTOP"]]);
		});

		test("unregister removes the listener", () => {
			context = createContext();
			const before = process.listenerCount("SIGTSTP");
			lifecycle.registerSignalHandlers(createFakeHost(context));
			expect(process.listenerCount("SIGTSTP")).toBe(before + 1);

			context.unregisterSignalHandlers();

			expect(process.listenerCount("SIGTSTP")).toBe(before);
		});
	});
});
