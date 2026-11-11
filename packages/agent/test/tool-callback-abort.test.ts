import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { executePreparedToolCall, type PreparedToolCall, ABANDONED_MESSAGE } from "../src/agent-loop/tool-call.ts";

const partial = { content: [], details: undefined };
const prepared = (execute: PreparedToolCall["tool"]["execute"]): PreparedToolCall => ({
	kind: "prepared",
	tool: { name: "work", label: "Work", description: "", parameters: Type.Object({}), execute },
	toolCall: { type: "toolCall", id: "work-1", name: "work", arguments: {} },
	args: {},
});

describe("aborting tool callback waits", () => {
	it("releases a hanging revalidation and never executes after its late approval", async () => {
		const controller = new AbortController();
		let approve!: () => void;
		const execute = vi.fn(async () => partial);
		const call = prepared(execute);
		call.revalidate = () =>
			new Promise<undefined>((resolve) => {
				approve = () => resolve(undefined);
			});
		const outcome = executePreparedToolCall(call, controller.signal, () => {});
		controller.abort();
		expect(await outcome).toMatchObject({
			isError: true,
			result: { content: [{ type: "text", text: "Operation aborted" }] },
		});
		approve();
		await Promise.resolve();
		expect(execute).not.toHaveBeenCalled();
	});

	it.each(["success", "failure", "unsettled"])(
		"releases hanging progress delivery when execution is %s",
		async (ending) => {
			const controller = new AbortController();
			const call = prepared(async (_id, _args, _signal, update) => {
				update?.(partial);
				if (ending === "failure") throw new Error("tool failed");
				if (ending === "unsettled") return new Promise<never>(() => {});
				return partial;
			});
			const onUpdate = () => new Promise<void>(() => {});
			const outcome = executePreparedToolCall(call, controller.signal, onUpdate);
			controller.abort();
			const result = await outcome;
			expect(result.isError).toBe(ending !== "success");
			if (ending === "unsettled") expect(result.result.content).toEqual([{ type: "text", text: ABANDONED_MESSAGE }]);
			if (ending === "failure") expect(result.result.content).toEqual([{ type: "text", text: "tool failed" }]);
		},
	);

	it("does not start a tool when its signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const execute = vi.fn(async () => partial);
		const outcome = await executePreparedToolCall(prepared(execute), controller.signal, () => {});
		expect(outcome.isError).toBe(true);
		expect(execute).not.toHaveBeenCalled();
	});
});
