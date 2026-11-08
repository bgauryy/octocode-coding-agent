import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { InMemoryModelsStore } from "@octocodeai/octocode-ai";
import { GLYPH, setKeybindings } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { providerSourceGate } from "../src/core/provider-sources/index.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { showProviderManager } from "../src/modes/interactive/interactive-mode/provider-manager.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

type Page = { render(width: number): string[]; handleInput(data: string): void };

let home: string;
function write(file: string, content: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

beforeAll(() => initTheme("dark"));
beforeEach(() => {
	setKeybindings(new KeybindingsManager());
	home = mkdtempSync(join(tmpdir(), "providers-sources-page-"));
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	vi.stubEnv("OCTOCODE_HOME", "");
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", "");
	vi.stubEnv("COPILOT_GITHUB_TOKEN", "");
	providerSourceGate.set({});
});
afterEach(() => {
	providerSourceGate.set({});
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

const text = (page: Page) => stripAnsi(page.render(160).join("\n"));

describe("/providers source toggle", () => {
	it("Pi off hides a Pi-only provider from the list and the ModelRegistry; on restores it", async () => {
		write(join(home, ".pi", "agent", "auth.json"), JSON.stringify({ cerebras: { type: "api_key", key: "pi-key" } }));
		const agentDir = join(home, ".octocode", "octocodecode");
		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
		});
		const registry = new ModelRegistry(runtime);
		const settingsManager = SettingsManager.inMemory();
		const availableProviders = () => new Set(registry.getAvailable().map((model) => model.provider));
		expect(availableProviders()).toContain("cerebras");

		const pages: Page[] = [];
		const showSelector = vi.fn((create: (done: () => void) => { component: unknown }) => {
			pages.push(create(vi.fn()).component as Page);
		});
		const host = createFakeHost({
			session: { modelRuntime: runtime, settingsManager },
			showSelector,
			showStatus: vi.fn(),
			showError: vi.fn(),
			showWarning: vi.fn(),
			updateAvailableProviderCount: vi.fn(),
			getLoginProviderOptions: () => [],
		});
		const environment = { home, env: {}, agentDir };
		const open = async (index: number) => {
			await vi.waitFor(() => expect(pages.length).toBeGreaterThan(index));
			return pages[index];
		};
		const choose = (page: Page, label: string) => {
			for (let step = 0; step < 40; step++) {
				const selected =
					text(page)
						.split("\n")
						.find((line) => line.includes(`${GLYPH.cursor} `)) ?? "";
				if (selected.includes(label)) return page.handleInput("\r");
				page.handleInput("\x1b[B");
			}
			throw new Error(`no row ${label}`);
		};

		const run = showProviderManager(host, "", { sourceEnvironment: environment });
		const list = await open(0);
		expect(text(list)).toMatch(/Cerebras .*enabled/);
		choose(list, "Pi ");
		choose(await open(1), "Turn off");
		const off = await open(2);
		expect(settingsManager.getProviderSources()).toEqual({ pi: false });
		expect(availableProviders()).not.toContain("cerebras");
		expect(text(off)).not.toMatch(/Cerebras/);
		expect(text(off)).toMatch(/Pi .* off/);

		choose(off, "Pi ");
		choose(await open(3), "Turn on");
		const on = await open(4);
		expect(settingsManager.getProviderSources()).toEqual({});
		expect(availableProviders()).toContain("cerebras");
		expect(text(on)).toMatch(/Cerebras .*enabled/);
		on.handleInput("\x1b");
		await run;
	});
});
