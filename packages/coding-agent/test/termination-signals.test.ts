import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTerminationSignals } from "../src/modes/termination-signals.ts";

describe("handleTerminationSignals", () => {
	let remove: (() => void) | undefined;
	afterEach(() => remove?.());

	it("handles SIGINT like SIGTERM, with the conventional exit codes", () => {
		const onSignal = vi.fn();
		remove = handleTerminationSignals(onSignal);

		process.emit("SIGINT");
		process.emit("SIGTERM");
		expect(onSignal).toHaveBeenNthCalledWith(1, "SIGINT", 130);
		expect(onSignal).toHaveBeenNthCalledWith(2, "SIGTERM", 143);
		if (process.platform !== "win32") {
			process.emit("SIGHUP");
			expect(onSignal).toHaveBeenNthCalledWith(3, "SIGHUP", 129);
		}
	});

	it("removes its handlers", () => {
		const before = process.listenerCount("SIGINT");
		handleTerminationSignals(vi.fn())();
		expect(process.listenerCount("SIGINT")).toBe(before);
	});
});
