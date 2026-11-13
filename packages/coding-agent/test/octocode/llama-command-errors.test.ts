import { createEventBus } from "@octocodeai/octocode-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import llamaExtension from "../../src/octocode/llama/index.ts";
import * as llamaUi from "../../src/octocode/llama/ui.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../helpers/features.ts";
import { fakeCtx } from "./fake-host.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("/llama action failures", () => {
	it.each([false, true])(
		"reports an action network failure unless catalog retry already showed it (%s)",
		async (retryCatalog) => {
			const model = { id: "local-model", status: { value: "unloaded" as const } };
			let loadFailed = false;
			let catalogFailureShown = false;
			vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
				const url = new URL(input);
				if (url.pathname === "/models/sse") return new Response("");
				if (init?.method === "POST") {
					loadFailed = true;
					throw new TypeError("fetch failed");
				}
				if (retryCatalog && loadFailed && !catalogFailureShown) {
					catalogFailureShown = true;
					throw new TypeError("fetch failed");
				}
				return Response.json({ data: [model] });
			});
			const ui = {
				showModels: vi
					.fn<NonNullable<llamaUi.LlamaUi["showModels"]>>()
					.mockResolvedValueOnce({ type: "model", model })
					.mockResolvedValue({ type: "close" }),
				select: vi.fn(async () => undefined),
				confirm: vi.fn(async () => false),
				connectionError: vi.fn(async () => "retry" as const),
				searchModels: vi.fn(async () => undefined),
				showStatus: vi.fn(),
				progress: vi.fn(() => new Promise<void>(() => {})),
				updateProgress: vi.fn(),
			} satisfies llamaUi.LlamaUi;
			vi.spyOn(llamaUi, "showLlamaUi").mockImplementation(async (_ctx, run) => run(ui));
			const extension = await loadExtensionFromFactory(
				llamaExtension,
				process.cwd(),
				createEventBus(),
				createExtensionRuntime(),
				"builtin:llama.cpp",
			);
			const ctx = fakeCtx({ cwd: process.cwd(), mode: "tui" });
			Object.assign(ctx, {
				modelRegistry: {
					getProviderAuth: async () => ({
						auth: { apiKey: "local" },
						env: { LLAMA_BASE_URL: "http://localhost:8080" },
					}),
					refresh: async () => ({ aborted: false, errors: new Map() }),
				},
			});
			await extension.commands.get("llama")!.handler("", ctx);
			expect(loadFailed).toBe(true);
			expect(ui.connectionError).toHaveBeenCalledTimes(retryCatalog ? 1 : 0);
			expect(ctx.ui.notes.filter((note) => note.type === "error")).toEqual(
				retryCatalog ? [] : [{ type: "error", message: "fetch failed" }],
			);
		},
	);
});
