import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/index.ts";

describe("createEventBus", () => {
	it("delivers to a channel's handlers in subscription order and nowhere else", () => {
		const bus = createEventBus();
		const seen: string[] = [];
		bus.on("a", (data) => seen.push(`first:${String(data)}`));
		bus.on("a", (data) => seen.push(`second:${String(data)}`));
		bus.on("b", (data) => seen.push(`b:${String(data)}`));
		bus.emit("a", 1);
		bus.emit("missing", 2);
		// Unlike Node's EventEmitter, "error" is an ordinary channel: emitting it with no handler does not throw.
		expect(() => bus.emit("error", new Error("x"))).not.toThrow();
		expect(seen).toEqual(["first:1", "second:1"]);
	});

	it("keeps a subscription made after clear when an older unsubscribe runs", () => {
		const bus = createEventBus();
		const off = bus.on("a", vi.fn());
		bus.clear();
		const fresh = vi.fn();
		bus.on("a", fresh);
		off();
		bus.emit("a", 1);
		expect(fresh).toHaveBeenCalledWith(1);
	});

	it("unsubscribes one handler and clears all of them", () => {
		const bus = createEventBus();
		const kept = vi.fn();
		const dropped = vi.fn();
		bus.on("a", kept);
		const off = bus.on("a", dropped);
		off();
		off();
		bus.emit("a", 1);
		expect(kept).toHaveBeenCalledOnce();
		expect(dropped).not.toHaveBeenCalled();
		bus.clear();
		bus.emit("a", 2);
		expect(kept).toHaveBeenCalledOnce();
	});

	it("applies subscriptions made during an emit from the next emit", () => {
		const bus = createEventBus();
		const late = vi.fn();
		const off = bus.on("a", () => {
			bus.on("a", late);
			off();
		});
		bus.emit("a", 1);
		expect(late).not.toHaveBeenCalled();
		bus.emit("a", 2);
		expect(late).toHaveBeenCalledWith(2);
	});

	it("reports a failing handler without stopping the others, sync or async", async () => {
		const bus = createEventBus();
		const error = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const after = vi.fn();
		bus.on("a", () => {
			throw new Error("sync");
		});
		bus.on("a", async () => {
			throw new Error("async");
		});
		bus.on("a", after);
		bus.emit("a", 1);
		expect(after).toHaveBeenCalledWith(1);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(error.mock.calls.map((call) => String(call[0])).sort()).toEqual([
			"Event handler error (a): Error: async\n",
			"Event handler error (a): Error: sync\n",
		]);
		error.mockRestore();
	});
});
