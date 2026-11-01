import { afterEach, describe, expect, it, vi } from "vitest";
import { LlamaClient, type LlamaModelInfo } from "../../src/octocode/llama/client.ts";

/** A scripted llama.cpp router at the fetch boundary: `/models` answers from `catalog()`, SSE sends `events` then ends. */
function router(options: { catalog: () => unknown; events?: unknown[]; post?: () => Response }): { calls: string[] } {
	const calls: string[] = [];
	vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
		const url = new URL(input);
		calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
		if (url.pathname === "/models/sse") {
			const text = (options.events ?? []).map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
			return new Response(text, { status: 200 });
		}
		if (init?.method === "POST") return options.post?.() ?? Response.json({});
		return Response.json(options.catalog());
	});
	return { calls };
}

const entry = (status: LlamaModelInfo["status"]): LlamaModelInfo => ({ id: "org/model:Q4_K_M", status });

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("LlamaClient", () => {
	it("normalizes the server URL and lists the router catalog", async () => {
		const { calls } = router({ catalog: () => ({ data: [entry({ value: "loaded" })] }) });
		const client = new LlamaClient(" http://localhost:8080/v1/ ");
		expect(client.serverUrl).toBe("http://localhost:8080");
		expect(await client.list({ reload: true })).toEqual([entry({ value: "loaded" })]);
		expect(calls).toEqual(["GET /models?reload=1"]);
	});

	it("rejects a malformed catalog and a server that is not in router mode", async () => {
		router({ catalog: () => ({ models: [] }) });
		await expect(new LlamaClient("http://localhost:8080").list()).rejects.toThrow("invalid model catalog");
		router({ catalog: () => ({ data: [{ id: "x" }] }) });
		await expect(new LlamaClient("http://localhost:8080").list()).rejects.toThrow(
			"not running in llama.cpp router mode",
		);
	});

	it("reports the server's error message for an HTTP failure", async () => {
		router({
			catalog: () => ({ data: [] }),
			post: () => Response.json({ error: { message: "model not found" } }, { status: 404 }),
		});
		await expect(new LlamaClient("http://localhost:8080").download("org/missing")).rejects.toThrow("model not found");
	});

	it("fails a download whose failure event was missed when the catalog marks it failed", async () => {
		// The SSE stream drops at once; polling sees the entry, no longer downloading, with `failed` set.
		router({ catalog: () => ({ data: [entry({ value: "unloaded", failed: true, exit_code: 1 })] }) });
		const progress: string[] = [];
		await expect(
			new LlamaClient("http://localhost:8080").downloadAndWait("org/model:Q4_K_M", (p) => progress.push(p.message)),
		).rejects.toThrow(/failed/i);
	});

	it("fails a download reported by a download_failed event", async () => {
		router({
			catalog: () => ({ data: [entry({ value: "downloading" })] }),
			events: [{ model: "org/model:Q4_K_M", event: "download_failed", data: { error: { message: "disk full" } } }],
		});
		await expect(
			new LlamaClient("http://localhost:8080").downloadAndWait("org/model:Q4_K_M", () => undefined),
		).rejects.toThrow("disk full");
	});

	it("completes a download after progress, and reloads the catalog", async () => {
		let polls = 0;
		const { calls } = router({
			catalog: () => {
				polls++;
				return {
					data: [
						polls === 1
							? entry({ value: "downloading", progress: { a: { done: 1024, total: 2048 } } })
							: entry({ value: "unloaded" }),
					],
				};
			},
		});
		const ratios: Array<number | undefined> = [];
		const models = await new LlamaClient("http://localhost:8080").downloadAndWait("org/model:Q4_K_M", (p) =>
			ratios.push(p.ratio),
		);
		expect(models).toEqual([entry({ value: "unloaded" })]);
		expect(ratios).toContain(0.5);
		expect(calls).toContain("GET /models?reload=1");
	});

	it("fails a load whose model exits", async () => {
		router({ catalog: () => ({ data: [entry({ value: "unloaded", failed: true, exit_code: 3 })] }) });
		await expect(
			new LlamaClient("http://localhost:8080").loadAndWait("org/model:Q4_K_M", () => undefined),
		).rejects.toThrow("Model exited with code 3");
	});

	it("stops waiting when cancelled", async () => {
		router({ catalog: () => ({ data: [entry({ value: "downloading" })] }) });
		const controller = new AbortController();
		const waiting = new LlamaClient("http://localhost:8080").downloadAndWait(
			"org/model:Q4_K_M",
			() => undefined,
			controller.signal,
		);
		setTimeout(() => controller.abort(new Error("Cancelled by user")), 100);
		await expect(waiting).rejects.toThrow("Cancelled by user");
	});
});
