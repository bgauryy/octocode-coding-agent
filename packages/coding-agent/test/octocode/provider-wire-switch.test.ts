import { afterEach, describe, expect, it, vi } from "vitest";
import { killEverything, outputOfRuns } from "./e2e-real-process-harness.ts";
import { modelEntry, providerFor, wireBox } from "./provider-wire-box.ts";
import { startWire, type Wire } from "./provider-wire-fake.ts";

/**
 * Switching models inside one RPC session, read from the request bodies each turn puts on the wire. A signed thinking
 * block is replayed only to the model that wrote it (`transform-messages.ts`): the same model keeps it, another model on
 * the same provider drops it, and another API family never sees an Anthropic block.
 */
vi.setConfig({ testTimeout: 180_000 });

const wires: Wire[] = [];
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	await killEverything();
	await Promise.all(wires.splice(0).map((wire) => wire.close()));
});

const thinkingBlocks = (body: any): any[] =>
	(body.messages as any[])
		.filter((message) => message.role === "assistant" && Array.isArray(message.content))
		.flatMap((message) => message.content)
		.filter((block) => block.type === "thinking");

describe("switching models over the wire", () => {
	it("replays signed thinking across Claude models of one provider, and never to another API family", async () => {
		const ant = await startWire("anthropic-messages", [{ thinking: "pondering", signature: "SIG123" }, "ok"]);
		const oai = await startWire("openai-completions");
		wires.push(ant, oai);
		const box = wireBox();
		box.writeModels({
			ant: providerFor("anthropic-messages", ant, {
				models: [
					{ ...modelEntry("model-a"), reasoning: true },
					{ ...modelEntry("model-b"), reasoning: true },
				],
			}),
			oai: providerFor("openai-completions", oai, { authHeader: true, models: [modelEntry("model-c")] }),
		});
		const session = box.rpc("ant/model-a", ["--thinking", "high"]);
		await session.when(() => session.records().some((r) => r.type === "rpc_ready"), "RPC to start");
		let turns = 0;
		const turn = async (message: string) => {
			const answered = await session.command({ type: "prompt", message });
			expect(answered.success, JSON.stringify(answered)).toBe(true);
			turns++;
			await session.when(
				() => session.records().filter((r) => r.type === "agent_end").length === turns,
				`turn ${turns} to end`,
			);
		};
		const switchTo = async (provider: string, modelId: string) => {
			const answered = await session.command({ type: "set_model", provider, modelId });
			expect(answered.success, JSON.stringify(answered)).toBe(true);
		};

		await turn("first");
		await turn("second, same model");
		await switchTo("ant", "model-b");
		await turn("third, other model, same provider");
		await switchTo("oai", "model-c");
		await turn("fourth, other family");

		expect(ant.seen.map((request) => request.body.model)).toEqual(["model-a", "model-a", "model-b"]);
		expect(thinkingBlocks(ant.seen[0].body)).toEqual([]);
		expect(thinkingBlocks(ant.seen[1].body)).toMatchObject([{ thinking: "pondering", signature: "SIG123" }]);
		expect(thinkingBlocks(ant.seen[2].body)).toMatchObject([{ thinking: "pondering", signature: "SIG123" }]);
		expect(oai.seen).toHaveLength(1);
		expect(JSON.stringify(oai.seen[0].body)).not.toMatch(/SIG123|"thinking"|pondering/);
		expect(box.violations()).toEqual([]);
	});
});
