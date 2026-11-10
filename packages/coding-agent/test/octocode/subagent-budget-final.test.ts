import { describe, expect, it, vi } from "vitest";
import { finalMessage, RequestBudget } from "../../src/octocode/subagents/budget.ts";

describe("the hard limit", () => {
	const budget = () => {
		const steer = vi.fn();
		const stop = vi.fn();
		const final = vi.fn();
		return { steer, stop, final, budget: new RequestBudget(3, steer, stop, 0, { final }) };
	};

	it("gives one last request without tools, then stops only if the child still asks for tools", () => {
		const { stop, final, budget: b } = budget();
		for (let count = 1; count <= 4; count++) b.onReply(count, true);
		expect(final).not.toHaveBeenCalled();
		b.onReply(5, true);
		expect(final).toHaveBeenCalledTimes(1);
		expect(final).toHaveBeenCalledWith(finalMessage(5));
		expect(b.stopped).toBe(5);
		expect(stop).not.toHaveBeenCalled();
		// The final reply answers: nothing more happens and the run ends by itself.
		b.onReply(6, false);
		expect(stop).not.toHaveBeenCalled();
		expect(final).toHaveBeenCalledTimes(1);
	});

	it("stops the run when a provider without tool choice still replies with tool calls", () => {
		const { stop, final, budget: b } = budget();
		for (let count = 1; count <= 5; count++) b.onReply(count, true);
		b.onReply(6, true);
		expect(final).toHaveBeenCalledTimes(1);
		expect(stop).toHaveBeenCalledTimes(1);
	});
});
