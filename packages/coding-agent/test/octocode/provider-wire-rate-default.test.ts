import { afterEach, describe, expect, it, vi } from "vitest";
import { killEverything, outputOfRuns, until } from "./e2e-real-process-harness.ts";
import { providerFor, wireBox } from "./provider-wire-box.ts";
import { startWire, type Wire } from "./provider-wire-fake.ts";

/**
 * The documented default of 12 requests per minute per session (configuration.md, Request rate), with no limit in
 * models.json and none in settings.
 */
vi.setConfig({ testTimeout: 180_000 });

let wire: Wire | undefined;
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	await killEverything();
	await wire?.close();
	wire = undefined;
});

describe("the default request rate", () => {
	it("holds the 13th request of a run and shows the wait", async () => {
		const ticks = Array.from({ length: 12 }, (_, i) => ({ tool: "bash", args: { command: `echo tick ${i}` } }));
		wire = await startWire("openai-completions", [...ticks, "ok"]);
		const box = wireBox();
		box.writeModels({ gw: providerFor("openai-completions", wire, { authHeader: true }) });
		const session = box.rpc("gw/model");
		await session.when(() => session.records().some((r) => r.type === "rpc_ready"), "RPC to start");
		await session.command({ type: "prompt", message: "twelve tool turns" });
		await until(() => wire!.seen.length >= 12, "the twelfth request", 120_000);
		await session.when(
			() => session.records().some((r) => r.type === "model_wait" && r.cooldown?.provider === "gw"),
			"the rate-limit wait event",
			30_000,
		);
		expect(wire.seen).toHaveLength(12);
	});
});
