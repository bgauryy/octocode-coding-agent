import { afterEach, describe, expect, it, vi } from "vitest";
import { TransportEvents } from "../../src/client/transports/transport.ts";

class Events extends TransportEvents {
	fail(error: unknown): void {
		this.emitError(error);
	}
	end(): void {
		this.emitClose();
	}
}

afterEach(() => vi.restoreAllMocks());

describe("TransportEvents", () => {
	it("runs every close listener when one throws and reports the throw as a transport error", () => {
		const events = new Events();
		const errors: string[] = [];
		const closed = vi.fn();
		events.onError((error) => errors.push(error.message));
		events.onClose(() => {
			throw new Error("stale client");
		});
		events.onClose(closed);
		expect(() => events.end()).not.toThrow();
		expect(closed).toHaveBeenCalledTimes(1);
		expect(errors).toEqual(["stale client"]);
	});

	it("runs every error listener when one throws and surfaces the throw as a rejection", () => {
		const events = new Events();
		const reported = vi.spyOn(Promise, "reject").mockImplementation(() => Promise.resolve());
		const seen = vi.fn();
		events.onError(() => {
			throw new Error("log closed");
		});
		events.onError(seen);
		expect(() => events.fail(new Error("pipe broke"))).not.toThrow();
		expect(seen).toHaveBeenCalledWith(expect.objectContaining({ message: "pipe broke" }));
		expect(reported).toHaveBeenCalledWith(expect.objectContaining({ message: "log closed" }));
	});
});
