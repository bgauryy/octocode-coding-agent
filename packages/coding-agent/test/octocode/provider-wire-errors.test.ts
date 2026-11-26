import { afterEach, describe, expect, it, vi } from "vitest";
import { killEverything, outputOfRuns } from "./e2e-real-process-harness.ts";
import { providerFor, wireBox } from "./provider-wire-box.ts";
import { REPLY_TEXT, type Reply, startWire, type Wire } from "./provider-wire-fake.ts";

/**
 * What the real CLI does with a provider that answers with an HTTP failure: it retries what is transient, waits the
 * provider's `retry-after`, and stops with the provider's own words on what no retry can fix.
 */
vi.setConfig({ testTimeout: 180_000 });

let wire: Wire | undefined;
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	await killEverything();
	await wire?.close();
	wire = undefined;
});

async function run(replies: Reply[]) {
	wire = await startWire("openai-completions", replies);
	const box = wireBox();
	box.writeModels({ gw: providerFor("openai-completions", wire, { authHeader: true }) });
	const started = Date.now();
	const result = await box.prompt("gw/model");
	const violations = box.violations();
	expect(violations).toEqual([]);
	return { ...result, ms: Date.now() - started };
}

describe("a failing provider", () => {
	it("waits the retry-after of a 429, then sends the same request again and succeeds", async () => {
		const result = await run([{ status: 429, headers: { "retry-after": "2" } }, "ok"]);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain(REPLY_TEXT);
		expect(wire!.seen).toHaveLength(2);
		expect(wire!.seen[1].body.messages).toEqual(wire!.seen[0].body.messages);
		expect(result.ms).toBeGreaterThanOrEqual(2000);
	});

	it("retries a 503 and succeeds", async () => {
		const result = await run([{ status: 503 }, "ok"]);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain(REPLY_TEXT);
		expect(wire!.seen).toHaveLength(2);
	});

	it("recognises a context overflow, tries to recover, and says it could not, without resending the request", async () => {
		const body = JSON.stringify({
			error: { message: "This model's maximum context length is 8 tokens", code: "context_length_exceeded" },
		});
		const result = await run([{ status: 400, body }]);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("Context overflow recovery failed");
		expect(wire!.seen).toHaveLength(1);
	});

	it("ends on a 400 that no retry can fix, once", async () => {
		const result = await run([{ status: 400, body: JSON.stringify({ error: { message: "bad parameter foo" } }) }]);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("bad parameter foo");
		expect(wire!.seen).toHaveLength(1);
	});
});
