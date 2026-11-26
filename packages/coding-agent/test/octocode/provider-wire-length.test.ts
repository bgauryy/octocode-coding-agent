import { afterEach, describe, expect, it, vi } from "vitest";
import { killEverything, outputOfRuns } from "./e2e-real-process-harness.ts";
import { providerFor, wireBox } from "./provider-wire-box.ts";
import { type Family, REPLY_TEXT, startWire, type Reply, type Wire } from "./provider-wire-fake.ts";

/**
 * A reply the output limit cuts off (`finish_reason: length`, Anthropic `max_tokens`): the agent loop ends the turn with
 * the cut text kept and the stop reason reported, and a tool call cut mid-arguments is failed, never run.
 */
vi.setConfig({ testTimeout: 180_000 });

let wire: Wire | undefined;
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	await killEverything();
	await wire?.close();
	wire = undefined;
});

async function session(family: Family, replies: Reply[]) {
	wire = await startWire(family, replies);
	const box = wireBox();
	box.writeModels({ gw: providerFor(family, wire, { authHeader: family.startsWith("openai") }) });
	const rpc = box.rpc("gw/model");
	await rpc.when(() => rpc.records().some((r) => r.type === "rpc_ready"), "RPC to start");
	const answered = await rpc.command({ type: "prompt", message: "write a lot" });
	expect(answered.success, JSON.stringify(answered)).toBe(true);
	await rpc.when(() => rpc.records().some((r) => r.type === "agent_end"), "the turn to end");
	expect(box.violations()).toEqual([]);
	return rpc;
}

describe.each(["openai-completions", "anthropic-messages"] as const)("%s output limit", (family) => {
	it("keeps the cut text, then asks the model to continue where it stopped", async () => {
		const rpc = await session(family, [{ cutOffText: "partial answer" }, "ok"]);
		const assistant = rpc
			.records()
			.filter((r) => r.type === "message_end" && r.message?.role === "assistant")
			.map((r) => r.message);
		expect(assistant.map((message) => message.stopReason)).toEqual(["length", "stop"]);
		expect(JSON.stringify(assistant[0].content)).toContain("partial answer");
		expect(wire!.seen).toHaveLength(2);
		// The second request carries the cut text and the instruction to continue it.
		const resent = JSON.stringify(wire!.seen[1].body);
		expect(resent).toContain("partial answer");
		expect(resent).toContain("reached the output token limit and was cut off. Continue exactly where it stopped");
	});

	it("fails a tool call cut mid-arguments without running it, and tells the model", async () => {
		const rpc = await session(family, [{ tool: "models", cutOff: true }, "ok"]);
		expect(wire!.seen).toHaveLength(2);
		// The call is reported and failed in the same breath: no result of the tool itself exists.
		const ended = rpc.records().filter((r) => r.type === "tool_execution_end");
		expect(ended.map((r) => r.isError)).toEqual([true]);
		const second = JSON.stringify(wire!.seen[1].body);
		expect(second).toMatch(/truncat|cut off|output limit|max.?tokens/i);
		expect(second).not.toContain(REPLY_TEXT);
	});
});
