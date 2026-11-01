import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import llamaExtension from "../src/octocode/llama/index.ts";
import { LLAMA_PROVIDER_ID } from "../src/octocode/llama/provider.ts";
import * as llamaUi from "../src/octocode/llama/ui.ts";
import { initTheme } from "../src/theme/theme.ts";
import { createSlotHost, PENDING, settled, type SlotHost } from "./interactive-slot-host.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const DOWN = "\x1b[B";

beforeAll(() => initTheme("dark"));

/** `/llama` in the terminal when something else takes the editor slot. */
describe("the /llama view displaced by another dialog, selector or the reset", () => {
	const servers: Server[] = [];
	const harnesses: Harness[] = [];
	const hosts: SlotHost[] = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const env of hosts.splice(0)) env.ui.stop();
		for (const harness of harnesses.splice(0)) harness.cleanup();
		await Promise.all(
			servers.splice(0).map((server) => {
				server.closeAllConnections();
				return new Promise<void>((resolve) => server.close(() => resolve()));
			}),
		);
	});

	/** A llama.cpp router with one model, and a session whose `/llama` opens in `env`'s editor slot. */
	async function openLlama() {
		const router = { status: "unloaded", requests: [] as string[], events: new Set<ServerResponse>() };
		const server = createServer((request, response) => {
			router.requests.push(`${request.method} ${request.url}`);
			if (request.url === "/models/sse") {
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				router.events.add(response);
				request.on("close", () => router.events.delete(response));
				return;
			}
			if (request.url === "/models/load") router.status = "loading";
			response.writeHead(request.url?.startsWith("/models") ? 200 : 404, { "Content-Type": "application/json" });
			const models = { data: [{ id: "tiny-model", status: { value: router.status } }] };
			response.end(JSON.stringify(request.url === "/models" ? models : { success: true }));
		});
		servers.push(server);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

		const env = createSlotHost();
		hosts.push(env);
		const harness = await createHarness({
			extensionFactories: [
				(api) =>
					llamaExtension({
						...api,
						registerCommand: (name, definition) =>
							api.registerCommand(name, {
								...definition,
								handler: (args, ctx) => definition.handler(args, { ...ctx, mode: "tui" }),
							}),
					}),
			],
		});
		harnesses.push(harness);
		await harness.authStorage.modify(LLAMA_PROVIDER_ID, async () => ({
			type: "api_key",
			key: "local",
			env: { LLAMA_BASE_URL: url },
		}));
		await harness.session.bindExtensions({ uiContext: createTestUiContext({ custom: env.custom }) });

		const show = llamaUi.showLlamaUi;
		let run: Promise<void> | undefined;
		vi.spyOn(llamaUi, "showLlamaUi").mockImplementation((ctx, manage) =>
			show(ctx, (ui) => {
				run = manage(ui);
				return run;
			}),
		);
		const command = harness.session.prompt("/llama");
		await vi.waitFor(async () => expect(await env.screen()).toContain("tiny-model"));
		expect(run).toBeDefined();
		return { env, command, run: run!, router };
	}

	async function expectEnded(opened: Awaited<ReturnType<typeof openLlama>>) {
		await opened.command;
		expect(await settled(opened.run, 2000)).toBeUndefined();
	}

	it("an extension dialog taking the slot from the models list ends the run", async () => {
		const opened = await openLlama();
		const answer = opened.env.host.showExtensionSelector("Extension question", ["yes", "no"]);
		expect(await opened.env.screen()).toContain("Extension question");
		await expectEnded(opened);
		expect(await settled(answer)).toBe(PENDING);
		opened.env.host.hideExtensionSelector();
		expect(await settled(answer)).toBeUndefined();
		expect(opened.env.editorContainer.children).toEqual([opened.env.editor]);
	});

	it("a built-in selector taking the slot from the download search ends the run", async () => {
		const opened = await openLlama();
		// The second entry opens the Hugging Face search, which waits for typed input.
		opened.env.terminal.sendInput(DOWN);
		opened.env.terminal.sendInput("\r");
		await vi.waitFor(async () => expect(await opened.env.screen()).toContain("Download model"));
		const selector = { render: () => ["built-in selector"], invalidate: () => {} };
		opened.env.host.showSelector(() => ({ component: selector, focus: selector, dispose: vi.fn() }));
		expect(await opened.env.screen()).toContain("built-in selector");
		await expectEnded(opened);
	});

	it("a dialog taking the slot during a load leaves the load running; the run ends when it completes", async () => {
		const opened = await openLlama();
		opened.env.terminal.sendInput("\r");
		await vi.waitFor(async () => expect(await opened.env.screen()).toContain("Loading model"));
		opened.env.host.showExtensionSelector("Extension question", ["yes", "no"]);
		expect(await opened.env.screen()).toContain("Extension question");
		await opened.command;
		// Displacement is not a request to stop: the load is neither cancelled nor unloaded.
		expect(await settled(opened.run, 200)).toBe(PENDING);
		const renders = vi.spyOn(opened.env.ui, "requestRender");
		opened.router.status = "loaded";
		for (const stream of opened.router.events) {
			stream.write(
				`data: ${JSON.stringify({ model: "tiny-model", event: "status_change", data: { status: "loaded" } })}\n\n`,
			);
		}
		await expectEnded(opened);
		expect(opened.router.requests).not.toContain("POST /models/unload");
		expect(renders).not.toHaveBeenCalled();
		expect(await opened.env.screen()).toContain("Extension question");
	});

	it("the reset on reload or session replacement ends the run", async () => {
		const opened = await openLlama();
		opened.env.host.resetExtensionUI();
		await expectEnded(opened);
		expect(await opened.env.screen()).not.toContain("tiny-model");
	});
});
