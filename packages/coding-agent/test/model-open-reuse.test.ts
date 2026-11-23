import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings, type TUI } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/theme/theme.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

/** Opens the `/model` picker and resolves once its catalog refresh has drawn (the second render). */
function open(runtime: ModelRuntime): Promise<void> {
	let renders = 0;
	return new Promise((resolve) => {
		const tui = {
			requestRender: () => {
				if (++renders === 2) resolve();
			},
		} as unknown as TUI;
		new ModelSelectorComponent(
			tui,
			undefined,
			runtime,
			[],
			() => {},
			() => {},
		);
	});
}

const modelsJson = (id: string) =>
	JSON.stringify({
		providers: {
			[id]: { baseUrl: "https://example.test/v1", api: "openai-completions", apiKey: "k", models: [{ id: `${id}-m` }] },
		},
	});

describe("opening /model again", () => {
	it("reuses a recent refresh instead of reloading models.json, and reloads a changed file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "octocode-open-reuse-"));
		dirs.push(dir);
		const modelsPath = join(dir, "models.json");
		writeFileSync(modelsPath, modelsJson("a"));
		const runtime = getModelRuntime(await createModelRegistry(AuthStorage.inMemory(), modelsPath));
		await open(runtime);
		const load = vi.spyOn(ModelConfig, "load");
		await open(runtime);
		expect(load).not.toHaveBeenCalled();
		writeFileSync(modelsPath, modelsJson("b"));
		await open(runtime);
		expect(load).toHaveBeenCalledOnce();
		expect(runtime.getModel("b", "b-m")).toBeDefined();
		runtime.dispose();
	});
});
