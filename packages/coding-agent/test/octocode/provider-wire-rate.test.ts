import { afterEach, describe, expect, it, vi } from "vitest";
import { killEverything, outputOfRuns, until, writeSettings } from "./e2e-real-process-harness.ts";
import { providerFor, wireBox } from "./provider-wire-box.ts";
import { startWire, type Wire } from "./provider-wire-fake.ts";

/** requestsPerMinute on the wire: the second request of a run is held, not sent, and the CLI says why. */
vi.setConfig({ testTimeout: 180_000 });

let wire: Wire | undefined;
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	await killEverything();
	await wire?.close();
	wire = undefined;
});

describe("tokensPerMinute", () => {
	it("holds the second request once the first one's reported usage fills the budget", async () => {
		// The first reply reports 90 000 prompt tokens against a 100 000 budget: the next estimate cannot fit.
		wire = await startWire("openai-completions", [{ tool: "models", promptTokens: 90_000 }, "ok"]);
		const box = wireBox();
		box.writeModels({
			gw: providerFor("openai-completions", wire, { authHeader: true, tokensPerMinute: 100_000, requestsPerMinute: 0 }),
		});
		const session = box.rpc("gw/model");
		await session.when(() => session.records().some((r) => r.type === "rpc_ready"), "RPC to start");
		await session.command({ type: "prompt", message: "use a tool" });
		await until(() => wire!.seen.length === 1, "the first request");
		await session.when(
			() => session.records().some((r) => r.type === "model_wait" && r.cooldown?.provider === "gw"),
			"the token-budget wait event",
			30_000,
		);
		expect(wire.seen).toHaveLength(1);
	});
});

describe("requestsPerMinute", () => {
	it("holds the second request of a turn back and shows the wait", async () => {
		wire = await startWire("openai-completions", [{ tool: "models" }, "ok"]);
		const box = wireBox();
		box.writeModels({ gw: providerFor("openai-completions", wire, { authHeader: true, requestsPerMinute: 1 }) });
		const session = box.rpc("gw/model");
		await session.when(() => session.records().some((r) => r.type === "rpc_ready"), "RPC to start");
		const answered = await session.command({ type: "prompt", message: "use a tool" });
		expect(answered.success, JSON.stringify(answered)).toBe(true);
		await until(() => wire!.seen.length === 1, "the first request");
		// RPC clients get the wait as a `model_wait` event naming the provider.
		await session.when(
			() => session.records().some((r) => r.type === "model_wait" && r.cooldown?.provider === "gw"),
			"the rate-limit wait event",
			30_000,
		);
		expect(wire.seen).toHaveLength(1);
		expect(box.violations()).toEqual([]);
	});

	it.each([
		{ name: "holds at a models.json limit of 12", fields: { requestsPerMinute: 12 }, settings: {}, limit: 12 },
		{ name: "holds at a requestsPerMinute setting of 12", fields: {}, settings: { requestsPerMinute: 12 }, limit: 12 },
		{ name: "follows the requestsPerMinute setting", fields: {}, settings: { requestsPerMinute: 3 }, limit: 3 },
	])("$name: the next request of a run is held and the wait is shown", async ({ fields, settings, limit }) => {
		const ticks = Array.from({ length: limit }, (_, i) => ({ tool: "bash", args: { command: `echo tick ${i}` } }));
		wire = await startWire("openai-completions", [...ticks, "ok"]);
		const box = wireBox();
		writeSettings(box, settings);
		// Without a models.json limit the setting's default applies.
		box.writeModels({ gw: providerFor("openai-completions", wire, { authHeader: true, ...fields }) });
		const session = box.rpc("gw/model");
		await session.when(() => session.records().some((r) => r.type === "rpc_ready"), "RPC to start");
		await session.command({ type: "prompt", message: "twelve tool turns" });
		await until(() => wire!.seen.length >= limit, "the last request under the limit", 120_000);
		await session.when(
			() => session.records().some((r) => r.type === "model_wait" && r.cooldown?.provider === "gw"),
			"the rate-limit wait event",
			30_000,
		);
		const span = wire.seen.map((request) => request.at - wire!.seen[0].at);
		expect(wire.seen.length, `request offsets in ms: ${span.join(", ")}`).toBe(limit);
	});

	it("does not hold a run with the limit off", async () => {
		wire = await startWire("openai-completions", [{ tool: "models" }, "ok"]);
		const box = wireBox();
		box.writeModels({ gw: providerFor("openai-completions", wire, { authHeader: true, requestsPerMinute: 0 }) });
		const result = await box.prompt("gw/model", "use a tool");
		expect(result.code, result.stderr).toBe(0);
		expect(wire.seen).toHaveLength(2);
	});
});
