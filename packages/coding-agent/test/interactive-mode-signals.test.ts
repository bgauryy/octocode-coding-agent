import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as lifecycle from "../src/modes/interactive/interactive-mode/lifecycle.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

type SignalContext = {
	signalCleanupHandlers: Array<() => void>;
	shutdown: (options?: { fromSignal?: boolean }) => Promise<void>;
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

const SIGNALS = ["SIGINT", "SIGTERM", "SIGCONT"] as const;

describe("interactive mode signals", () => {
	let context: SignalContext | undefined;
	let foreign: Map<string, Set<unknown>>;

	// The test runner's worker listens for these signals too and exits on them: dispatch only to the listeners
	// these tests add, as the process would for a signal.
	function deliver(signal: (typeof SIGNALS)[number]): void {
		for (const listener of process.listeners(signal)) {
			if (!foreign.get(signal)?.has(listener)) (listener as () => void)();
		}
	}

	beforeEach(() => {
		foreign = new Map(SIGNALS.map((signal) => [signal, new Set<unknown>(process.listeners(signal))]));
	});

	afterEach(() => {
		context?.unregisterSignalHandlers();
		context = undefined;
		for (const signal of SIGNALS) {
			for (const listener of process.listeners(signal)) {
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
});
