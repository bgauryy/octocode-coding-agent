import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LlamaClient } from "../../src/octocode/llama/client.ts";

afterEach(() => vi.unstubAllGlobals());

const client = () => new LlamaClient("http://127.0.0.1:8080");

describe("llama.cpp live update resource ownership", () => {
	it("releases the response reader after EOF", async () => {
		const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body)),
		);
		await client().watch(() => {});
		expect(body.locked).toBe(false);
	});

	it.each([false, true])("cancels a stalled body with pending cancellation %s", async (pendingCancellation) => {
		const cancel = vi.fn(() => (pendingCancellation ? new Promise<void>(() => {}) : undefined));
		let source!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				source = controller;
			},
			cancel,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body)),
		);
		const controller = new AbortController();
		const watch = client()
			.watch(() => {}, controller.signal)
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		await vi.waitFor(() => expect(body.locked).toBe(true));
		controller.abort(new Error("user stopped the model"));
		const outcome = await Promise.race([watch, setImmediate("still reading")]);
		if (outcome === "still reading") source.error(new Error("test cleanup"));
		await watch;
		expect(outcome).toMatchObject({ message: "user stopped the model" });
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
	});

	it("bounds a completed oversized event before parsing it", async () => {
		const event = { model: "model", event: "status_change", padding: "x".repeat(1024 * 1024) };
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
				controller.close();
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body)),
		);
		const onEvent = vi.fn();
		await expect(client().watch(onEvent)).rejects.toThrow("more than 1 MiB");
		expect(onEvent).not.toHaveBeenCalled();
		expect(body.locked).toBe(false);
	});

	it("cancels an unsuccessful streaming response without locking it", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({ cancel });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 503 })),
		);
		await expect(client().watch(() => {})).rejects.toThrow("HTTP 503");
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
	});
});
