import { once } from "node:events";
import { createServer, type IncomingMessage, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../src/core/extensions/loader.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { LlamaClient } from "../../src/octocode/llama/client.ts";
import llamaExtension from "../../src/octocode/llama/index.ts";
import { initTheme } from "../../src/theme/theme.ts";
import { fakeCtx, rendered, theme } from "./fake-host.ts";

const servers: Server[] = [];

async function listen(handler: RequestListener): Promise<string> {
	const server = createServer(handler);
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function body(request: IncomingMessage): Promise<{ model?: string }> {
	let text = "";
	for await (const chunk of request) text += String(chunk);
	return JSON.parse(text || "{}") as { model?: string };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				}),
		),
	);
});

describe("llama.cpp live updates", () => {
	it("stops reading, and says so, when the server never ends an event", async () => {
		let streaming = true;
		let closed = false;
		const url = await listen((request, response) => {
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			request.on("close", () => {
				streaming = false;
				closed = true;
			});
			const pump = (): void => {
				if (!streaming) return;
				// Single newlines only: the event never ends.
				response.write(`data: ${"x".repeat(64 * 1024)}\n`);
				setTimeout(pump, 1);
			};
			pump();
		});
		const controller = new AbortController();
		try {
			const events: unknown[] = [];
			await expect(new LlamaClient(url).watch((event) => events.push(event), controller.signal)).rejects.toThrow(
				"more than 1 MiB without ending an event",
			);
			expect(events).toEqual([]);
			await vi.waitFor(() => expect(closed).toBe(true));
		} finally {
			controller.abort();
			streaming = false;
		}
	});

	it("keeps an event boundary whose CRLF is split between reads", async () => {
		const a = { model: "m", event: "status_change", data: { status: "loading" } };
		const b = { model: "m", event: "status_change", data: { status: "loaded" } };
		const url = await listen(async (_request, response) => {
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.write(`data: ${JSON.stringify(a)}\r\n\r`);
			await pause(50);
			response.write("\n");
			await pause(50);
			response.end(`data: ${JSON.stringify(b)}\r\n\r\n`);
		});
		const events: unknown[] = [];
		await new LlamaClient(url).watch((event) => events.push(event));
		expect(events).toEqual([a, b]);
	});
});

/** Runs /llama against `url` in a fake TUI: `showing` waits for text on screen, `press` sends a key. */
async function openLlama(url: string) {
	initTheme("dark"); // key hints read the global theme
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		llamaExtension,
		process.cwd(),
		createEventBus(),
		runtime,
		"builtin:llama.cpp",
	);
	let view: { render(width: number): string[]; handleInput(data: string): void; focused: boolean } | undefined;
	const tui = { requestRender: () => undefined, terminal: { rows: 40, columns: 100 } };
	const ctx = fakeCtx({
		cwd: process.cwd(),
		mode: "tui",
		ui: {
			custom: (factory: (...args: unknown[]) => unknown) =>
				new Promise((resolve) => {
					view = factory(tui, theme, new KeybindingsManager(), resolve) as typeof view;
					view!.focused = true;
				}),
		},
	});
	Object.assign(ctx, {
		modelRegistry: {
			getProviderAuth: async () => ({ auth: { baseUrl: `${url}/v1` }, env: { LLAMA_BASE_URL: url } }),
			refresh: async () => ({ aborted: false, errors: new Map() }),
		},
	});
	const screen = () => (view ? rendered(view, 100) : "");
	const showing = (text: string) => vi.waitFor(() => expect(screen()).toContain(text), { timeout: 5000, interval: 10 });
	const press = (key: string) => view!.handleInput(key);
	const running = extension.commands.get("llama")!.handler("", ctx);
	return { ctx, screen, showing, press, running };
}

describe("/llama shows server text as plain text", () => {
	it("removes terminal sequences from the server's error message", async () => {
		const url = await listen((_request, response) => {
			const message = "model store \u001b]0;owned\u0007\u001b[2Jbroken";
			response.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message } }));
		});
		const { screen, showing, press, running } = await openLlama(url);
		await showing("llama.cpp unavailable");
		expect(screen()).toContain("model store broken");
		expect(screen()).not.toContain("\u001b]");
		expect(screen()).not.toContain("\u001b[2J");
		press("\x1b[B");
		press("\r"); // Close
		await running;
	});
});

describe("llama.cpp waits without a stop control", () => {
	it("gives up on an unload the server never finishes, with a message /llama shows", async () => {
		const url = await listen((request, response) => {
			response.writeHead(200, { "Content-Type": "application/json" });
			if (request.method === "POST") response.end("{}");
			else response.end(JSON.stringify({ data: [{ id: "m", status: { value: "loaded" } }] }));
		});
		const error = await new LlamaClient(url).unloadAndWait("m", { waitMs: 300 }).then(
			() => undefined,
			(caught: unknown) => caught as Error,
		);
		expect(error?.message).toBe("m is still loaded 1 s after the unload request");
		// /llama hides connection-like errors ("timeout", "network", "fetch failed"); this one must reach the user.
		expect(`${error?.name} ${error?.message}`).not.toMatch(/timeout|network|fetch failed/i);
	});

	it("lets the user stop restoring a model whose load never finishes", async () => {
		const status: Record<string, { value: string; failed?: boolean; exit_code?: number }> = {
			"model-a": { value: "loaded" },
			"model-b": { value: "unloaded" },
		};
		const posts: string[] = [];
		const url = await listen(async (request, response) => {
			const path = request.url ?? "";
			if (path === "/models/sse") return void response.writeHead(404).end();
			if (request.method === "POST") {
				const model = (await body(request)).model ?? "";
				posts.push(`${path} ${model}`);
				if (path === "/models/unload") status[model] = { value: "unloaded" };
				// model-b fails to start; restoring model-a hangs in `loading`.
				if (path === "/models/load") {
					status[model] =
						model === "model-b" ? { value: "unloaded", failed: true, exit_code: 1 } : { value: "loading" };
				}
				return void response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
			}
			const data = Object.entries(status).map(([id, value]) => ({ id, status: value }));
			response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data }));
		});

		const { ctx, showing, press, running } = await openLlama(url);
		await showing("model-b");
		press("\x1b[B");
		press("\r");
		await showing("1 model is loaded");
		press("\r"); // Unload all and load
		await showing("Restoring model");
		press("\x1b");
		await showing("Stop restoring?");
		press("\r"); // Yes
		await showing("Download model");
		press("\x1b");
		await running;

		expect(posts).toEqual([
			"/models/unload model-a",
			"/models/load model-b",
			"/models/load model-a",
			"/models/unload model-a",
		]);
		expect(ctx.ui.notes).toContainEqual({ message: "Model exited with code 1", type: "error" });
	});
});
