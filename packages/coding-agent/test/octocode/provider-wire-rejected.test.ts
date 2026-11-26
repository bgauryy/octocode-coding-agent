import { afterEach, describe, expect, it, vi } from "vitest";
import { killEverything, outputOfRuns } from "./e2e-real-process-harness.ts";
import { providerFor, wireBox } from "./provider-wire-box.ts";
import { type Family, type Reply, startWire, type Wire } from "./provider-wire-fake.ts";

/**
 * An endpoint that answers 400 that it does not accept a field: the request is resent once without it, the turn
 * succeeds, and later turns of the session never send the field again (configuration.md, Provider defaults and
 * profiles). Wordings are the ones `ai/test/rejected-capability-adapters.test.ts` uses.
 */
vi.setConfig({ testTimeout: 180_000 });

let wire: Wire | undefined;
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	await killEverything();
	await wire?.close();
	wire = undefined;
});

const refusal = (message: string): Reply => ({ status: 400, body: JSON.stringify({ message, error: { message } }) });

/** Two prompts in one RPC session; the first request is refused, every later one answered. */
async function twoTurns(family: Family, refused: Reply, fields: Record<string, unknown> = {}) {
	wire = await startWire(family, [refused, "ok"]);
	const box = wireBox();
	box.writeModels({ gw: providerFor(family, wire, { authHeader: family.startsWith("openai"), ...fields }) });
	const rpc = box.rpc("gw/model");
	await rpc.when(() => rpc.records().some((r) => r.type === "rpc_ready"), "RPC to start");
	for (const [index, message] of ["first turn", "second turn"].entries()) {
		const answered = await rpc.command({ type: "prompt", message });
		expect(answered.success, JSON.stringify(answered)).toBe(true);
		await rpc.when(
			() => rpc.records().filter((r) => r.type === "agent_settled").length === index + 1,
			`turn ${index + 1} to settle`,
		);
	}
	expect(box.violations()).toEqual([]);
	return rpc;
}

const endedOk = (rpc: Awaited<ReturnType<typeof twoTurns>>) =>
	rpc
		.records()
		.filter((r) => r.type === "message_end" && r.message?.role === "assistant")
		.map((r) => r.message.stopReason);

describe("a 400 that refuses cache_control", () => {
	it.each([
		{ family: "anthropic-messages" as const, text: "system.0.cache_control: Extra inputs are not permitted" },
		{ family: "openai-completions" as const, text: "messages.0.cache_control: Extra inputs are not permitted" },
	])("$family: is resent without markers, and no later turn sends them", async ({ family, text }) => {
		// The profile makes the gateway earn markers on the first request.
		const rpc = await twoTurns(family, refusal(text), { profile: "anthropic" });
		const sent = wire!.seen.map((request) => /"cache_control"/.test(JSON.stringify(request.body)));
		expect(sent[0], "the first request carries markers").toBe(true);
		expect(wire!.seen.length).toBeGreaterThanOrEqual(3);
		expect(sent.slice(1), "the resend and the second turn carry none").toEqual(sent.slice(1).map(() => false));
		expect(endedOk(rpc)).toEqual(["stop", "stop"]);
	});
});

describe("a 400 that refuses strict tool schemas", () => {
	it("openai-completions: is resent without strict, and no later turn sends it", async () => {
		const rpc = await twoTurns("openai-completions", refusal("Unknown parameter: 'tools[0].function.strict'"), {
			compat: { supportsStrictMode: true },
		});
		const sent = wire!.seen.map((request) => /"strict":(?:true|false)/.test(JSON.stringify(request.body)));
		expect(sent[0], "the first request carries a strict field on its tools").toBe(true);
		expect(wire!.seen.length).toBeGreaterThanOrEqual(3);
		expect(sent.slice(1)).toEqual(sent.slice(1).map(() => false));
		expect(endedOk(rpc)).toEqual(["stop", "stop"]);
	});
});
