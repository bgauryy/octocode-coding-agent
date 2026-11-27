import { afterEach, describe, expect, it, vi } from "vitest";
import { killEverything, outputOfRuns } from "./e2e-real-process-harness.ts";
import { modelEntry, providerFor, wireBox } from "./provider-wire-box.ts";
import { type Family, REPLY_TEXT, sentText, startWire, type Wire } from "./provider-wire-fake.ts";

/**
 * models.json -> registry -> real CLI session -> HTTP request on loopback -> parsed streamed reply, for each API family.
 * Nothing is faked but the provider's server; the network guard fails any socket that leaves loopback.
 */
vi.setConfig({ testTimeout: 180_000 });

let wire: Wire | undefined;
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	await killEverything();
	await wire?.close();
	wire = undefined;
});

const families: Array<{ family: Family; keyHeader: (headers: Record<string, unknown>) => unknown; pathPart: RegExp }> =
	[
		{ family: "openai-completions", keyHeader: (h) => h.authorization, pathPart: /\/v1\/chat\/completions$/ },
		{ family: "openai-responses", keyHeader: (h) => h.authorization, pathPart: /\/v1\/responses$/ },
		{ family: "anthropic-messages", keyHeader: (h) => h["x-api-key"], pathPart: /\/v1\/messages$/ },
		{ family: "google-generative-ai", keyHeader: (h) => h["x-goog-api-key"], pathPart: /:streamGenerateContent/ },
	];

describe.each(families)("$family through the real CLI", ({ family, keyHeader, pathPart }) => {
	it("sends the prompt with the configured key and prints the parsed reply", async () => {
		wire = await startWire(family);
		const box = wireBox();
		box.writeModels({ gw: providerFor(family, wire, { authHeader: family.startsWith("openai") }) });
		const result = await box.prompt("gw/model", "say hi to the wire");
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain(REPLY_TEXT);
		expect(wire.seen).toHaveLength(1);
		const [request] = wire.seen;
		expect(request.path).toMatch(pathPart);
		expect(String(keyHeader(request.headers))).toContain("wire-key");
		expect(sentText(request)).toContain("say hi to the wire");
		if (family !== "google-generative-ai") expect(request.body.model).toBe("model");
		expect(box.violations()).toEqual([]);
	});
});

describe("the network guard", () => {
	it("records and refuses a connection to a host that is not loopback", async () => {
		const box = wireBox();
		box.writeModels({
			offsite: {
				baseUrl: "http://203.0.113.9:8099/v1",
				api: "openai-completions",
				apiKey: "k",
				models: [modelEntry()],
			},
		});
		const result = await box.prompt("offsite/model");
		expect(result.code).not.toBe(0);
		expect(box.violations()).toContain("203.0.113.9");
	});
});
