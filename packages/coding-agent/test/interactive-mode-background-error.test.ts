import { afterEach, describe, expect, test, vi } from "vitest";
import { backgroundError, isLeakedFileHandleError } from "../src/modes/interactive/interactive-mode/crash-reporting.ts";
import * as lifecycle from "../src/modes/interactive/interactive-mode/lifecycle.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

type Host = Parameters<typeof backgroundError>[0];

function createHost() {
	return {
		isShuttingDown: false,
		showWarning: vi.fn(),
		suggestBugReport: vi.fn(),
		uncaughtCrash: vi.fn((error: Error): never => {
			throw error;
		}),
	};
}

const leakedFileHandle = () =>
	Object.assign(
		new Error(
			"A FileHandle object was closed during garbage collection. This used to be allowed with a deprecation warning but is now considered an error. Please close FileHandle objects explicitly. File descriptor: 20 (/tmp/x.jsonl)",
		),
		{ code: "ERR_INVALID_STATE" },
	);

describe("background errors in an interactive session", () => {
	afterEach(() => vi.restoreAllMocks());

	test("a leaked FileHandle that Node already closed is a warning, not a crash", () => {
		const host = createHost();
		expect(isLeakedFileHandleError(leakedFileHandle())).toBe(true);

		backgroundError(host as unknown as Host, "uncaughtException", leakedFileHandle());

		expect(host.uncaughtCrash).not.toHaveBeenCalled();
		expect(host.showWarning).toHaveBeenCalledWith(expect.stringContaining("the session keeps running"));
		expect(host.suggestBugReport).toHaveBeenCalled();
	});

	test("any other uncaught exception still crashes", () => {
		const host = createHost();
		const error = Object.assign(new Error("Invalid state"), { code: "ERR_INVALID_STATE" });

		expect(() => backgroundError(host as unknown as Host, "uncaughtException", error)).toThrow(error);
		expect(host.uncaughtCrash).toHaveBeenCalledWith(error);
		expect(host.showWarning).not.toHaveBeenCalled();
	});

	test("an unawaited rejection, even of a non-error, keeps the session with a warning", () => {
		const host = createHost();

		backgroundError(host as unknown as Host, "unhandledRejection", "socket hang up");

		expect(host.uncaughtCrash).not.toHaveBeenCalled();
		expect(host.showWarning).toHaveBeenCalledWith(expect.stringContaining("socket hang up"));
	});

	test("a burst of survived errors crashes with the latest", () => {
		const host = createHost();
		for (let i = 0; i < 10; i++) backgroundError(host as unknown as Host, "unhandledRejection", new Error(`e${i}`));
		expect(host.uncaughtCrash).not.toHaveBeenCalled();

		expect(() => backgroundError(host as unknown as Host, "unhandledRejection", new Error("e10"))).toThrow("e10");
	});

	test("nothing is shown once the session is shutting down", () => {
		const host = { ...createHost(), isShuttingDown: true };

		backgroundError(host as unknown as Host, "unhandledRejection", new Error("late"));

		expect(host.showWarning).not.toHaveBeenCalled();
		expect(host.uncaughtCrash).not.toHaveBeenCalled();
	});

	test("the session listens for unhandled rejections while its signal handlers are registered", () => {
		const context = {
			signalCleanupHandlers: [] as Array<() => void>,
			backgroundError: vi.fn(),
			unregisterSignalHandlers: () => lifecycle.unregisterSignalHandlers(createFakeHost(context)),
		};
		const before = process.listeners("unhandledRejection");
		lifecycle.registerSignalHandlers(createFakeHost(context));
		try {
			const added = process.listeners("unhandledRejection").filter((listener) => !before.includes(listener));
			expect(added).toHaveLength(1);
			const reason = new Error("nobody awaited this");
			(added[0] as (reason: unknown) => void)(reason);
			expect(context.backgroundError).toHaveBeenCalledWith("unhandledRejection", reason);
		} finally {
			context.unregisterSignalHandlers();
		}
		expect(process.listeners("unhandledRejection")).toEqual(before);
	});
});
