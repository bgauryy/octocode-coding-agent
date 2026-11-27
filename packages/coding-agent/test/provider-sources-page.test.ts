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
import type { CustomModelsFile } from "../src/core/provider-sources/models-files.ts";
import { showProviderManager } from "../src/modes/interactive/interactive-mode/provider-manager.ts";
import { fileRow, modelFileRows } from "../src/modes/interactive/interactive-mode/provider-sources-page.ts";
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
/** The whole page: the list scrolls, so every row is read by walking the cursor down. */
const fullText = (page: Page) => {
	for (let step = 0; step < 80; step++) page.handleInput("\x1b[A");
	let all = text(page);
	for (let step = 0; step < 80; step++) {
		page.handleInput("\x1b[B");
		all += `\n${text(page)}`;
	}
	return all;
};

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
			session: { modelRuntime: runtime, settingsManager, sessionManager: { getCwd: () => join(home, "work") } },
			showSelector,
			ui: { terminal: { rows: 40 } },
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
			for (let step = 0; step < 400; step++) {
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
		expect(fullText(list)).toMatch(/Cerebras .*Cerebras API key.*✓ ready/);
		choose(list, "Sources and custom models");
		choose(await open(1), "Pi ");
		choose(await open(2), "Turn off");
		const off = await open(3);
		expect(settingsManager.getProviderSources()).toEqual({ pi: false });
		expect(availableProviders()).not.toContain("cerebras");
		expect(text(off)).toMatch(/Pi .* off/);
		off.handleInput("\x1b");
		const mainOff = await open(4);
		// Without Pi its key is gone: Cerebras is only an available built-in.
		expect(fullText(mainOff)).not.toMatch(/Cerebras .*✓ ready/);
		choose(mainOff, "Sources and custom models");
		choose(await open(5), "Pi ");
		choose(await open(6), "Turn on");
		(await open(7)).handleInput("\x1b");
		const on = await open(8);
		expect(settingsManager.getProviderSources()).toEqual({});
		expect(availableProviders()).toContain("cerebras");
		expect(fullText(on)).toMatch(/Cerebras .*Cerebras API key.*✓ ready/);
		on.handleInput("\x1b");
		await run;
	});
});

describe("models.json file rows", () => {
	const file = (over: Partial<CustomModelsFile>): CustomModelsFile => ({
		origin: "Octocode",
		scope: "global",
		trusted: true,
		path: "/p/models.json",
		exists: true,
		defines: [],
		keyed: [],
		unset: [],
		details: {},
		...over,
	});

	it("says an untrusted project file is not read and names the trust command", () => {
		const row = fileRow(file({ scope: "project", trusted: false, path: "/w/.octocode/models.json" }), 0);
		expect(row.name).toBe("Octocode project models.json");
		expect(row.detail).toContain("not read — trust this folder to use it");
		expect(row.detail).toContain("octocode trust add");
	});

	it("lists a trusted project file with what it defines, and hides a missing project file", () => {
		const trusted = file({
			scope: "project",
			path: "/w/.octocode/models.json",
			defines: ["acme", "openai"],
			shadows: ["openai"],
		});
		const missing = file({ scope: "project", exists: false, origin: "Pi", path: "/w/.pi/models.json" });
		const rows = modelFileRows([trusted, missing, file({})]);
		expect(rows.map((row) => row.name)).toEqual(["Octocode project models.json", "Octocode models.json"]);
		expect(rows[0].detail).toContain("defines acme, openai");
		expect(rows[0].detail).toContain("replaces global: openai");
	});
});
