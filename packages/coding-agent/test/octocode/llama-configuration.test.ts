import { describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { type LlamaModelInfo, normalizeLlamaServerUrl } from "../../src/octocode/llama/client.ts";
import { createLlamaProvider } from "../../src/octocode/llama/provider.ts";
import { showLlamaUi } from "../../src/octocode/llama/ui.ts";
import { initTheme } from "../../src/theme/theme.ts";
import { fakeCtx, rendered, theme } from "./fake-host.ts";

describe("llama.cpp configuration", () => {
	it("refuses credentials in server URLs without echoing them", () => {
		for (const url of [
			"http://user:pasted-sensitive-value@localhost:8080",
			"http://localhost:8080?api_key=pasted-sensitive-value",
		]) {
			expect(() => normalizeLlamaServerUrl(url)).toThrow(/^Server URL must not carry credentials/);
		}
		expect(() => normalizeLlamaServerUrl("http://pasted-sensitive-value@[invalid")).toThrow(
			/^Server URL must be a valid http or https URL$/,
		);
	});

	it("shows the configured context size when training metadata describes a larger window", async () => {
		initTheme("dark");
		const model: LlamaModelInfo = {
			id: "local-model",
			status: { value: "loaded", args: ["llama-server", "--ctx-size", "4096"] },
			meta: { n_ctx_train: 131072 },
		};
		const controller = createLlamaProvider();
		controller.setCatalog([model], "http://localhost:8080");
		expect(controller.provider.getModels()[0]?.contextWindow).toBe(4096);
		let screen = "";
		const ctx = fakeCtx({
			cwd: process.cwd(),
			mode: "tui",
			ui: {
				custom: (factory: (...args: unknown[]) => unknown) =>
					new Promise((resolve) => {
						const tui = { requestRender: () => undefined, terminal: { rows: 40, columns: 100 } };
						const view = factory(tui, theme, new KeybindingsManager(), resolve) as {
							render(width: number): string[];
							handleInput(data: string): void;
						};
						screen = rendered(view, 100);
						view.handleInput("\x1b");
					}),
			},
		});
		await showLlamaUi(ctx, async (ui) => {
			expect(await ui.showModels("http://localhost:8080", [model])).toEqual({ type: "close" });
		});
		expect(screen).toContain("4k context");
		expect(screen).not.toContain("131k context");
	});
});
