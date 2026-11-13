import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Endpoint, killEverything, outputOfRuns, sandbox, startEndpoint } from "./e2e-real-process-harness.ts";

/** CLI flags that shape the model request, read from the request a real process sends to the scripted model. */
let endpoint: Endpoint;

vi.setConfig({ testTimeout: 180_000 });

beforeAll(async () => {
	endpoint = await startEndpoint();
});
afterAll(async () => {
	await endpoint?.close();
});
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	await killEverything();
	endpoint.requests.length = 0;
});

/** A sandbox whose provider offers reasoning models `model` and `alt`. */
function reasoningSandbox() {
	const box = sandbox(endpoint);
	const file = path.join(box.home, ".octocode", "octocodecode", "models.json");
	const entry = (id: string) => ({
		id,
		name: id,
		reasoning: true,
		contextWindow: 200000,
		maxTokens: 8000,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
	});
	fs.writeFileSync(
		file,
		JSON.stringify({
			providers: {
				scripted: {
					baseUrl: endpoint.url,
					api: "openai-completions",
					apiKey: "local",
					authHeader: true,
					models: [entry("model"), entry("alt")],
				},
			},
		}),
	);
	return box;
}

const runOnce = async (box: ReturnType<typeof sandbox>, args: string[], options?: { model?: false }) => {
	const run = box.start([...args, "-p", "say hi"], options);
	const { code } = await run.exited;
	expect(code, run.stderr()).toBe(0);
	expect(endpoint.requests.length).toBeGreaterThan(0);
	return { request: endpoint.requests[0], stdout: run.stdout() };
};

describe("CLI flags reach the model request", () => {
	it("declares tools by default and none with --no-tools", async () => {
		const withTools = await runOnce(sandbox(endpoint), []);
		expect(withTools.request.tools).toContain("bash");
		expect(withTools.request.tools).toContain("file");
		endpoint.requests.length = 0;
		const without = await runOnce(sandbox(endpoint), ["--no-tools"]);
		expect(without.request.tools).toEqual([]);
		expect(without.stdout).toContain("scripted summary");
	});

	it("--system-prompt replaces the default system prompt", async () => {
		const custom = await runOnce(sandbox(endpoint), ["--system-prompt", "You are a pirate named Zorblax."]);
		expect(custom.request.system).toContain("You are a pirate named Zorblax.");
		endpoint.requests.length = 0;
		const normal = await runOnce(sandbox(endpoint), []);
		expect(normal.request.system).not.toContain("Zorblax");
		expect(custom.request.system.length).toBeLessThan(normal.request.system.length);
	});

	it("--append-system-prompt adds text, or a file's contents, after the default prompt", async () => {
		const box = sandbox(endpoint);
		fs.writeFileSync(path.join(box.project, "extra.md"), "File rule: always answer in haiku.\n");
		const { request } = await runOnce(box, [
			"--append-system-prompt",
			"Inline rule: mention quokkas.",
			"--append-system-prompt",
			"extra.md",
		]);
		const inline = request.system.indexOf("Inline rule: mention quokkas.");
		const file = request.system.indexOf("File rule: always answer in haiku.");
		expect(inline).toBeGreaterThan(0);
		expect(file).toBeGreaterThan(inline);
		// The default prompt is still there, ahead of the appended text.
		expect(request.system.slice(0, inline).length).toBeGreaterThan(500);
	});

	it("--thinking sets the request's reasoning effort on a reasoning model", async () => {
		const high = await runOnce(reasoningSandbox(), ["--thinking", "high"]);
		expect(high.request.reasoningEffort).toBe("high");
		endpoint.requests.length = 0;
		const low = await runOnce(reasoningSandbox(), ["--thinking", "low"]);
		expect(low.request.reasoningEffort).toBe("low");
	});

	it("--thinking is ignored on a model without reasoning", async () => {
		const { request } = await runOnce(sandbox(endpoint), ["--thinking", "high"]);
		expect(request.reasoningEffort).toBeUndefined();
	});

	it("--models picks the first scoped model, with its thinking level, when --model is absent", async () => {
		const { request } = await runOnce(reasoningSandbox(), ["--models", "scripted/alt:low,scripted/model"], {
			model: false,
		});
		expect(request.model).toBe("alt");
		expect(request.reasoningEffort).toBe("low");
	});

	it("an explicit --thinking beats the scoped model's level", async () => {
		const { request } = await runOnce(reasoningSandbox(), ["--models", "scripted/alt:low", "--thinking", "high"], {
			model: false,
		});
		expect(request.model).toBe("alt");
		expect(request.reasoningEffort).toBe("high");
	});
});
